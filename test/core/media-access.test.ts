import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isToolAllowed, filterTools, MEDIA_TOOLS } from "../../src/core/access.js";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";

// Same per-test DB isolation as engine-access.test.ts: engine.process()
// persists history, and a shared file lets one run's tool output leak into
// the next one's context.
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `betsy-media-access-${crypto.randomUUID()}.db`);
  getDB(dbPath);
});

afterEach(() => {
  closeDB();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* уже нет */ }
  }
});

const ALLOWED = { video: true, voice: true };
const DENIED = { video: false, voice: false };

describe("Права на платную генерацию", () => {
  it("пускает к видео только того, кому оно разрешено", () => {
    expect(isToolAllowed("video_message", "restricted", ALLOWED)).toBe(true);
    expect(isToolAllowed("video_message", "restricted", DENIED)).toBe(false);
  });

  it("без разрешений закрывает видео ВСЕМ, включая владельца", () => {
    // Запрет по умолчанию. Список потеряли при правке конфига, канал забыл
    // передать права — дверь закрывается, а не открывается. Ошибка, которая
    // ничего не стоит, лучше ошибки, которая тратит деньги.
    expect(isToolAllowed("video_message", "restricted")).toBe(false);
    expect(isToolAllowed("video_message", "owner")).toBe(false);
  });

  it("голос закрыт по тому же правилу", () => {
    expect(isToolAllowed("voice_message", "restricted", { video: true, voice: false })).toBe(false);
    expect(isToolAllowed("voice_message", "restricted", { video: false, voice: true })).toBe(true);
  });

  it("не трогает остальные инструменты", () => {
    // Защита от регрессии: ограничение медиа не должно случайно перекрыть
    // то, чем сотрудники пользовались и раньше.
    expect(isToolAllowed("web", "restricted", DENIED)).toBe(true);
    expect(isToolAllowed("selfie", "restricted", DENIED)).toBe(true);
    expect(isToolAllowed("shell", "restricted", ALLOWED)).toBe(false);
    expect(isToolAllowed("shell", "owner", DENIED)).toBe(true);
  });

  it("убирает видео из списка, который видит модель", () => {
    const tools = [{ name: "web" }, { name: "video_message" }];
    expect(filterTools(tools, "restricted", DENIED).map((t) => t.name)).toEqual(["web"]);
    expect(filterTools(tools, "restricted", ALLOWED).map((t) => t.name)).toEqual(["web", "video_message"]);
  });

  it("знает оба платных инструмента", () => {
    expect(Object.keys(MEDIA_TOOLS).sort()).toEqual(["video_message", "voice_message"]);
  });
});

function registryWithVideo(): ToolRegistry {
  const tools = new ToolRegistry();
  const execute = vi.fn().mockResolvedValue({ success: true, output: "видео готово" });
  tools.register({
    name: "video_message",
    description: "Отправить видео-кружочек",
    parameters: [],
    execute,
  });
  tools.register({
    name: "web",
    description: "Поиск",
    parameters: [],
    async execute() {
      return { success: true, output: "результаты" };
    },
  });
  return tools;
}

const testConfig = {
  name: "Ава",
  personality: { tone: "friendly", responseStyle: "concise" },
  owner: { name: "Елена", addressAs: "Елена", facts: [] },
};

describe("Движок: видео не сгенерировать в обход списка", () => {
  it("не показывает видео тому, кому нельзя", async () => {
    const tools = registryWithVideo();
    const chatMock = vi.fn().mockResolvedValue({ text: "привет", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat: chatMock }), strong: () => ({ chat: chatMock }) };
    const engine = new Engine({ llm: llm as any, config: testConfig, tools, contextBudget: 40000 });

    await engine.process(
      { channelName: "test", userId: "42", text: "сделай кружочек", timestamp: Date.now() },
      undefined,
      "restricted",
      DENIED,
    );

    const sent = (chatMock.mock.calls[0]?.[1] ?? []) as Array<{ function: { name: string } }>;
    const names = sent.map((t) => t.function.name);
    expect(names).toContain("web"); // контроль: список не пуст сам по себе
    expect(names).not.toContain("video_message");
  });

  it("отбивает вызов видео, даже если модель позвала его сама", async () => {
    // Защита в глубину: модель может назвать инструмент, которого ей не
    // показывали — из памяти, из старого контекста или по подсказке
    // собеседника. Список в запросе не рубеж; рубеж здесь.
    const tools = registryWithVideo();
    const videoTool = tools.list().find((t) => t.name === "video_message")!;
    const chatMock = vi
      .fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "1", name: "video_message", arguments: { text: "привет" } }],
      })
      .mockResolvedValueOnce({ text: "готово", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat: chatMock }), strong: () => ({ chat: chatMock }) };
    const engine = new Engine({ llm: llm as any, config: testConfig, tools, contextBudget: 40000 });

    await engine.process(
      { channelName: "test", userId: "42", text: "сделай кружочек", timestamp: Date.now() },
      undefined,
      "restricted",
      DENIED,
    );

    expect(videoTool.execute).not.toHaveBeenCalled();
  });

  it("разрешённому пользователю видео доступно", async () => {
    const tools = registryWithVideo();
    const videoTool = tools.list().find((t) => t.name === "video_message")!;
    const chatMock = vi
      .fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "1", name: "video_message", arguments: { text: "привет" } }],
      })
      .mockResolvedValueOnce({ text: "готово", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat: chatMock }), strong: () => ({ chat: chatMock }) };
    const engine = new Engine({ llm: llm as any, config: testConfig, tools, contextBudget: 40000 });

    await engine.process(
      { channelName: "test", userId: "6", text: "сделай кружочек", timestamp: Date.now() },
      undefined,
      "restricted",
      ALLOWED,
    );

    expect(videoTool.execute).toHaveBeenCalled();
  });
});
