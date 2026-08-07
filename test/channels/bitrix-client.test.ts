import { describe, it, expect, vi } from "vitest";
import { BitrixClient, clip } from "../../src/channels/bitrix/client.js";

describe("clip", () => {
  it("leaves a short text alone", () => {
    expect(clip("hello", 100)).toBe("hello");
  });

  it("keeps the head and the tail of a long text", () => {
    const long = "A".repeat(50) + "MIDDLE" + "B".repeat(50);
    const out = clip(long, 40);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("B")).toBe(true);
    expect(out).toContain("…");
  });
});

describe("BitrixClient", () => {
  it("sends as the bot, not as the webhook owner", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "{}" });
    const c = new BitrixClient("https://p.bitrix24.ru/rest/6/secret/", "42", fetchMock as unknown as typeof fetch);
    await c.sendMessage("chat42", "привет");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // imbot.message.add — сообщение от имени бота. im.message.add отправил бы
    // его от имени владельца вебхука, и сотрудники увидели бы живого человека.
    expect(url).toBe("https://p.bitrix24.ru/rest/6/secret/imbot.message.add.json");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent.BOT_ID).toBe("42");
    expect(sent.DIALOG_ID).toBe("chat42");
    expect(sent.MESSAGE).toBe("привет");
  });

  it("clips an over-long message before sending", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "{}" });
    const c = new BitrixClient("https://p.bitrix24.ru/rest/6/secret/", "42", fetchMock as unknown as typeof fetch);
    await c.sendMessage("chat1", "x".repeat(9000));
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.MESSAGE.length).toBeLessThanOrEqual(8001);
  });

  it("throws with a message that does NOT contain the webhook secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    const c = new BitrixClient("https://p.bitrix24.ru/rest/6/supersecret/", "42", fetchMock as unknown as typeof fetch);
    await expect(c.sendMessage("chat1", "hi")).rejects.toThrow(/500/);
    await expect(c.sendMessage("chat1", "hi")).rejects.not.toThrow(/supersecret/);
  });

  it("keeps the webhook secret out of the error when fetch itself throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      new TypeError("Failed to parse URL from https://p.bitrix24.ru/rest/6/supersecret/imbot.message.add.json"),
    );
    const c = new BitrixClient("https://p.bitrix24.ru/rest/6/supersecret/", "42", fetchMock as unknown as typeof fetch);
    await expect(c.sendMessage("chat1", "hi")).rejects.not.toThrow(/supersecret/);
  });

  it("treats an error field in a 200 response as a failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ error: "BOT_ID_NOT_FOUND", error_description: "no such bot" }),
    });
    const c = new BitrixClient("https://p.bitrix24.ru/rest/6/secret/", "42", fetchMock as unknown as typeof fetch);
    await expect(c.sendMessage("chat1", "hi")).rejects.toThrow(/BOT_ID_NOT_FOUND/);
  });

  it("accepts a normal successful answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ result: 123 }) });
    const c = new BitrixClient("https://p.bitrix24.ru/rest/6/secret/", "42", fetchMock as unknown as typeof fetch);
    await expect(c.sendMessage("chat1", "hi")).resolves.toBeUndefined();
  });

  it("does not cut an emoji in half when clipping", () => {
    const out = clip("😀".repeat(20), 11);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
