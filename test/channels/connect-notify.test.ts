import { describe, it, expect, vi } from "vitest";
import { buildConnectNotifyHandler, type EngineLike } from "../../src/channels/connect-notify.js";
import type { Channel } from "../../src/channels/types.js";
import type { ServiceDefinition } from "../../src/services/catalog.js";

function fakeChannel(name: string): { channel: Channel; sent: Array<{ userId: string; text: string }> } {
  const sent: Array<{ userId: string; text: string }> = [];
  const channel: Channel = {
    name,
    requiredConfig: [],
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: vi.fn(),
    send: vi.fn(async (userId: string, message: { text: string }) => {
      sent.push({ userId, text: message.text });
    }),
  };
  return { channel, sent };
}

const service: ServiceDefinition = {
  id: "google",
  name: "Google",
  description: "test",
  relayUrl: "https://relay.example",
  scopes: { gmail: "Почта" },
  baseUrls: {},
  actions: {},
};

describe("buildConnectNotifyHandler", () => {
  it("notifies only the channel the connect request came from", async () => {
    const { channel: bitrix, sent: sentBitrix } = fakeChannel("bitrix");
    const { channel: telegram, sent: sentTelegram } = fakeChannel("telegram");
    const channels = new Map([["bitrix", bitrix], ["telegram", telegram]]);

    const handler = buildConnectNotifyHandler({ channels, getEngine: () => null });
    await handler("dialog42", service, ["gmail"], "bitrix");

    expect(sentBitrix).toHaveLength(1);
    expect(sentBitrix[0].userId).toBe("dialog42");
    expect(sentBitrix[0].text).toContain("Google");
    // The other registered channel must NOT receive anything — this is
    // exactly the fan-out bug: a Telegram numeric id and a Bitrix dialog id
    // are different address spaces, so blasting every channel either
    // delivers nowhere or lands in the wrong dialog.
    expect(sentTelegram).toHaveLength(0);
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it("routes to telegram when the request came from telegram, not bitrix", async () => {
    const { channel: bitrix, sent: sentBitrix } = fakeChannel("bitrix");
    const { channel: telegram, sent: sentTelegram } = fakeChannel("telegram");
    const channels = new Map([["bitrix", bitrix], ["telegram", telegram]]);

    const handler = buildConnectNotifyHandler({ channels, getEngine: () => null });
    await handler("123456", service, ["gmail"], "telegram");

    expect(sentTelegram).toHaveLength(1);
    expect(sentTelegram[0].userId).toBe("123456");
    expect(sentBitrix).toHaveLength(0);
  });

  it("skips and logs instead of broadcasting when the channel cannot be found", async () => {
    const { channel: bitrix, sent: sentBitrix } = fakeChannel("bitrix");
    const { channel: telegram, sent: sentTelegram } = fakeChannel("telegram");
    const channels = new Map([["bitrix", bitrix], ["telegram", telegram]]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = buildConnectNotifyHandler({ channels, getEngine: () => null });
    await handler("someone", service, ["gmail"], "");

    expect(sentBitrix).toHaveLength(0);
    expect(sentTelegram).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("asks the engine to verify the connection on the same channel", async () => {
    const { channel: bitrix, sent: sentBitrix } = fakeChannel("bitrix");
    const channels = new Map([["bitrix", bitrix]]);
    const engineProcess = vi.fn().mockResolvedValue({ text: "проверила, всё ок" });
    const engine: EngineLike = { process: engineProcess };

    const handler = buildConnectNotifyHandler({ channels, getEngine: () => engine });
    await handler("dialog42", service, ["gmail"], "bitrix");

    expect(engineProcess).toHaveBeenCalledTimes(1);
    expect(engineProcess.mock.calls[0][0]).toMatchObject({ channelName: "bitrix", userId: "dialog42" });
    // First the connect confirmation, then the engine's verification result.
    expect(sentBitrix).toHaveLength(2);
    expect(sentBitrix[1].text).toBe("проверила, всё ок");
  });
});
