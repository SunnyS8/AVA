import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BitrixChannel } from "../../src/channels/bitrix/index.js";
import { planBitrixStartup } from "../../src/channels/bitrix/wiring.js";
import { BitrixTokenStore } from "../../src/channels/bitrix/tokens.js";
import { parseConfig } from "../../src/core/config.js";

const ACCESS = "install-access-token";
const REFRESH = "install-refresh-token";
const APP_TOKEN = "install-application-token";
const WEBHOOK = "https://example.bitrix24.ru/rest/6/secret/";
const CLIENT_ID = "local.0123456789abcdef";
const CLIENT_SECRET = "client-secret-placeholder";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function installBody(): string {
  const p = new URLSearchParams();
  p.set("event", "ONAPPINSTALL");
  p.set("auth[access_token]", ACCESS);
  p.set("auth[refresh_token]", REFRESH);
  p.set("auth[expires_in]", "3600");
  p.set("auth[domain]", "example.bitrix24.ru");
  p.set("auth[member_id]", "member-ours");
  p.set("auth[application_token]", APP_TOKEN);
  return p.toString();
}

function messageBody(applicationToken: string): string {
  const p = new URLSearchParams();
  p.set("event", "ONIMBOTMESSAGEADD");
  p.set("data[PARAMS][DIALOG_ID]", "chat42");
  p.set("data[PARAMS][FROM_USER_ID]", "17");
  p.set("data[PARAMS][MESSAGE]", "привет");
  p.set("data[PARAMS][AUTHOR_ID]", "17");
  p.set("auth[application_token]", applicationToken);
  return p.toString();
}

/** Every message a human reads must be Russian — this is the owner's console. */
const RUSSIAN = /[А-Яа-я]{4,}/;

describe("planBitrixStartup", () => {
  it("starts the channel with only the portal address and the application keys", () => {
    // The deployment deadlock this closes: application_token is born inside
    // ONAPPINSTALL, and only a running channel can receive that event.
    const plan = planBitrixStartup({
      webhook_url: WEBHOOK,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    expect(plan.start).toBe(true);
    expect(plan.state).toBe("awaiting-install");
    expect(plan.message).toMatch(RUSSIAN);
    expect(plan.message).toMatch(/установ/i);
  });

  it("says the bot still has to be registered once the install has landed", () => {
    const plan = planBitrixStartup({
      webhook_url: WEBHOOK,
      application_token: "config-application-token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    expect(plan.start).toBe(true);
    expect(plan.state).toBe("no-bot-id");
    expect(plan.message).toMatch(/bot_id/);
    expect(plan.message).toMatch(RUSSIAN);
  });

  it("reports full operation with the complete set", () => {
    const plan = planBitrixStartup({
      webhook_url: WEBHOOK,
      application_token: "config-application-token",
      bot_id: "42",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    expect(plan.start).toBe(true);
    expect(plan.state).toBe("ready");
    expect(plan.message).toMatch(RUSSIAN);
  });

  it("refuses without the application keys and names them", () => {
    const plan = planBitrixStartup({ webhook_url: WEBHOOK, client_id: CLIENT_ID });

    expect(plan.start).toBe(false);
    expect(plan.message).toMatch(/client_secret/);
    expect(plan.message).toMatch(RUSSIAN);
  });

  it("refuses without the portal address and names it", () => {
    const plan = planBitrixStartup({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET });

    expect(plan.start).toBe(false);
    expect(plan.message).toMatch(/webhook_url/);
    expect(plan.message).toMatch(RUSSIAN);
  });

  it("is what src/index.ts decides by", () => {
    // A guard living only in index.ts is a guard no test can reach; this keeps
    // the decision and its tests attached to each other.
    const source = fs.readFileSync(path.join(repoRoot, "src/index.ts"), "utf8");
    expect(source).toContain("planBitrixStartup");
  });
});

describe("config before the install", () => {
  it("keeps the bitrix section without an application_token", () => {
    // A required application_token made parseConfig strip the whole section
    // before the install could ever deliver one — the deadlock, one layer down.
    const config = parseConfig({
      agent: { name: "Ава" },
      bitrix: { webhook_url: WEBHOOK, client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
    });

    expect(config.bitrix?.webhook_url).toBe(WEBHOOK);
    expect(config.bitrix?.application_token).toBeUndefined();
  });
});

describe("BitrixChannel before the application is installed", () => {
  let dir: string;
  let store: BitrixTokenStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "betsy-bitrix-startup-"));
    store = new BitrixTokenStore(path.join(dir, "tokens.json"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startBare(): Promise<BitrixChannel> {
    const ch = new BitrixChannel({ tokenStore: store });
    ch.onMessage(async () => ({ text: "ответ" }));
    await ch.start({
      webhook_url: WEBHOOK,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    return ch;
  }

  it("starts without application_token and without bot_id, and takes the install", async () => {
    const ch = await startBare();

    expect(ch.handleWebhook(installBody()).status).toBe(200);
    expect(store.load()!.applicationToken).toBe(APP_TOKEN);
  });

  it("refuses to send without a bot_id, in plain Russian", async () => {
    const ch = await startBare();

    await expect(ch.send("chat42", { text: "привет" })).rejects.toThrow(/не зарегистрирован/);
    await expect(ch.send("chat42", { text: "привет" })).rejects.toThrow(RUSSIAN);
  });

  it("still rejects an ordinary event when no key exists anywhere", async () => {
    // Deny by default. Nothing stored, nothing in the config — the only event
    // that gets through without a key is the install itself.
    const ch = await startBare();

    expect(store.load()).toBeNull();
    expect(ch.handleWebhook(messageBody("tok")).status).toBe(401);
  });

  it("verifies ordinary events against the installed key right after the install", async () => {
    const ch = await startBare();
    ch.handleWebhook(installBody());

    expect(ch.handleWebhook(messageBody(APP_TOKEN)).status).toBe(200);
    expect(ch.handleWebhook(messageBody("wrong-token")).status).toBe(401);
  });

  it("still refuses to start without the application keys", async () => {
    const ch = new BitrixChannel({ tokenStore: store });
    ch.onMessage(async () => ({ text: "ответ" }));

    const start = ch.start({ webhook_url: WEBHOOK });

    await expect(start).rejects.toThrow(/client_id/);
    await expect(start).rejects.toThrow(RUSSIAN);
  });

  it("works exactly as before with the full set", async () => {
    const sent: Array<{ dialogId: string; text: string }> = [];
    const client = {
      sendMessage: async (dialogId: string, text: string) => {
        sent.push({ dialogId, text });
      },
    };
    const ch = new BitrixChannel({ client: client as never, tokenStore: store });
    ch.onMessage(async () => ({ text: "ответ" }));
    await ch.start({
      webhook_url: WEBHOOK,
      application_token: "config-application-token",
      bot_id: "42",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    expect(ch.handleWebhook(messageBody("config-application-token")).status).toBe(200);
    await ch.idle();
    expect(sent).toEqual([{ dialogId: "chat42", text: "ответ" }]);

    await ch.send("chat42", { text: "напоминание" });
    expect(sent).toHaveLength(2);
  });
});
