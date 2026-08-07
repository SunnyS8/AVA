import { describe, it, expect } from "vitest";
import { resolveTelegramIds } from "../../src/channels/telegram/handlers.js";

describe("resolveTelegramIds", () => {
  it("keys a private chat the same way as before: sender and chat coincide", () => {
    // In a 1:1 DM, Telegram's chat id equals the user's own id — behaviour
    // must not change here.
    const { userId, chatId } = resolveTelegramIds(555, 555);
    expect(userId).toBe("555");
    expect(chatId).toBe("555");
  });

  it("gives two different senders in the SAME group chat two different userIds", () => {
    const groupChatId = -1001234567890;
    const owner = resolveTelegramIds(groupChatId, 111);
    const stranger = resolveTelegramIds(groupChatId, 222);

    expect(owner.userId).not.toBe(stranger.userId);
    expect(owner.userId).toBe("111");
    expect(stranger.userId).toBe("222");
    // Both still address the same chat — a reply must reach the group.
    expect(owner.chatId).toBe(String(groupChatId));
    expect(stranger.chatId).toBe(String(groupChatId));
  });

  it("falls back to chatId for userId when sender is unknown", () => {
    const { userId, chatId } = resolveTelegramIds(42, undefined);
    expect(userId).toBe("42");
    expect(chatId).toBe("42");
  });

  it("falls back to fromId for chatId when chat is unknown", () => {
    const { userId, chatId } = resolveTelegramIds(undefined, 77);
    expect(userId).toBe("77");
    expect(chatId).toBe("77");
  });

  it("returns 'unknown' when both are missing", () => {
    const { userId, chatId } = resolveTelegramIds(undefined, undefined);
    expect(userId).toBe("unknown");
    expect(chatId).toBe("unknown");
  });
});
