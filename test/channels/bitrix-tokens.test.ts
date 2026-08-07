import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BitrixTokenStore, type BitrixTokens } from "../../src/channels/bitrix/tokens.js";

describe("BitrixTokenStore", () => {
  let dir: string;
  let filePath: string;
  let store: BitrixTokenStore;

  const sample: BitrixTokens = {
    accessToken: "access-123",
    refreshToken: "refresh-456",
    expiresAt: Date.now() + 3600_000,
    domain: "example.bitrix24.ru",
    memberId: "member-789",
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "betsy-bitrix-tokens-"));
    filePath = path.join(dir, "tokens.json");
    store = new BitrixTokenStore(filePath);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads back what was saved without loss", () => {
    store.save(sample);
    const loaded = store.load();
    expect(loaded).toEqual(sample);
  });

  it("returns null when the file does not exist, without throwing", () => {
    expect(() => store.load()).not.toThrow();
    expect(store.load()).toBeNull();
  });

  it("returns null for a non-JSON file and does not crash the process", () => {
    fs.writeFileSync(filePath, "not json at all {{{");
    expect(() => store.load()).not.toThrow();
    expect(store.load()).toBeNull();
  });

  it("returns null for a truncated JSON file", () => {
    const full = JSON.stringify(sample);
    fs.writeFileSync(filePath, full.slice(0, Math.floor(full.length / 2)));
    expect(store.load()).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    fs.writeFileSync(filePath, JSON.stringify({ accessToken: "only-this" }));
    expect(store.load()).toBeNull();
  });

  it("logs the failure reason without leaking file contents", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(filePath, "super-secret-token-value-should-not-leak");
    store.load();
    expect(spy).toHaveBeenCalled();
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("super-secret-token-value-should-not-leak");
    spy.mockRestore();
  });

  it("writes the file so it can be read back (permission check skipped on win32)", () => {
    store.save(sample);
    expect(fs.existsSync(filePath)).toBe(true);
    if (process.platform !== "win32") {
      const mode = fs.statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("does not leave a stray temp file behind after save", () => {
    store.save(sample);
    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(["tokens.json"]);
  });

  describe("isExpired", () => {
    it("treats a token as expired a minute before formal expiry", () => {
      const now = 1_000_000_000;
      const t: BitrixTokens = { ...sample, expiresAt: now + 60_000 };
      expect(store.isExpired(t, now)).toBe(true);
    });

    it("treats a token as not expired when well within the window", () => {
      const now = 1_000_000_000;
      const t: BitrixTokens = { ...sample, expiresAt: now + 120_000 };
      expect(store.isExpired(t, now)).toBe(false);
    });

    it("treats a token as expired once formally past expiresAt", () => {
      const now = 1_000_000_000;
      const t: BitrixTokens = { ...sample, expiresAt: now - 1 };
      expect(store.isExpired(t, now)).toBe(true);
    });

    it("defaults now to Date.now() when not provided", () => {
      const t: BitrixTokens = { ...sample, expiresAt: Date.now() - 1 };
      expect(store.isExpired(t)).toBe(true);
    });
  });
});
