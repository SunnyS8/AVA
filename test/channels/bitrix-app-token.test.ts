import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BitrixChannel } from "../../src/channels/bitrix/index.js";
import {
  BitrixTokenStore,
  createBitrixTokenStore,
  type BitrixTokens,
} from "../../src/channels/bitrix/tokens.js";
import { BitrixClient, type BitrixTokenSource } from "../../src/channels/bitrix/client.js";
import { getConfigDir, parseConfig } from "../../src/core/config.js";

const ACCESS = "install-access-token";
const REFRESH = "install-refresh-token";
const APP_TOKEN = "install-application-token";
const CONFIG_TOKEN = "config-application-token";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function installBody(over: Record<string, string | null> = {}): string {
  const fields: Record<string, string> = {
    event: "ONAPPINSTALL",
    "auth[access_token]": ACCESS,
    "auth[refresh_token]": REFRESH,
    "auth[expires_in]": "3600",
    "auth[domain]": "example.bitrix24.ru",
    "auth[member_id]": "member-ours",
    "auth[application_token]": APP_TOKEN,
  };
  for (const [key, value] of Object.entries(over)) {
    if (value === null) delete fields[key];
    else fields[key] = value;
  }
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) p.set(key, value);
  return p.toString();
}

/** An ordinary message, signed with whatever application token is passed. */
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

describe("bitrix token store at the start point", () => {
  it("puts the token file next to the config, in the config directory", () => {
    const store = createBitrixTokenStore();
    expect(path.dirname(store.filePath)).toBe(getConfigDir());
    expect(path.basename(store.filePath)).toMatch(/bitrix/);
  });

  it("is what src/index.ts hands to the channel", () => {
    // Gap this closes: index.ts used to build `new BitrixChannel()` with no
    // store at all, so a real portal install landed in the "no token store
    // configured" branch and the tokens were dropped on the floor.
    const source = fs.readFileSync(path.join(repoRoot, "src/index.ts"), "utf8");
    expect(source).toContain("createBitrixTokenStore");
    const construction = source.match(/new BitrixChannel\(([\s\S]*?)\);/);
    expect(construction).not.toBeNull();
    expect(construction![1]).toContain("tokenStore");
  });
});

describe("bitrix application credentials in the config", () => {
  it("parses client_id and client_secret out of the bitrix section", () => {
    const config = parseConfig({
      agent: { name: "Ава" },
      bitrix: {
        webhook_url: "https://example.bitrix24.ru/rest/6/secret/",
        application_token: CONFIG_TOKEN,
        bot_id: 42,
        client_id: "local.0123456789abcdef",
        client_secret: "client-secret-placeholder",
      },
    });

    expect(config.bitrix?.client_id).toBe("local.0123456789abcdef");
    expect(config.bitrix?.client_secret).toBe("client-secret-placeholder");
  });

  it("refuses to start with a token store but no application keys, in Russian", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betsy-bitrix-keys-"));
    try {
      const ch = new BitrixChannel({ tokenStore: new BitrixTokenStore(path.join(dir, "tokens.json")) });
      ch.onMessage(async () => ({ text: "ответ" }));

      const start = ch.start({
        webhook_url: "https://example.bitrix24.ru/rest/6/secret/",
        application_token: CONFIG_TOKEN,
        bot_id: "42",
      });

      await expect(start).rejects.toThrow(/client_id/);
      await expect(start).rejects.toThrow(/[А-Яа-я]{4,}/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("application token from the install", () => {
  let dir: string;
  let store: BitrixTokenStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "betsy-bitrix-apptoken-"));
    store = new BitrixTokenStore(path.join(dir, "tokens.json"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeChannel(over: { tokenStore?: BitrixTokenStore } = {}) {
    const sent: Array<{ dialogId: string; text: string }> = [];
    const client = {
      sendMessage: async (dialogId: string, text: string) => {
        sent.push({ dialogId, text });
      },
    };
    const ch = new BitrixChannel({
      applicationToken: CONFIG_TOKEN,
      botId: "42",
      client: client as never,
      tokenStore: "tokenStore" in over ? over.tokenStore : store,
      portalDomain: "example.bitrix24.ru",
    });
    ch.onMessage(async () => ({ text: "ответ" }));
    return { ch, sent };
  }

  it("is stored together with the tokens", () => {
    const { ch } = makeChannel();
    expect(ch.handleWebhook(installBody()).status).toBe(200);
    expect(store.load()!.applicationToken).toBe(APP_TOKEN);
  });

  it("is what later events are verified against — not the config value", async () => {
    const { ch, sent } = makeChannel();
    ch.handleWebhook(installBody());

    expect(ch.handleWebhook(messageBody(APP_TOKEN)).status).toBe(200);
    await ch.idle();
    expect(sent).toEqual([{ dialogId: "chat42", text: "ответ" }]);

    // The config value is stale the moment the portal issues its own key:
    // accepting it too would leave a second, never-rotated way in.
    expect(ch.handleWebhook(messageBody(CONFIG_TOKEN)).status).toBe(401);
  });

  it("falls back to the config value when nothing is stored", async () => {
    // Keeps the webhook / hand-configured path working before any install.
    const { ch, sent } = makeChannel();
    expect(store.load()).toBeNull();

    expect(ch.handleWebhook(messageBody(CONFIG_TOKEN)).status).toBe(200);
    await ch.idle();
    expect(sent).toEqual([{ dialogId: "chat42", text: "ответ" }]);
  });
});

describe("BitrixTokenStore and the application token", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "betsy-bitrix-store-"));
    filePath = path.join(dir, "tokens.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still reads a token file written before the application token existed", () => {
    // Requiring the field would make every pre-existing install unreadable —
    // and an unreadable token file looks exactly like an uninstalled app.
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        accessToken: ACCESS,
        refreshToken: REFRESH,
        expiresAt: Date.now() + 3600_000,
        domain: "example.bitrix24.ru",
        memberId: "member-ours",
      }),
    );

    const loaded = new BitrixTokenStore(filePath).load();
    expect(loaded).not.toBeNull();
    expect(loaded!.accessToken).toBe(ACCESS);
    expect(loaded!.applicationToken).toBeUndefined();
  });
});

describe("token refresh and the application token", () => {
  /** In-memory stand-in for the store, with an already-dead access token. */
  function memoryStore(initial: BitrixTokens): { source: BitrixTokenSource; current: () => BitrixTokens } {
    let tokens = initial;
    return {
      source: {
        load: () => tokens,
        save: (t: BitrixTokens) => {
          tokens = t;
        },
        isExpired: () => true,
      },
      current: () => tokens,
    };
  }

  it("does not lose the application token when the pair is refreshed", async () => {
    // The portal does NOT return application_token on refresh. A naive
    // `save(fresh)` therefore wipes it an hour after the install, and every
    // event from then on is rejected — a failure that looks like "it worked
    // and then broke by itself".
    const { source, current } = memoryStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 1000,
      domain: "example.bitrix24.ru",
      memberId: "member-ours",
      applicationToken: APP_TOKEN,
    });

    const client = new BitrixClient({
      tokens: source,
      botId: "42",
      clientId: "local.0123456789abcdef",
      clientSecret: "client-secret-placeholder",
      fetchImpl: async () => new Response(JSON.stringify({ result: {} }), { status: 200 }),
      refreshImpl: async () => ({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: Date.now() + 3600_000,
        domain: "example.bitrix24.ru",
        memberId: "member-ours",
      }),
    });

    await client.sendMessage("chat42", "привет");

    expect(current().accessToken).toBe("new-access");
    expect(current().applicationToken).toBe(APP_TOKEN);
  });

  it("keeps the portal domain of the current tokens, whatever the refresh returns", async () => {
    // Second line of defence behind refreshTokens. The authorisation server
    // answers with its OWN host in `domain`; a refresh implementation that
    // passes that through once redirected every bot call to
    // https://oauth.bitrix.info/rest/… (404 ERROR_METHOD_NOT_FOUND) and the
    // bot went quiet an hour after the install. The client knows its portal —
    // nothing in a refresh answer may replace it.
    const { source, current } = memoryStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 1000,
      domain: "example.bitrix24.ru",
      memberId: "member-ours",
      applicationToken: APP_TOKEN,
    });

    const calledUrls: string[] = [];
    const client = new BitrixClient({
      tokens: source,
      botId: "42",
      clientId: "local.0123456789abcdef",
      clientSecret: "client-secret-placeholder",
      fetchImpl: async (input: RequestInfo | URL) => {
        calledUrls.push(String(input));
        return new Response(JSON.stringify({ result: {} }), { status: 200 });
      },
      refreshImpl: async () => ({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: Date.now() + 3600_000,
        domain: "oauth.bitrix.info",
        memberId: "member-ours",
      }),
    });

    await client.sendMessage("chat42", "привет");

    expect(current().domain).toBe("example.bitrix24.ru");
    expect(current().applicationToken).toBe(APP_TOKEN);
    expect(calledUrls).toEqual(["https://example.bitrix24.ru/rest/imbot.message.add.json"]);
    for (const url of calledUrls) expect(url).not.toContain("oauth.bitrix.info");
  });
});
