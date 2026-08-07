import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer, type ServerHandle } from "../src/server.js";

let handle: ServerHandle | null = null;
const prevConfigPath = process.env.BETSY_CONFIG_PATH;

beforeAll(() => {
  // Force loadConfig() to return null (no config) by pointing at a non-existent file
  process.env.BETSY_CONFIG_PATH = "/__nonexistent__/betsy-test-config.yaml";
});

afterAll(() => {
  if (prevConfigPath === undefined) delete process.env.BETSY_CONFIG_PATH;
  else process.env.BETSY_CONFIG_PATH = prevConfigPath;
});

afterEach(() => {
  if (handle) {
    handle.close();
    handle = null;
  }
});

describe("Server", () => {
  it("creates server on specified port", async () => {
    handle = createServer({ port: 0 }); // port 0 = OS picks a free port
    const addr = handle.server.address();
    expect(addr).not.toBeNull();
    expect(typeof addr === "object" && addr !== null ? addr.port : -1).toBeGreaterThan(0);
  });

  it("returns status from GET /api/status", async () => {
    handle = createServer({ port: 0 });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/status`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { mode: string; configured: boolean };
    expect(body.mode).toBe("setup");
    expect(body.configured).toBe(false);
  });

  it("returns 404 for unknown API routes", async () => {
    handle = createServer({ port: 0 });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("issues JWT from POST /api/auth without password", async () => {
    handle = createServer({ port: 0 });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.token.split(".")).toHaveLength(3);
  });

  it("rejects wrong password when passwordHash is set", async () => {
    const crypto = await import("node:crypto");
    const passwordHash = crypto.createHash("sha256").update("correct").digest("hex");
    handle = createServer({ port: 0, passwordHash });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(res.status).toBe(403);
  });

  it("grants JWT with correct password", async () => {
    const crypto = await import("node:crypto");
    const passwordHash = crypto.createHash("sha256").update("secret123").digest("hex");
    handle = createServer({ port: 0, passwordHash });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "secret123" }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
  });

  it("protects routes when passwordHash is set", async () => {
    const crypto = await import("node:crypto");
    const passwordHash = crypto.createHash("sha256").update("pass").digest("hex");
    handle = createServer({ port: 0, passwordHash });
    const addr = handle.server.address() as { port: number };

    // /api/status should require auth when password is configured
    const res = await fetch(`http://localhost:${addr.port}/api/status`);
    expect(res.status).toBe(401);

    // Get a valid token
    const authRes = await fetch(`http://localhost:${addr.port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "pass" }),
    });
    const { token } = (await authRes.json()) as { token: string };

    // Now /api/status should work with the token
    const authedRes = await fetch(`http://localhost:${addr.port}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(authedRes.status).toBe(200);
  });

  it("allows public routes without auth even with passwordHash", async () => {
    const crypto = await import("node:crypto");
    const passwordHash = crypto.createHash("sha256").update("pass").digest("hex");
    handle = createServer({ port: 0, passwordHash });
    const addr = handle.server.address() as { port: number };

    // /api/auth should always be accessible
    const res = await fetch(`http://localhost:${addr.port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "pass" }),
    });
    expect(res.status).toBe(200);
  });

  it("has WebSocket server on /chat path", () => {
    handle = createServer({ port: 0 });
    expect(handle.wss).toBeDefined();
    expect(handle.wss.options.path).toBe("/chat");
  });

  it("returns skills list", async () => {
    handle = createServer({ port: 0 });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/skills`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { skills: string[] };
    expect(Array.isArray(body.skills)).toBe(true);
  });
});

describe("POST /bitrix/", () => {
  it("passes the body to the channel and answers its status without a token", async () => {
    const handleWebhook = vi.fn().mockReturnValue({ status: 200 });
    handle = createServer({ port: 0, passwordHash: "irrelevant", bitrix: { handleWebhook } });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/bitrix/`, {
      method: "POST",
      body: "event=ONIMBOTMESSAGEADD",
    });

    expect(res.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledWith("event=ONIMBOTMESSAGEADD");
  });

  it("answers 404 when no bitrix channel is wired up", async () => {
    handle = createServer({ port: 0 });
    const addr = handle.server.address() as { port: number };
    const res = await fetch(`http://localhost:${addr.port}/bitrix/`, { method: "POST", body: "x" });
    expect(res.status).toBe(404);
  });

  it("refuses an oversized body instead of buffering it", async () => {
    const handleWebhook = vi.fn().mockReturnValue({ status: 200 });
    handle = createServer({ port: 0, bitrix: { handleWebhook } });
    const addr = handle.server.address() as { port: number };

    // readBody() caps at 1 MB and destroys the connection on overflow, so the
    // client sees the socket die rather than a clean HTTP response.
    await expect(
      fetch(`http://localhost:${addr.port}/bitrix/`, {
        method: "POST",
        body: "x".repeat(2 * 1024 * 1024), // twice the limit
      }),
    ).rejects.toThrow();

    expect(handleWebhook).not.toHaveBeenCalled();
  });
});

describe("GET /api/config — secret masking", () => {
  const tmpConfigPath = path.join(os.tmpdir(), `betsy-test-config-${Date.now()}.yaml`);
  let prevPath: string | undefined;

  beforeAll(() => {
    prevPath = process.env.BETSY_CONFIG_PATH;
    fs.writeFileSync(
      tmpConfigPath,
      [
        "agent:",
        "  name: Test",
        "llm:",
        "  provider: openrouter",
        "  api_key: sk-secret-llm-key",
        "telegram:",
        "  token: tg-secret-token",
        "bitrix:",
        '  webhook_url: "https://p.bitrix24.ru/rest/6/verysecrettoken123/"',
        '  application_token: "app-secret-token-xyz"',
        "",
      ].join("\n"),
    );
    process.env.BETSY_CONFIG_PATH = tmpConfigPath;
  });

  afterAll(() => {
    if (prevPath === undefined) delete process.env.BETSY_CONFIG_PATH;
    else process.env.BETSY_CONFIG_PATH = prevPath;
    fs.rmSync(tmpConfigPath, { force: true });
  });

  it("does not leak the bitrix webhook url or application token", async () => {
    handle = createServer({ port: 0 });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/config`);
    expect(res.status).toBe(200);

    const bodyText = await res.text();
    // The webhook URL carries the portal access token in its path
    // (…/rest/<user>/<token>/) — a raw copy anywhere in the response is a leak.
    expect(bodyText).not.toContain("verysecrettoken123");
    expect(bodyText).not.toContain("app-secret-token-xyz");
    // Sanity: other already-masked secrets stay masked too (regression guard).
    expect(bodyText).not.toContain("sk-secret-llm-key");
    expect(bodyText).not.toContain("tg-secret-token");

    const body = JSON.parse(bodyText) as { bitrix?: { webhook_url?: string; application_token?: string } };
    expect(body.bitrix?.webhook_url).toBeTruthy();
    expect(body.bitrix?.webhook_url).not.toBe("https://p.bitrix24.ru/rest/6/verysecrettoken123/");
    expect(body.bitrix?.application_token).toBeTruthy();
    expect(body.bitrix?.application_token).not.toBe("app-secret-token-xyz");
  });
});

describe("POST /api/chat — access level", () => {
  function fakeEngine() {
    const process = vi.fn().mockResolvedValue({ text: "ответ" });
    return { process, getHistory: () => [], clearHistory: () => {} };
  }

  it("sends the engine 'restricted' when no password is configured — fail safe", async () => {
    // Without passwordHash the JWT gate in createRequestHandler is skipped
    // entirely, so this request reached the engine WITHOUT authenticating.
    // It must not get owner-level tools just because it's the panel route.
    const engine = fakeEngine();
    handle = createServer({ port: 0, engine: engine as any });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "привет" }),
    });
    expect(res.status).toBe(200);

    expect(engine.process).toHaveBeenCalledTimes(1);
    expect(engine.process.mock.calls[0][2]).toBe("restricted");
  });

  it("sends the engine 'owner' once a password is configured and the caller authenticated", async () => {
    const crypto = await import("node:crypto");
    const passwordHash = crypto.createHash("sha256").update("secret123").digest("hex");
    const engine = fakeEngine();
    handle = createServer({ port: 0, engine: engine as any, passwordHash });
    const addr = handle.server.address() as { port: number };

    const authRes = await fetch(`http://localhost:${addr.port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "secret123" }),
    });
    const { token } = (await authRes.json()) as { token: string };

    const res = await fetch(`http://localhost:${addr.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "привет" }),
    });
    expect(res.status).toBe(200);

    expect(engine.process).toHaveBeenCalledTimes(1);
    expect(engine.process.mock.calls[0][2]).toBe("owner");
  });
});

describe("GET /health", () => {
  it("answers 200 with a plain JSON body, not the SPA shell", async () => {
    handle = createServer({ port: 0 });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    // The public nginx block (deploy/nginx-ava-public.conf) proxies this
    // route straight to the open internet. If it ever fell through to
    // serveStatic()'s SPA fallback, an outside caller would receive the
    // control-panel's index.html — exactly what the stage rule forbids.
    const text = await res.text();
    expect(text).not.toContain("<html");
    expect(JSON.parse(text)).toEqual({ status: "ok" });
  });
});
