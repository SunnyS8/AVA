import { describe, it, expect } from "vitest";
import { verifyEvent } from "../../src/channels/bitrix/verify.js";
import type { BitrixEvent } from "../../src/channels/bitrix/event.js";

const ev = (token: string): BitrixEvent => ({
  event: "ONIMBOTMESSAGEADD",
  dialogId: "chat1",
  fromUserId: "7",
  text: "hi",
  applicationToken: token,
  fromBot: false,
});

describe("verifyEvent", () => {
  it("accepts a matching token", () => {
    expect(verifyEvent(ev("good"), "good")).toBe(true);
  });

  it("rejects a forged token", () => {
    expect(verifyEvent(ev("bad"), "good")).toBe(false);
  });

  it("rejects an empty token instead of treating it as 'checks off'", () => {
    expect(verifyEvent(ev(""), "good")).toBe(false);
  });

  it("rejects everything when no token is configured", () => {
    expect(verifyEvent(ev("anything"), undefined)).toBe(false);
    expect(verifyEvent(ev("anything"), "")).toBe(false);
  });
});
