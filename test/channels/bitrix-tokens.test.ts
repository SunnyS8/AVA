import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BitrixTokenStore, refreshTokens, type BitrixTokens } from "../../src/channels/bitrix/tokens.js";

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

  it("cleans up the temp file when the write itself fails", () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("simulated disk full");
    });
    try {
      expect(() => store.save(sample)).toThrow("simulated disk full");
    } finally {
      writeSpy.mockRestore();
    }
    // No half-written temp file — and no real tokens file either, since the
    // write never completed and the rename never happened.
    const entries = fs.readdirSync(dir);
    expect(entries).toEqual([]);
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

describe("refreshTokens", () => {
  const clientId = "local.app.id";
  const clientSecret = "super-secret-client-secret";
  const oldRefreshToken = "old-refresh-token-value";

  function jsonResponse(body: unknown, ok = true, status = 200): Response {
    return {
      ok,
      status,
      text: async () => JSON.stringify(body),
    } as Response;
  }

  it("parses a successful response and computes expiresAt from the current time", async () => {
    const before = Date.now();
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        domain: "example.bitrix24.ru",
        member_id: "member-789",
      }),
    );

    const tokens = await refreshTokens(oldRefreshToken, clientId, clientSecret, fetchImpl);
    const after = Date.now();

    expect(tokens.accessToken).toBe("new-access-token");
    expect(tokens.refreshToken).toBe("new-refresh-token");
    expect(tokens.domain).toBe("example.bitrix24.ru");
    expect(tokens.memberId).toBe("member-789");

    // expiresAt must be computed from "now + expires_in", not from expires_in
    // alone (3600) and not left at 0.
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(after + 3600_000);
  });

  it("sends the secrets in the POST body, never in the URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        domain: "example.bitrix24.ru",
        member_id: "member-789",
      }),
    );

    await refreshTokens(oldRefreshToken, clientId, clientSecret, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://oauth.bitrix.info/oauth/token/");
    expect(url).not.toContain(clientSecret);
    expect(url).not.toContain(oldRefreshToken);

    expect(init.method).toBe("POST");
    const body = String(init.body);
    expect(body).toContain(clientSecret);
    expect(body).toContain(oldRefreshToken);
    expect(body).toContain("grant_type=refresh_token");
  });

  it("throws on an error response from the portal, without leaking secrets", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: "invalid_grant", error_description: `bad refresh token ${oldRefreshToken}` }, false, 400),
    );

    let caught: Error | undefined;
    try {
      await refreshTokens(oldRefreshToken, clientId, clientSecret, fetchImpl);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    const message = caught!.message;
    expect(message).not.toContain(clientSecret);
    expect(message).not.toContain(oldRefreshToken);
    expect(message).not.toContain("new-access-token");
    expect(message).toContain("invalid_grant");
  });

  it("throws on an incomplete successful response, without leaking secrets", async () => {
    // access_token present, refresh_token missing — a partial response like
    // this must not silently produce a token record with a hole in it.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: "new-access-token",
        expires_in: 3600,
        domain: "example.bitrix24.ru",
        member_id: "member-789",
      }),
    );

    let caught: Error | undefined;
    try {
      await refreshTokens(oldRefreshToken, clientId, clientSecret, fetchImpl);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    const message = caught!.message;
    expect(message).toContain("refresh_token");
    expect(message).not.toContain(clientSecret);
    expect(message).not.toContain(oldRefreshToken);
    expect(message).not.toContain("new-access-token");
  });

  it("throws when fetch itself fails, without leaking secrets", async () => {
    // Real fetch bakes the whole URL — query string included — into the
    // error message on a network failure. The refresh URL carries no
    // secrets itself, but the assertion still guards against a regression
    // that would move the params back into the query string.
    const fetchImpl = vi.fn().mockRejectedValue(
      new TypeError(
        `fetch failed: https://oauth.bitrix.info/oauth/token/?client_secret=${clientSecret}&refresh_token=${oldRefreshToken}`,
      ),
    );

    let caught: Error | undefined;
    try {
      await refreshTokens(oldRefreshToken, clientId, clientSecret, fetchImpl);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    const message = caught!.message;
    expect(message).not.toContain(clientSecret);
    expect(message).not.toContain(oldRefreshToken);
  });
});
