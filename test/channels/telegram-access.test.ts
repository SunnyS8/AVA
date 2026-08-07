import { describe, it, expect } from "vitest";
import { computeTelegramAccess } from "../../src/channels/telegram/access.js";

describe("computeTelegramAccess", () => {
  it("grants owner access when the sender matches the configured owner_id", () => {
    expect(computeTelegramAccess("123456", 123456)).toBe("owner");
  });

  it("restricts a stranger whose id does not match owner_id", () => {
    expect(computeTelegramAccess("999", 123456)).toBe("restricted");
  });

  it("restricts everyone when no owner is configured yet", () => {
    // No accidental owner grant just because owner_id hasn't been claimed.
    expect(computeTelegramAccess("123456", undefined)).toBe("restricted");
  });

  it("compares as strings — numeric-looking prefixes must not match", () => {
    // Guards against a naive numeric comparison or substring match.
    expect(computeTelegramAccess("1234560", 123456)).toBe("restricted");
    expect(computeTelegramAccess("23456", 123456)).toBe("restricted");
  });
});
