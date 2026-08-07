import type { IncomingMessage, OutgoingMessage, ProgressCallback } from "./types.js";
import type { LLMClient, LLMMessage, ContentPart, ToolDefinition } from "./llm/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { ToolResult } from "./tools/types.js";
import { buildSystemPrompt, type PromptConfig } from "./prompt.js";
import { type AccessLevel, filterTools, isToolAllowed } from "./access.js";
import { searchKnowledge } from "./memory/knowledge.js";
import { saveMessage, loadHistory, extractText } from "./memory/conversations.js";
import { compactHistory } from "./memory/compaction.js";
import { LLMUnavailableError } from "./llm/router.js";
import { TokenStore } from "../services/tokens.js";
import { getService } from "../services/catalog.js";
import { SkillsStore } from "../services/skills-store.js";

function historyChars(history: LLMMessage[]): number {
  let total = 0;
  for (const m of history) {
    if (typeof m.content === "string") {
      total += m.content.length;
    } else {
      for (const p of m.content) {
        if (p.type === "text") total += p.text.length;
      }
    }
  }
  return total;
}

const MAX_TURNS = 20;
const MAX_HISTORY = 40;
export const MAX_PROMPT_TOKENS = 128_000;
export const MAX_SAME_TOOL = 5;
const PROCESS_TIMEOUT = 600_000; // 10 minutes — soft budget, triggers graceful wrap-up
const MAX_TOOL_OUTPUT_CHARS = 8_000; // Truncate tool outputs to prevent history bloat

export interface EngineDeps {
  llm: { fast(): LLMClient; strong(): LLMClient };
  config: PromptConfig;
  tools: ToolRegistry;
  contextBudget: number;
  encryptionKey?: string;
}

export class Engine {
  private deps: EngineDeps;
  private histories: Map<string, LLMMessage[]> = new Map();
  private summaries: Map<string, string> = new Map();
  private compactionInFlight: Map<string, Promise<void>> = new Map();

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  private hydrateUser(userId: string): void {
    if (this.histories.has(userId)) return;
    const { messages, summary } = loadHistory(userId);
    this.histories.set(userId, messages);
    if (summary) this.summaries.set(userId, summary);
  }

  /** Get conversation history for a user (for scheduler context). */
  clearHistory(userId: string): void {
    this.histories.delete(userId);
    this.summaries.delete(userId);
  }

  getHistory(userId: string): Array<{ role: string; content: string }> {
    this.hydrateUser(userId);
    const history = this.histories.get(userId);
    if (!history) return [];
    return history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role,
        content: typeof m.content === "string"
          ? m.content
          : m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n"),
      }));
  }

  async process(msg: IncomingMessage, onProgress?: ProgressCallback, access: AccessLevel = "restricted"): Promise<OutgoingMessage> {
    const llm = this.deps.llm.fast();
    const userId = msg.userId;
    // Address for out-of-band deliveries a tool triggers later (scheduler
    // fire, connect_service's OAuth callback) — separate from `userId` so a
    // group chat still gets the reply even though history is keyed by the
    // sender. Falls back to userId for channels with no group/sender split.
    const chatId = msg.chatId ?? userId;

    // Wait for any in-flight compaction to finish before proceeding
    const pending = this.compactionInFlight.get(userId);
    if (pending) {
      await pending;
    }

    // Get or create history for this user
    if (!this.histories.has(userId)) {
      this.hydrateUser(userId);
    }
    let history = this.histories.get(userId)!;

    // Hard truncation: if history is still too large after compaction, keep only recent messages
    if (history.length > MAX_HISTORY * 2) {
      console.log(JSON.stringify({ tag: "engine:hard_truncate", userId, before: history.length, kept: MAX_HISTORY }));
      history = history.slice(-MAX_HISTORY);
      this.histories.set(userId, history);
    };

    // Build system prompt with memory context
    let systemPrompt = this.buildPromptWithMemory(msg.text, userId, access);

    // Add user message (with reply context and/or images if present)
    const replyTo = msg.metadata?.replyToText as string | undefined;
    const textContent = replyTo
      ? `[В ответ на сообщение: "${replyTo}"]\n\n${msg.text}`
      : msg.text;

    if (msg.images?.length) {
      const parts: ContentPart[] = [
        { type: "text", text: textContent },
        ...msg.images.map((b64): ContentPart => ({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${b64}` },
        })),
      ];
      history.push({ role: "user", content: parts });
    } else {
      history.push({ role: "user", content: textContent });
    }

    saveMessage(userId, msg.channelName, "user", textContent);

    // Build tool definitions for the LLM — filtered by access so a restricted
    // caller never even sees shell/files/ssh in the request to the model.
    const tools = this.buildToolDefinitions(access);

    try {
      let lastMediaUrl: string | undefined;
      let lastMediaPath: string | undefined;
      const toolCallCounts = new Map<string, number>();
      let compactionAttempted = false;
      const processStart = Date.now();

      // Agentic loop: LLM → tool calls → execute → repeat
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        // Soft time budget — give LLM one final chance to summarize (no tools)
        if (Date.now() - processStart > PROCESS_TIMEOUT) {
          console.log(JSON.stringify({ tag: "engine:limit", reason: "timeout", elapsedMs: Date.now() - processStart }));
          history.push({ role: "user", content: "Времени мало. Ответь на основе того, что уже удалось сделать. Не вызывай инструменты." });
          const finalMessages: LLMMessage[] = [
            { role: "system", content: systemPrompt },
            ...history,
          ];
          const finalResponse = await llm.chat(finalMessages);
          const text = finalResponse.text || "Не удалось завершить задачу полностью, но вот что получилось.";
          history.push({ role: "assistant", content: text });
          saveMessage(userId, msg.channelName, "assistant", text);
          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath };
        }

        onProgress?.({ type: "thinking" });

        const messages: LLMMessage[] = [
          { role: "system", content: systemPrompt },
          ...history,
        ];

        // Use streaming for text responses, non-streaming for tool calls
        const streamChunk = onProgress
          ? (chunk: string) => onProgress({ type: "text_chunk", chunk })
          : undefined;

        const histSize = historyChars(history);
        const llmStart = Date.now();
        const response = streamChunk
          ? await llm.chatStream(messages, streamChunk, tools.length ? tools : undefined)
          : await llm.chat(messages, tools.length ? tools : undefined);
        const llmMs = Date.now() - llmStart;

        console.log(JSON.stringify({
          tag: "engine",
          turn: turn + 1,
          llmMs,
          promptTokens: response.usage?.promptTokens,
          completionTokens: response.usage?.completionTokens,
          historyMessages: history.length,
          historyChars: histSize,
          reasoning: response.text?.slice(0, 200),
          stopReason: response.stopReason,
          toolCalls: response.toolCalls?.map(t => t.name),
        }));

        // Check 1: Token budget — if context is too large, stop the loop
        if (response.usage && response.usage.promptTokens > MAX_PROMPT_TOKENS) {
          const text = response.text || "Достигнут лимит контекста. Вот что удалось найти.";
          history.push({ role: "assistant", content: text });
          saveMessage(userId, msg.channelName, "assistant", text);
          console.log(JSON.stringify({
            tag: "engine:limit",
            reason: "token_budget",
            promptTokens: response.usage.promptTokens,
          }));
          // Trigger compaction so the next message doesn't fail with context-too-long
          this.startCompaction(userId);
          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath };
        }

        // If LLM didn't request tools, return the text response
        if (response.stopReason !== "tool_use" || !response.toolCalls?.length) {
          const text = response.text || "...";
          history.push({ role: "assistant", content: text });
          saveMessage(userId, msg.channelName, "assistant", text);

          // Background compaction for terminal turns
          if (response.usage && response.usage.promptTokens > this.deps.contextBudget) {
            this.startCompaction(userId);
          }

          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath };
        }

        // Compaction check for tool-use turns — BEFORE saving assistant tool-call
        if (!compactionAttempted && response.usage && response.usage.promptTokens > this.deps.contextBudget) {
          compactionAttempted = true;
          turn--;
          try {
            await compactHistory(userId, this.deps.llm.fast());
          } catch (err) {
            console.error("Compaction failed:", err);
          }
          const { messages: m, summary: s } = loadHistory(userId);
          this.histories.set(userId, m);
          history = m;
          if (s) this.summaries.set(userId, s);
          systemPrompt = this.buildPromptWithMemory(msg.text, userId, access);
          continue;
        }

        // Add assistant message with tool calls to history (MOVED from before compaction check)
        history.push({
          role: "assistant",
          content: response.text || "",
          toolCalls: response.toolCalls,
        });
        saveMessage(userId, msg.channelName, "assistant", response.text || "", undefined, response.toolCalls);

        // Execute each tool and add results to history
        for (const tc of response.toolCalls) {
          onProgress?.({ type: "tool_start", tool: tc.name, turn: turn + 1 });

          const toolStart = Date.now();
          const result = await this.executeTool(tc.name, tc.arguments, access, userId, msg.channelName, chatId);
          const toolMs = Date.now() - toolStart;

          let resultText = result.success
            ? result.output
            : `Error: ${result.error || result.output}`;

          if (resultText.length > MAX_TOOL_OUTPUT_CHARS) {
            resultText = resultText.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n\n[обрезано: ${resultText.length} символов → ${MAX_TOOL_OUTPUT_CHARS}]`;
          }

          console.log(JSON.stringify({
            tag: "engine:tool",
            turn: turn + 1,
            tool: tc.name,
            params: tc.arguments,
            success: result.success,
            outputChars: resultText.length,
            toolMs,
          }));

          if (result.mediaUrl) {
            lastMediaUrl = result.mediaUrl;
          }
          if (result.mediaPath) {
            lastMediaPath = result.mediaPath;
          }

          history.push({
            role: "tool",
            content: resultText,
            toolCallId: tc.id,
          });
          saveMessage(userId, msg.channelName, "tool", resultText, tc.id);

          onProgress?.({ type: "tool_end", tool: tc.name, turn: turn + 1, success: result.success });
        }

        // Increment tool counts for this cycle
        for (const tc of response.toolCalls) {
          toolCallCounts.set(tc.name, (toolCallCounts.get(tc.name) ?? 0) + 1);
        }

        // Check 2: Per-tool limit (scoped to current process() call only)
        const overused = [...toolCallCounts.entries()].find(([, count]) => count > MAX_SAME_TOOL);
        if (overused) {
          console.log(JSON.stringify({
            tag: "engine:limit",
            reason: "tool_limit",
            tool: overused[0],
            count: overused[1],
          }));
          // Give LLM one final chance to summarize what it found (no tools)
          history.push({ role: "user", content: `Лимит использования инструмента "${overused[0]}" достигнут. Ответь на основе уже полученной информации.` });
          const finalMessages: LLMMessage[] = [
            { role: "system", content: systemPrompt },
            ...history,
          ];
          const finalResponse = await llm.chat(finalMessages);
          const text = finalResponse.text || `Инструмент "${overused[0]}" использован ${overused[1]} раз, но не удалось сформировать ответ.`;
          history.push({ role: "assistant", content: text });
          saveMessage(userId, msg.channelName, "assistant", text);
          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath };
        }

        onProgress?.({ type: "turn_complete", turn: turn + 1, totalTurns: MAX_TURNS });
      }

      // Max turns exceeded — give LLM final chance to summarize
      console.log(JSON.stringify({ tag: "engine:limit", reason: "max_turns" }));
      history.push({ role: "user", content: "Лимит шагов достигнут. Ответь на основе того, что уже удалось сделать." });
      const wrapMessages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        ...history,
      ];
      const wrapResponse = await llm.chat(wrapMessages);
      const text = wrapResponse.text || "Вот что удалось сделать.";
      history.push({ role: "assistant", content: text });
      saveMessage(userId, msg.channelName, "assistant", text);
      return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Engine error:", errorMsg);

      // Try to let LLM explain what happened naturally
      try {
        const errorContext = errorMsg.includes("timed out") ? "запрос к языковой модели завис — слишком долго думала"
          : errorMsg.includes("billing") || errorMsg.includes("402") ? "закончились кредиты на API языковой модели"
          : errorMsg.includes("rate") || errorMsg.includes("429") ? "слишком много запросов, API временно ограничил доступ"
          : errorMsg.includes("503") || errorMsg.includes("502") ? "сервер языковой модели временно недоступен"
          : `техническая проблема: ${errorMsg}`;

        history.push({ role: "user", content: `[Системное сообщение: произошла ошибка — ${errorContext}. Объясни пользователю своими словами что случилось, извинись и предложи попробовать ещё раз. Не используй технические термины. Будь краткой.]` });

        const recoveryMessages: LLMMessage[] = [
          { role: "system", content: systemPrompt },
          ...history,
        ];
        const recoveryResponse = await llm.chat(recoveryMessages);
        const text = recoveryResponse.text || "Прости, что-то у меня зависло. Повтори, пожалуйста!";
        history.push({ role: "assistant", content: text });
        saveMessage(userId, msg.channelName, "assistant", text);
        return { text };
      } catch {
        // If even the recovery LLM call fails, use a simple message
        const text = "Прости, что-то у меня зависло. Повтори, пожалуйста!";
        history.push({ role: "assistant", content: text });
        saveMessage(userId, msg.channelName, "assistant", text);
        return { text };
      }
    }
  }

  /** Build system prompt and inject relevant memory context. */
  private buildPromptWithMemory(userMessage: string, chatId: string, access: AccessLevel): string {
    let connectedServiceNames: string[] = [];
    if (this.deps.encryptionKey) {
      try {
        const tokenStore = new TokenStore(this.deps.encryptionKey);
        const tokens = tokenStore.listConnected(chatId);
        connectedServiceNames = tokens.map(t => {
          const svc = getService(t.serviceId);
          return svc ? `${svc.name} (${t.scopes})` : t.serviceId;
        });
      } catch {}
    }

    let prompt = buildSystemPrompt(this.deps.config, userMessage, chatId, connectedServiceNames, access);

    // Search knowledge base for context relevant to the user's message.
    // Owner-only: this is the owner's personal memory and must not leak
    // into a conversation with someone else.
    if (access === "owner") {
      try {
        const hits = searchKnowledge(userMessage, 5);
        if (hits.length > 0) {
          const memoryContext = hits
            .map((h, i) => `${i + 1}. [${h.topic}] ${h.insight}`)
            .join("\n");
          prompt += `\n\n## Релевантные знания из памяти\n\n${memoryContext}`;
        }
      } catch {
        // Memory not initialized yet — skip
      }
    }

    // Inject installed skills context. Owner-only: the skills store is a
    // single shared table (same shape as the knowledge base above) — a
    // skill's name/description can reveal what the owner privately taught
    // Ava, so a restricted conversation must not see it either.
    if (access === "owner") {
      try {
        const skillsStore = new SkillsStore();
        const allSkills = skillsStore.listAll();
        if (allSkills.length > 0) {
          const skillContext = allSkills
            .slice(0, 3)
            .map((s, i) => `${i + 1}. [${s.name}] ${s.description}`)
            .join("\n");
          prompt += `\n\n## Установленные скиллы\n\n${skillContext}\n\nЧтобы использовать скилл, вспомни его содержимое из памяти.`;
        }
      } catch {}
    }

    const summary = this.summaries.get(chatId);
    if (summary) {
      prompt += `\n\n## Краткое содержание предыдущего разговора\n\n${summary}`;
    }

    return prompt;
  }

  /** Start background compaction for a user (deduplicates concurrent calls). */
  private startCompaction(userId: string): void {
    if (this.compactionInFlight.has(userId)) return;
    const promise = compactHistory(userId, this.deps.llm.fast())
      .then(() => {
        const { messages: m, summary: s } = loadHistory(userId);
        this.histories.set(userId, m);
        if (s) this.summaries.set(userId, s);
      })
      .catch(err => console.error("Compaction failed:", err))
      .finally(() => this.compactionInFlight.delete(userId));
    this.compactionInFlight.set(userId, promise);
  }

  /** Execute a single tool by name. Returns full ToolResult. */
  private async executeTool(name: string, args: Record<string, unknown>, access: AccessLevel, userId?: string, channelName?: string, chatId?: string): Promise<ToolResult> {
    // Checked again here, not just at the point where tools are shown to the
    // model: the model can call a tool it was never offered — from memory,
    // stale context, or a hint from the person it's talking to. The list we
    // send with the request is not the enforcement boundary; this is.
    if (!isToolAllowed(name, access)) {
      return { success: false, output: "", error: "Этот инструмент мне здесь недоступен." };
    }

    const tool = this.deps.tools.get(name);
    if (!tool) {
      return { success: false, output: "", error: `unknown tool "${name}"` };
    }

    try {
      let params = args;
      if (userId) params = { ...params, _userId: userId };
      // Lets tools that trigger later, out-of-band delivery (e.g. connect_service's
      // OAuth polling callback) remember which channel the request came from,
      // instead of guessing or broadcasting to every channel.
      if (channelName) params = { ...params, _channelName: channelName };
      // Same reasoning as _channelName: connect_service's OAuth callback
      // fires long after this turn ends and needs the chat to reply into,
      // not just the sender who happened to trigger the connect.
      if (chatId) params = { ...params, _chatId: chatId };
      return await tool.execute(params);
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Convert our ToolParam[] format to OpenAI function-calling ToolDefinition[], filtered by access. */
  private buildToolDefinitions(access: AccessLevel): ToolDefinition[] {
    return filterTools(this.deps.tools.list(), access).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object" as const,
          properties: Object.fromEntries(
            tool.parameters.map((p) => [
              p.name,
              { type: p.type, description: p.description },
            ]),
          ),
          required: tool.parameters
            .filter((p) => p.required)
            .map((p) => p.name),
        },
      },
    }));
  }
}
