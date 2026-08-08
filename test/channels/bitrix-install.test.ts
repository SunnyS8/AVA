import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseInstallEvent } from "../../src/channels/bitrix/event.js";
import { BitrixChannel } from "../../src/channels/bitrix/index.js";
import { BitrixTokenStore, type BitrixTokens } from "../../src/channels/bitrix/tokens.js";

const ACCESS = "install-access-token";
const REFRESH = "install-refresh-token";
const APP_TOKEN = "install-application-token";

/**
 * A real ONAPPINSTALL body: form-encoded, bracketed `auth[...]` keys.
 * Pass null in `over` to drop a field, a string to replace it.
 */
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

/**
 * An ordinary message from an installed application. Note it carries the SAME
 * full auth block as the install event — the portal sends it with every event
 * once the app is installed. Presence of tokens therefore cannot be what tells
 * an install apart from a message.
 */
function messageBody(): string {
  const p = new URLSearchParams();
  p.set("event", "ONIMBOTMESSAGEADD");
  p.set("data[PARAMS][DIALOG_ID]", "chat42");
  p.set("data[PARAMS][FROM_USER_ID]", "17");
  p.set("data[PARAMS][MESSAGE]", "привет");
  p.set("data[PARAMS][AUTHOR_ID]", "17");
  p.set("auth[access_token]", ACCESS);
  p.set("auth[refresh_token]", REFRESH);
  p.set("auth[expires_in]", "3600");
  p.set("auth[domain]", "example.bitrix24.ru");
  p.set("auth[member_id]", "member-ours");
  p.set("auth[application_token]", "tok");
  return p.toString();
}

describe("parseInstallEvent", () => {
  it("pulls all six fields out of a real install body", () => {
    const install = parseInstallEvent(installBody())!;
    expect(install).not.toBeNull();
    expect(install.accessToken).toBe(ACCESS);
    expect(install.refreshToken).toBe(REFRESH);
    expect(install.expiresIn).toBe(3600);
    expect(install.domain).toBe("example.bitrix24.ru");
    expect(install.memberId).toBe("member-ours");
    expect(install.applicationToken).toBe(APP_TOKEN);
  });

  it("returns null on a body carrying no tokens at all", () => {
    expect(parseInstallEvent("")).toBeNull();
    expect(parseInstallEvent("event=ONAPPINSTALL")).toBeNull();
    expect(parseInstallEvent("hello=world")).toBeNull();
  });

  it("returns null when access_token is there but refresh_token is not", () => {
    // Half an install is not an install: without a refresh token the pair
    // dies in an hour with no way back, so it must not be stored at all.
    expect(parseInstallEvent(installBody({ "auth[refresh_token]": null }))).toBeNull();
  });
});

describe("BitrixChannel install handling", () => {
  let dir: string;
  let filePath: string;
  let store: BitrixTokenStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "betsy-bitrix-install-"));
    filePath = path.join(dir, "tokens.json");
    store = new BitrixTokenStore(filePath);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeChannel() {
    const sent: Array<{ dialogId: string; text: string }> = [];
    const client = {
      sendMessage: async (dialogId: string, text: string) => {
        sent.push({ dialogId, text });
      },
    };
    const ch = new BitrixChannel({
      applicationToken: "tok",
      botId: "42",
      client: client as never,
      tokenStore: store,
    });
    return { ch, sent };
  }

  it("saves the tokens and answers 200", () => {
    const { ch } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));

    const before = Date.now();
    const res = ch.handleWebhook(installBody());
    const after = Date.now();

    expect(res.status).toBe(200);

    const saved = store.load()!;
    expect(saved).not.toBeNull();
    expect(saved.accessToken).toBe(ACCESS);
    expect(saved.refreshToken).toBe(REFRESH);
    expect(saved.domain).toBe("example.bitrix24.ru");
    expect(saved.memberId).toBe("member-ours");
    // expiresAt is computed from the current time plus expires_in, never
    // left as the raw 3600.
    expect(saved.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(saved.expiresAt).toBeLessThanOrEqual(after + 3600_000);
  });

  it("does not queue the install event and does not call the model", async () => {
    const { ch, sent } = makeChannel();
    const asked = vi.fn().mockResolvedValue({ text: "ответ" });
    ch.onMessage(asked);

    const res = ch.handleWebhook(installBody());
    expect(res.status).toBe(200);

    await ch.idle();
    expect(asked).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("keeps the working tokens when an install comes from another portal", () => {
    const ours: BitrixTokens = {
      accessToken: "working-access",
      refreshToken: "working-refresh",
      expiresAt: Date.now() + 3600_000,
      domain: "ours.bitrix24.ru",
      memberId: "member-ours",
    };
    store.save(ours);

    const { ch } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));

    const res = ch.handleWebhook(
      installBody({ "auth[member_id]": "member-theirs", "auth[domain]": "theirs.bitrix24.ru" }),
    );
    expect(res.status).toBe(200);

    // Untouched, byte for byte: a stranger's install must not evict the
    // portal we actually serve.
    expect(store.load()).toEqual(ours);
  });

  it("accepts a re-install of the same portal", () => {
    store.save({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 1000,
      domain: "example.bitrix24.ru",
      memberId: "member-ours",
    });

    const { ch } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    ch.handleWebhook(installBody());

    expect(store.load()!.accessToken).toBe(ACCESS);
  });

  it("keeps neither tokens nor the application key out of the log", () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    try {
      const { ch } = makeChannel();
      ch.onMessage(async () => ({ text: "ответ" }));
      ch.handleWebhook(installBody());
      ch.handleWebhook(installBody({ "auth[member_id]": "member-theirs" }));
      ch.handleWebhook(installBody({ "auth[refresh_token]": null }));

      const logged = spies
        .flatMap((s) => s.mock.calls)
        .map((c) => c.map(String).join(" "))
        .join("\n");
      expect(logged).not.toContain(ACCESS);
      expect(logged).not.toContain(REFRESH);
      expect(logged).not.toContain(APP_TOKEN);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("still handles an ordinary message the way it did before", async () => {
    const { ch, sent } = makeChannel();
    const asked = vi.fn().mockResolvedValue({ text: "ответ" });
    ch.onMessage(asked);

    const res = ch.handleWebhook(messageBody());
    expect(res.status).toBe(200);

    await ch.idle();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked.mock.calls[0][0]).toMatchObject({
      channelName: "bitrix",
      userId: "17",
      text: "привет",
    });
    expect(sent).toEqual([{ dialogId: "chat42", text: "ответ" }]);
    // A message is not an install: the auth block it carries must not be
    // mistaken for one and written to the token file.
    expect(store.load()).toBeNull();
  });
});
