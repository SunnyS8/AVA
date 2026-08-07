import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDB, closeDB } from "../../../src/core/memory/db.js";
import { ConnectServiceTool } from "../../../src/core/tools/connect-service.js";
import { TokenStore } from "../../../src/services/tokens.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("ConnectServiceTool", () => {
  const testDbPath = path.join(os.tmpdir(), `betsy-test-connect-${Date.now()}.db`);
  const encKey = "b55c8792d1ce458e279308835f8a97b580263503e76e1998e279703e35ad0c2e";
  let tool: ConnectServiceTool;

  beforeEach(() => {
    closeDB();
    getDB(testDbPath);
    tool = new ConnectServiceTool({ encryptionKey: encKey });
  });

  afterEach(() => {
    closeDB();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
    try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
  });

  it("has correct tool interface", () => {
    expect(tool.name).toBe("connect_service");
    expect(tool.parameters.length).toBeGreaterThan(0);
  });

  it("action=list returns available services", async () => {
    const result = await tool.execute({ action: "list", _userId: "test" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Google");
    expect(result.output).toContain("GitHub");
    expect(result.output).toContain("ВКонтакте");
  });

  it("action=status shows no connections initially", async () => {
    const result = await tool.execute({ action: "status", _userId: "test" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Нет подключённых сервисов");
  });

  it("action=disconnect removes token", async () => {
    const store = new TokenStore(encKey);
    store.save({ serviceId: "google", userId: "test", accessToken: "t", scopes: "gmail", expiresAt: 9999999999 });
    const result = await tool.execute({ action: "disconnect", service: "google", _userId: "test" });
    expect(result.success).toBe(true);
    expect(store.get("google", "test")).toBeNull();
  });

  it("action=connect fails for unknown service", async () => {
    const result = await tool.execute({ action: "connect", service: "unknown", _userId: "test" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Неизвестный сервис");
  });

  it("action=connect without service returns error", async () => {
    const result = await tool.execute({ action: "connect", _userId: "test" });
    expect(result.success).toBe(false);
  });

  describe("onConnected chatId — Engine.executeTool -> ConnectServiceTool wiring", () => {
    // Engine injects _chatId the same way it injects _userId/_channelName
    // (see src/core/engine.ts executeTool). This tool must forward whichever
    // one it got through to onConnected, since that's what connect-notify.ts
    // uses to address the reply (see src/channels/connect-notify.ts) — a
    // group chat and the sender who typed /connect are not the same thing.
    function mockOAuthFlow(instanceId: string, accessToken: string) {
      return vi.fn()
        // handleConnect: POST {relayUrl}/start/{service}
        .mockResolvedValueOnce({ ok: true, json: async () => ({ instance_id: instanceId, auth_url: "https://auth.example/x" }) })
        // pollForToken: GET {relayUrl}/poll/{instanceId} — completes on first poll
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "complete", access_token: accessToken }) })
        // verifyConnection: test request against the service API
        .mockResolvedValueOnce({ ok: true });
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("falls back to _userId when the engine did not inject _chatId", async () => {
      const onConnected = vi.fn();
      const withCallback = new ConnectServiceTool({ encryptionKey: encKey, onConnected });
      vi.stubGlobal("fetch", mockOAuthFlow("inst1", "tok1"));

      const result = await withCallback.execute({ action: "connect", service: "google", _userId: "sender-1" });
      expect(result.success).toBe(true);

      // pollForToken waits 3s (POLL_INTERVAL) before its first poll — real
      // timers avoid the flakiness of faking a setTimeout loop nested inside
      // chained promises.
      await new Promise((r) => setTimeout(r, 3200));

      expect(onConnected).toHaveBeenCalledTimes(1);
      const [userIdArg, , , , chatIdArg] = onConnected.mock.calls[0];
      expect(userIdArg).toBe("sender-1");
      expect(chatIdArg).toBe("sender-1"); // fallback path: params._chatId ?? params._userId
    }, 10000);

    it("prefers _chatId over the sender when the engine injected both (group chat)", async () => {
      const onConnected = vi.fn();
      const withCallback = new ConnectServiceTool({ encryptionKey: encKey, onConnected });
      vi.stubGlobal("fetch", mockOAuthFlow("inst2", "tok2"));

      const result = await withCallback.execute({
        action: "connect",
        service: "google",
        _userId: "sender-1",
        _chatId: "-500",
      });
      expect(result.success).toBe(true);

      await new Promise((r) => setTimeout(r, 3200));

      expect(onConnected).toHaveBeenCalledTimes(1);
      const [userIdArg, , , , chatIdArg] = onConnected.mock.calls[0];
      expect(userIdArg).toBe("sender-1"); // token storage still keyed by sender
      expect(chatIdArg).toBe("-500"); // reply address is the group, not the sender
    }, 10000);
  });
});
