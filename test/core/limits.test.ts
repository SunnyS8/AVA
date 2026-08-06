import { describe, it, expect } from "vitest";
import { RateLimiter } from "../../src/core/limits.js";

describe("RateLimiter", () => {
  it("allows up to the hourly cap and blocks the next one", () => {
    let t = 0;
    const rl = new RateLimiter(15, 300, () => t);
    for (let i = 0; i < 15; i++) {
      expect(rl.check("7", false).allowed).toBe(true);
    }
    const v = rl.check("7", false);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("per_hour");
    expect(v.retryAfterMin).toBeGreaterThan(0);
  });

  it("forgets the hour once it has passed", () => {
    let t = 0;
    const rl = new RateLimiter(2, 300, () => t);
    rl.check("7", false);
    rl.check("7", false);
    expect(rl.check("7", false).allowed).toBe(false);
    t = 61 * 60 * 1000;
    expect(rl.check("7", false).allowed).toBe(true);
  });

  it("counts the portal-wide daily cap across users", () => {
    let t = 0;
    const rl = new RateLimiter(1000, 3, () => t);
    expect(rl.check("a", false).allowed).toBe(true);
    expect(rl.check("b", false).allowed).toBe(true);
    expect(rl.check("c", false).allowed).toBe(true);
    const v = rl.check("d", false);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("per_day_total");
  });

  it("never limits the owner and does not count him against the portal cap", () => {
    let t = 0;
    const rl = new RateLimiter(1, 1, () => t);
    for (let i = 0; i < 50; i++) {
      expect(rl.check("1", true).allowed).toBe(true);
    }
    expect(rl.check("other", false).allowed).toBe(true);
  });
});
