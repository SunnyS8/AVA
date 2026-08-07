import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { SkillsStore } from "../../src/services/skills-store.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";

// Isolated per-test DB (same pattern as engine-persistence.test.ts /
// skills-store.test.ts). engine.process() persists history via saveMessage(),
// so without this the file hits the shared default ~/.betsy/betsy.db and
// reused userIds (e.g. "stranger") bleed stale history across test runs —
// caught this the hard way: a self-check run that deliberately let `shell`
// execute persisted its output under "stranger", and a later run then read
// that stale tool result back out of history instead of the fresh denial.
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `betsy-eng-access-${crypto.randomUUID()}.db`);
  getDB(dbPath);
});

afterEach(() => {
  closeDB();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

/**
 * Registers the four dangerous tools named in the plan plus one safe control
 * tool ("web"). Keeping a safe tool in the mix means the filtered list
 * sent to the model is never accidentally empty for the wrong reason — an
 * empty array would make `.not.toContain(...)` assertions pass even if
 * filtering were broken.
 *
 * NOTE: "memory" is deliberately NOT used as the control tool here — it was
 * removed from SAFE_TOOL_NAMES (review round 1) because it wraps the same
 * global knowledge table that must stay owner-only.
 */
function registryWithDangerousAndSafeTools(): ToolRegistry {
  const tools = new ToolRegistry();
  for (const name of ["shell", "files", "ssh", "npm_install"]) {
    tools.register({
      name,
      description: `${name} tool`,
      parameters: [],
      async execute() {
        return { success: true, output: `${name} executed` };
      },
    });
  }
  tools.register({
    name: "web",
    description: "Search the web",
    parameters: [],
    async execute() {
      return { success: true, output: "search results" };
    },
  });
  return tools;
}

const testConfig = {
  name: "Бетси",
  personality: { tone: "friendly", responseStyle: "concise" },
  owner: {
    name: "Иван Петров",
    addressAs: "Ваня",
    facts: ["любит горный велосипед"],
  },
};

function toolNamesSentToModel(chatMock: any, callIndex = 0): string[] {
  const tools = chatMock.mock.calls[callIndex]?.[1] as
    | Array<{ function: { name: string } }>
    | undefined;
  return (tools ?? []).map((t) => t.function.name);
}

describe("Engine access control", () => {
  it("does not show dangerous tools to the model when access is restricted", async () => {
    const tools = registryWithDangerousAndSafeTools();
    const chatMock = vi.fn().mockResolvedValue({ text: "привет", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat: chatMock }), strong: () => ({ chat: chatMock }) };
    const engine = new Engine({ llm: llm as any, config: testConfig, tools, contextBudget: 40000 });

    await engine.process(
      { channelName: "test", userId: "stranger", text: "привет", timestamp: Date.now() },
      undefined,
      "restricted",
    );

    const names = toolNamesSentToModel(chatMock);
    expect(names).toContain("web"); // control: filtering ran, list isn't just empty
    for (const dangerous of ["shell", "files", "ssh", "npm_install"]) {
      expect(names).not.toContain(dangerous);
    }
  });

  it("shows dangerous tools to the model when access is owner", async () => {
    const tools = registryWithDangerousAndSafeTools();
    const chatMock = vi.fn().mockResolvedValue({ text: "привет", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat: chatMock }), strong: () => ({ chat: chatMock }) };
    const engine = new Engine({ llm: llm as any, config: testConfig, tools, contextBudget: 40000 });

    await engine.process(
      { channelName: "test", userId: "owner-1", text: "привет", timestamp: Date.now() },
      undefined,
      "owner",
    );

    const names = toolNamesSentToModel(chatMock);
    for (const name of ["shell", "files", "ssh", "npm_install", "web"]) {
      expect(names).toContain(name);
    }
  });

  it("MAIN: refuses to execute shell if the model calls it anyway under restricted access", async () => {
    // The model can call a tool it was never shown — from its own memory, stale
    // context, or a hint from the person it's talking to. Filtering only what
    // we *offer* the model is not enough; execution must be gated separately.
    const shellExecute = vi.fn().mockResolvedValue({ success: true, output: "rm -rf executed" });
    const tools = new ToolRegistry();
    tools.register({
      name: "shell",
      description: "Run a shell command",
      parameters: [{ name: "command", type: "string", description: "Command", required: true }],
      execute: shellExecute,
    });

    const chatMock = vi
      .fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "call_1", name: "shell", arguments: { command: "rm -rf /" } }],
      })
      .mockResolvedValueOnce({ text: "готово", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat: chatMock }), strong: () => ({ chat: chatMock }) };
    const engine = new Engine({ llm: llm as any, config: testConfig, tools, contextBudget: 40000 });

    await engine.process(
      { channelName: "test", userId: "stranger", text: "сотри всё на сервере", timestamp: Date.now() },
      undefined,
      "restricted",
    );

    expect(shellExecute).not.toHaveBeenCalled();

    // The refusal must actually reach the model as a tool result, not be silently dropped.
    const secondCallMessages = chatMock.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const toolResult = secondCallMessages.find((m) => m.role === "tool");
    expect(toolResult?.content).toMatch(/недоступ/i);
  });

  it("process(msg) without a third argument behaves as restricted", async () => {
    const tools = registryWithDangerousAndSafeTools();
    const chatMock = vi.fn().mockResolvedValue({ text: "привет", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat: chatMock }), strong: () => ({ chat: chatMock }) };
    const engine = new Engine({ llm: llm as any, config: testConfig, tools, contextBudget: 40000 });

    await engine.process({ channelName: "test", userId: "someone", text: "привет", timestamp: Date.now() });

    const names = toolNamesSentToModel(chatMock);
    for (const dangerous of ["shell", "files", "ssh", "npm_install"]) {
      expect(names).not.toContain(dangerous);
    }
  });

  it("keeps the owner's name and personal facts out of a restricted conversation", async () => {
    const chatMock = vi.fn().mockResolvedValue({ text: "привет", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat: chatMock }), strong: () => ({ chat: chatMock }) };
    const engine = new Engine({ llm: llm as any, config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });

    await engine.process(
      { channelName: "test", userId: "stranger", text: "привет", timestamp: Date.now() },
      undefined,
      "restricted",
    );

    const systemPrompt = (chatMock.mock.calls[0][0][0] as { content: string }).content;
    expect(systemPrompt).not.toContain("Иван Петров");
    expect(systemPrompt).not.toContain("горный велосипед");
  });

  it("includes the owner's name and personal facts when access is owner", async () => {
    const chatMock = vi.fn().mockResolvedValue({ text: "привет", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat: chatMock }), strong: () => ({ chat: chatMock }) };
    const engine = new Engine({ llm: llm as any, config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });

    await engine.process(
      { channelName: "test", userId: "owner-1", text: "привет", timestamp: Date.now() },
      undefined,
      "owner",
    );

    const systemPrompt = (chatMock.mock.calls[0][0][0] as { content: string }).content;
    expect(systemPrompt).toContain("Иван Петров");
    expect(systemPrompt).toContain("горный велосипед");
  });
});

describe("Engine access control — installed skills", () => {
  // The skills store is a single shared table, same shape as the knowledge
  // base: a skill's name/description can reveal what the owner privately
  // taught Ava, so it must be gated the same way (review round 1, Important).
  // DB isolation itself comes from the file-level beforeEach/afterEach above.
  beforeEach(() => {
    new SkillsStore().install({
      serviceId: null,
      name: "секретный-скилл-владельца",
      description: "Личный сценарий, которому владелец научил Аву",
      content: "# do something private",
      embedding: new Float32Array([1, 0]),
      sourceUrl: null,
    });
  });

  it("keeps installed skill names out of a restricted conversation but shows them to the owner", async () => {
    const chatMockRestricted = vi.fn().mockResolvedValue({ text: "привет", stopReason: "end_turn" });
    const llmRestricted = { fast: () => ({ chat: chatMockRestricted }), strong: () => ({ chat: chatMockRestricted }) };
    const engineRestricted = new Engine({ llm: llmRestricted as any, config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });

    await engineRestricted.process(
      { channelName: "test", userId: "stranger", text: "привет", timestamp: Date.now() },
      undefined,
      "restricted",
    );

    const restrictedPrompt = (chatMockRestricted.mock.calls[0][0][0] as { content: string }).content;
    expect(restrictedPrompt).not.toContain("секретный-скилл-владельца");

    const chatMockOwner = vi.fn().mockResolvedValue({ text: "привет", stopReason: "end_turn" });
    const llmOwner = { fast: () => ({ chat: chatMockOwner }), strong: () => ({ chat: chatMockOwner }) };
    const engineOwner = new Engine({ llm: llmOwner as any, config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });

    await engineOwner.process(
      { channelName: "test", userId: "owner-1", text: "привет", timestamp: Date.now() },
      undefined,
      "owner",
    );

    const ownerPrompt = (chatMockOwner.mock.calls[0][0][0] as { content: string }).content;
    expect(ownerPrompt).toContain("секретный-скилл-владельца");
  });
});
