import { describe, it, expect, vi } from "vitest";
import { BitrixChannel } from "../../src/channels/bitrix/index.js";

function body(opts: { token?: string; text?: string; author?: string; chatType?: string; fromUserId?: string } = {}) {
  const p = new URLSearchParams();
  p.set("event", "ONIMBOTMESSAGEADD");
  p.set("data[PARAMS][DIALOG_ID]", "chat42");
  p.set("data[PARAMS][FROM_USER_ID]", opts.fromUserId ?? "17");
  p.set("data[PARAMS][MESSAGE]", opts.text ?? "привет");
  p.set("auth[application_token]", opts.token ?? "tok");
  if (opts.author) p.set("data[PARAMS][AUTHOR_ID]", opts.author);
  if (opts.chatType !== undefined) p.set("data[PARAMS][CHAT_TYPE]", opts.chatType);
  return p.toString();
}

function makeChannel() {
  const sent: Array<{ dialogId: string; text: string }> = [];
  const client = { sendMessage: async (dialogId: string, text: string) => { sent.push({ dialogId, text }); } };
  const ch = new BitrixChannel({ applicationToken: "tok", botId: "42", client: client as never });
  return { ch, sent };
}

describe("BitrixChannel", () => {
  it("has the channel name and required config", () => {
    const { ch } = makeChannel();
    expect(ch.name).toBe("bitrix");
    expect(ch.requiredConfig).toContain("webhook_url");
    expect(ch.requiredConfig).toContain("client_id");
    expect(ch.requiredConfig).toContain("client_secret");
    // Deliberately NOT required to start: both are produced by an install and
    // a registration that only a running channel can carry out.
    expect(ch.requiredConfig).not.toContain("application_token");
    expect(ch.requiredConfig).not.toContain("bot_id");
  });

  it("answers 200 immediately and replies into the same dialog", async () => {
    const { ch, sent } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));

    const res = ch.handleWebhook(body());
    expect(res.status).toBe(200);

    await ch.idle();
    expect(sent).toEqual([{ dialogId: "chat42", text: "ответ" }]);
  });

  it("passes the author id through as userId", async () => {
    const { ch } = makeChannel();
    const seen = vi.fn().mockResolvedValue({ text: "ok" });
    ch.onMessage(seen);
    ch.handleWebhook(body());
    await ch.idle();
    expect(seen.mock.calls[0][0]).toMatchObject({ channelName: "bitrix", userId: "17", text: "привет" });
  });

  it("rejects a forged token with 401 and answers nothing", async () => {
    const { ch, sent } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    const res = ch.handleWebhook(body({ token: "forged" }));
    expect(res.status).toBe(401);
    await ch.idle();
    expect(sent).toEqual([]);
  });

  it("never answers its own bot — the anti-loop guard", async () => {
    const { ch, sent } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    // botId канала — "42": сообщение с таким автором написали мы сами
    const res = ch.handleWebhook(body({ author: "42" }));
    expect(res.status).toBe(200);
    await ch.idle();
    expect(sent).toEqual([]);
  });

  it("ignores portal system messages", async () => {
    const { ch, sent } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    const res = ch.handleWebhook(body({ author: "0" }));
    expect(res.status).toBe(200);
    await ch.idle();
    expect(sent).toEqual([]);
  });

  it("does answer a human whose author id is neither the bot nor zero", async () => {
    const { ch, sent } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    ch.handleWebhook(body({ author: "17" }));
    await ch.idle();
    expect(sent).toEqual([{ dialogId: "chat42", text: "ответ" }]);
  });

  it("ignores group chats (CHAT_TYPE=C) — spec says private dialogs only", async () => {
    const { ch, sent } = makeChannel();
    const asked = vi.fn().mockResolvedValue({ text: "ответ" });
    ch.onMessage(asked);
    const res = ch.handleWebhook(body({ chatType: "C" }));
    expect(res.status).toBe(200);
    await ch.idle();
    expect(asked).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("answers a private dialog (CHAT_TYPE=P)", async () => {
    const { ch, sent } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    const res = ch.handleWebhook(body({ chatType: "P" }));
    expect(res.status).toBe(200);
    await ch.idle();
    expect(sent).toEqual([{ dialogId: "chat42", text: "ответ" }]);
  });

  it("answers when CHAT_TYPE is absent — defaults to private, not silence", async () => {
    const { ch, sent } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    const res = ch.handleWebhook(body());
    expect(res.status).toBe(200);
    await ch.idle();
    expect(sent).toEqual([{ dialogId: "chat42", text: "ответ" }]);
  });

  it("answers 400 on a body that is not an event", () => {
    const { ch } = makeChannel();
    ch.onMessage(async () => ({ text: "ответ" }));
    expect(ch.handleWebhook("garbage=1").status).toBe(400);
  });

  it("starts without a bot id but refuses to send — the anti-loop guard depends on it", async () => {
    // The guard compares the sender against our own bot id, so without one it
    // cannot tell our messages from anyone else's. Starting is still required
    // (the install event has to reach us somehow), so the protection moved to
    // the other end: nothing can be sent, therefore nothing of ours exists in
    // the portal to loop against. An injected client does not bypass this.
    const ch = new BitrixChannel({ client: { sendMessage: async () => {} } as never });
    ch.onMessage(async () => ({ text: "ok" }));

    await ch.start({
      webhook_url: "https://p.bitrix24.ru/rest/6/secret/",
      application_token: "tok",
      bot_id: "",
    });

    await expect(ch.send("chat42", { text: "привет" })).rejects.toThrow(/bot_id|не зарегистрирован/);
  });

  it("does not call the engine on an empty message", async () => {
    const { ch, sent } = makeChannel();
    const asked = vi.fn().mockResolvedValue({ text: "ответ" });
    ch.onMessage(asked);
    const res = ch.handleWebhook(body({ text: "" }));
    expect(res.status).toBe(200);
    await ch.idle();
    expect(asked).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("ignores an event with no sender — an empty id would key the scheduler's context to the wrong dialog", async () => {
    const { ch, sent } = makeChannel();
    const asked = vi.fn().mockResolvedValue({ text: "ответ" });
    ch.onMessage(asked);
    const res = ch.handleWebhook(body({ fromUserId: "" }));
    expect(res.status).toBe(200);
    await ch.idle();
    expect(asked).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
