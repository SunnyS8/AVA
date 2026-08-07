import { describe, it, expect, vi } from "vitest";
import { buildBitrixHandler } from "../../src/channels/bitrix/wiring.js";
import { RateLimiter } from "../../src/core/limits.js";

const profiles = {
  owner_id: "1",
  analyst_ids: [], marketing_head_ids: [], marketing_specialist_ids: [],
  voice_ids: [], video_ids: [], modes: {},
  limits: { per_hour: 2, per_day_total: 100 },
};

const msg = (userId: string) => ({
  channelName: "bitrix", userId, text: "вопрос", timestamp: 0,
});

describe("buildBitrixHandler", () => {
  it("asks the engine and returns its answer", async () => {
    const ask = vi.fn().mockResolvedValue({ text: "ответ" });
    const h = buildBitrixHandler({ ask, profiles, limiter: new RateLimiter(2, 100, () => 0) });
    expect(await h(msg("7"))).toEqual({ text: "ответ" });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("refuses politely once the limit is spent and stops asking the engine", async () => {
    const ask = vi.fn().mockResolvedValue({ text: "ответ" });
    const h = buildBitrixHandler({ ask, profiles, limiter: new RateLimiter(2, 100, () => 0) });
    await h(msg("7"));
    await h(msg("7"));
    const third = await h(msg("7"));
    expect(third.text).toMatch(/слишком часто|позже/i);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("never limits the owner", async () => {
    const ask = vi.fn().mockResolvedValue({ text: "ответ" });
    const h = buildBitrixHandler({ ask, profiles, limiter: new RateLimiter(1, 1, () => 0) });
    for (let i = 0; i < 5; i++) {
      expect((await h(msg("1"))).text).toBe("ответ");
    }
    expect(ask).toHaveBeenCalledTimes(5);
  });

  it("passes the caller profile to the engine", async () => {
    const ask = vi.fn().mockResolvedValue({ text: "ответ" });
    const h = buildBitrixHandler({ ask, profiles, limiter: new RateLimiter(9, 99, () => 0) });
    await h(msg("1"));
    expect(ask.mock.calls[0][1]).toMatchObject({ role: "owner", unlimited: true });
  });

  it("gives the owner's own profile owner-level access", async () => {
    const ask = vi.fn().mockResolvedValue({ text: "ответ" });
    const h = buildBitrixHandler({ ask, profiles, limiter: new RateLimiter(9, 99, () => 0) });
    await h(msg("1")); // "1" == profiles.owner_id
    expect(ask.mock.calls[0][1]).toMatchObject({ role: "owner" });
    expect(ask.mock.calls[0][2]).toBe("owner");
  });

  it("restricts a rank-and-file employee's access", async () => {
    const ask = vi.fn().mockResolvedValue({ text: "ответ" });
    const h = buildBitrixHandler({ ask, profiles, limiter: new RateLimiter(9, 99, () => 0) });
    await h(msg("999")); // not in owner_id or any role list => plain employee
    expect(ask.mock.calls[0][1]).toMatchObject({ role: "employee" });
    expect(ask.mock.calls[0][2]).toBe("restricted");
  });

  it("restricts every non-owner role, not just plain employees", async () => {
    const rolesProfiles = {
      ...profiles,
      analyst_ids: ["10"],
      marketing_head_ids: ["20"],
      marketing_specialist_ids: ["30"],
    };
    const ask = vi.fn().mockResolvedValue({ text: "ответ" });
    const h = buildBitrixHandler({ ask, profiles: rolesProfiles, limiter: new RateLimiter(99, 999, () => 0) });

    for (const id of ["10", "20", "30"]) {
      await h(msg(id));
    }

    expect(ask.mock.calls[0][2]).toBe("restricted"); // analyst
    expect(ask.mock.calls[1][2]).toBe("restricted"); // marketing_head
    expect(ask.mock.calls[2][2]).toBe("restricted"); // marketing_specialist
  });
});
