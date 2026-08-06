import { describe, it, expect } from "vitest";
import { resolveProfile } from "../../src/core/profiles.js";

const cfg = {
  owner_id: "1",
  analyst_ids: ["6"],
  marketing_head_ids: ["20"],
  marketing_specialist_ids: ["21", "22"],
  voice_ids: ["1", "6"],
  video_ids: ["1"],
  modes: { "1": "personal", "6": "analyst" },
  limits: { per_hour: 15, per_day_total: 300 },
};

describe("resolveProfile", () => {
  it("recognises the owner and lifts his limits", () => {
    const p = resolveProfile("1", cfg);
    expect(p.role).toBe("owner");
    expect(p.unlimited).toBe(true);
    expect(p.mode).toBe("personal");
  });

  it("recognises analyst, marketing head and specialist", () => {
    expect(resolveProfile("6", cfg).role).toBe("analyst");
    expect(resolveProfile("20", cfg).role).toBe("marketing_head");
    expect(resolveProfile("22", cfg).role).toBe("marketing_specialist");
  });

  it("treats an unknown user as a plain employee with limits", () => {
    const p = resolveProfile("999", cfg);
    expect(p.role).toBe("employee");
    expect(p.unlimited).toBe(false);
    expect(p.mode).toBe("default");
  });

  it("denies voice and video to anyone not on the list", () => {
    expect(resolveProfile("999", cfg).voice).toBe(false);
    expect(resolveProfile("999", cfg).video).toBe(false);
    expect(resolveProfile("6", cfg).voice).toBe(true);
    expect(resolveProfile("6", cfg).video).toBe(false);
  });

  it("denies everything when there is no config at all", () => {
    const p = resolveProfile("1", undefined);
    expect(p.role).toBe("employee");
    expect(p.voice).toBe(false);
    expect(p.video).toBe(false);
    expect(p.unlimited).toBe(false);
  });
});
