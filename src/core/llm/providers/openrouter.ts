import OpenAI from "openai";
import type { LLMClient, LLMMessage, LLMResponse, ToolDefinition, StreamCallback } from "../types.js";
import { createProxyFetch } from "../proxy.js";

/** Address used when the config names no other OpenAI-compatible endpoint. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  /** OpenAI-compatible endpoint; defaults to OpenRouter. */
  baseURL?: string;
  /** Proxy address (`http://…` or `socks5://…`); absent means direct. */
  proxy?: string;
  /** Seam for tests; production builds its fetch from `proxy`. */
  fetchImpl?: typeof fetch;
}

/** Resolve the endpoint address: blank falls back to OpenRouter, and trailing
 *  slashes are dropped so joining a path never yields "//". */
export function normalizeBaseUrl(baseURL?: string): string {
  const trimmed = baseURL?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : OPENROUTER_BASE_URL;
}

/** Whether the endpoint is OpenRouter itself. Its account/key endpoints exist
 *  nowhere else, so they may only be called when this holds. */
export function isOpenRouterBaseUrl(baseURL?: string): boolean {
  return normalizeBaseUrl(baseURL) === OPENROUTER_BASE_URL;
}

/** Convert our LLMMessage[] to OpenAI format. */
function toOpenAIMessages(messages: LLMMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        tool_call_id: m.toolCallId!,
        content: typeof m.content === "string"
          ? m.content
          : m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n"),
      };
    }

    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant" as const,
        content: typeof m.content === "string" ? m.content : null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }

    // Multimodal content (text + images) — pass array as-is
    return {
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    } as OpenAI.ChatCompletionMessageParam;
  });
}

/** Parse finish_reason + tool_calls into our LLMResponse. */
function buildResponse(
  content: string,
  finishReason: string | null,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  usage?: { prompt_tokens: number; completion_tokens: number },
): LLMResponse {
  const stopReason =
    finishReason === "tool_calls" ? "tool_use"
    : finishReason === "stop" ? "end_turn"
    : "end_turn";

  return {
    text: content,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    stopReason: toolCalls?.length ? "tool_use" : stopReason,
    usage: usage
      ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
      : undefined,
  };
}

const BILLING_KEYWORDS = ["insufficient_quota", "credits", "billing", "payment", "exceeded your current quota"];

/** Check if an error indicates the account balance is exhausted. */
export function isBillingError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status === 402) return true;
  // 429, 400, 403 with billing-related message
  if (err.status === 429 || err.status === 400 || err.status === 403) {
    const msg = (err.message ?? "").toLowerCase();
    return BILLING_KEYWORDS.some((kw) => msg.includes(kw));
  }
  return false;
}

/** Check if an error is a rate limit, transient, or model-not-found (treat as "try next model"). */
export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status === 404) return true; // dead model
  if (err.status === 429 && !isBillingError(err)) return true;
  if (err.status === 408 || err.status === 502 || err.status === 503 || err.status === 504) return true; // transient provider errors
  if (err.status === 400 && /provider returned error/i.test(err.message ?? "")) return true; // upstream provider error
  return false;
}

export interface BalanceInfo {
  hasBalance: boolean;
  usage: number;
  limit: number;
}

/**
 * Check OpenRouter account balance via API.
 *
 * Returns null — without any request — when the configured endpoint is not
 * OpenRouter: `/auth/key` is OpenRouter's own, and another OpenAI-compatible
 * aggregator would answer it with a 404 at best.
 *
 * The key travels in the Authorization header, never the URL, and only the
 * status code leaves this function: fetch bakes the whole URL into its own
 * error messages.
 */
export async function checkBalance(
  apiKey: string,
  baseURL?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BalanceInfo | null> {
  if (!isOpenRouterBaseUrl(baseURL)) return null;

  const res = await fetchImpl(`${OPENROUTER_BASE_URL}/auth/key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Balance check failed: ${res.status}`);
  const data = (await res.json()) as { data?: { usage?: number; limit?: number | null } };
  const usage = data.data?.usage ?? 0;
  const limit = data.data?.limit ?? null;
  return {
    hasBalance: limit === null || (limit > 0 && usage < limit),
    usage,
    limit: limit ?? 0,
  };
}

export function createOpenRouterClient(opts: OpenRouterOptions): LLMClient {
  const fetchImpl = opts.fetchImpl ?? createProxyFetch(opts.proxy);
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: normalizeBaseUrl(opts.baseURL),
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/Aimagine-life/betsy",
      "X-Title": "Betsy",
    },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  return {
    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
      const res = await client.chat.completions.create({
        model: opts.model,
        messages: toOpenAIMessages(messages),
        ...(tools?.length ? { tools } : {}),
      });

      const choice = res.choices[0];
      const message = choice?.message;

      const toolCalls = message?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
      }));

      return buildResponse(
        message?.content ?? "",
        choice?.finish_reason ?? null,
        toolCalls,
        res.usage ? { prompt_tokens: res.usage.prompt_tokens, completion_tokens: res.usage.completion_tokens } : undefined,
      );
    },

    async chatStream(messages: LLMMessage[], onChunk: StreamCallback, tools?: ToolDefinition[]): Promise<LLMResponse> {
      const stream = await client.chat.completions.create({
        model: opts.model,
        messages: toOpenAIMessages(messages),
        ...(tools?.length ? { tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
      });

      let text = "";
      let finishReason: string | null = null;
      let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
      // Accumulate tool calls from stream deltas
      const toolCallMap = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Text content
        if (delta.content) {
          text += delta.content;
          onChunk(delta.content);
        }

        // Tool calls (streamed as deltas with index)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
            }
            const entry = toolCallMap.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        if (chunk.usage) {
          usage = { prompt_tokens: chunk.usage.prompt_tokens, completion_tokens: chunk.usage.completion_tokens };
        }
      }

      const toolCalls = toolCallMap.size > 0
        ? [...toolCallMap.values()].map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: JSON.parse(tc.args || "{}") as Record<string, unknown>,
          }))
        : undefined;

      return buildResponse(text, finishReason, toolCalls, usage);
    },
  };
}
