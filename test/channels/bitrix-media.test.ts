import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BitrixChannel } from "../../src/channels/bitrix/index.js";
import { BitrixClient } from "../../src/channels/bitrix/client.js";
import { MAX_MEDIA_BYTES } from "../../src/channels/bitrix/media.js";
import type { BitrixTokens } from "../../src/channels/bitrix/tokens.js";

const ACCESS = "access-token-secret";
const REFRESH = "refresh-token-secret";
const CLIENT_SECRET = "client-secret-secret";
const APP_TOKEN = "application-token-secret";

function tokens(): BitrixTokens {
  return {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: Date.now() + 3_600_000,
    domain: "example.bitrix24.ru",
    memberId: "member-1",
    applicationToken: APP_TOKEN,
  };
}

function makeStore() {
  const store = {
    current: tokens() as BitrixTokens | null,
    load: () => store.current,
    save: vi.fn((t: BitrixTokens) => {
      store.current = t;
    }),
    isExpired: (t: BitrixTokens, now: number = Date.now()) => now >= t.expiresAt - 60_000,
  };
  return store;
}

/** One recorded portal call: which method, with which body. */
interface Call {
  method: string;
  body: Record<string, unknown>;
}

type Answer = { ok?: boolean; status?: number; json: unknown };

/**
 * A portal stand-in: routes by method name out of the REST URL and answers
 * from `answers`, defaulting to a plain success. Every call is recorded, so a
 * test can assert both WHAT was called and IN WHICH ORDER.
 */
function makePortal(answers: Record<string, Answer> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
    const method = String(url).replace(/^.*\/rest\//, "").replace(/\.json$/, "");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, body });
    const answer = answers[method] ?? { json: { result: defaultResult(method) } };
    return {
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      text: async () => JSON.stringify(answer.json),
    };
  });
  return { calls, fetchMock, methods: () => calls.map((c) => c.method) };
}

function defaultResult(method: string): unknown {
  switch (method) {
    case "im.dialog.get":
      return { id: 777, dialog_id: "17" };
    case "im.disk.folder.get":
      return { ID: 500 };
    case "disk.folder.uploadfile":
      return { ID: 900, NAME: "media.mp4" };
    default:
      return true;
  }
}

function makeChannel(fetchMock: ReturnType<typeof vi.fn>) {
  const client = new BitrixClient({
    tokens: makeStore(),
    botId: "42",
    clientId: "local.app.id",
    clientSecret: CLIENT_SECRET,
    fetchImpl: fetchMock as unknown as typeof fetch,
    refreshImpl: vi.fn(async () => tokens()) as never,
  });
  return new BitrixChannel({ applicationToken: APP_TOKEN, botId: "42", client });
}

/** The text of every imbot.message.add in the recorded calls. */
function messages(calls: Call[]): string[] {
  return calls.filter((c) => c.method === "imbot.message.add").map((c) => String(c.body.MESSAGE));
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ava-media-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeMedia(name: string, size = 1024): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, Buffer.alloc(size, 7));
  return file;
}

describe("BitrixChannel media delivery", () => {
  it("sends a plain text answer exactly as before — one message, no disk calls", async () => {
    const { calls, fetchMock, methods } = makePortal();
    const ch = makeChannel(fetchMock);

    await ch.send("chat42", { text: "привет" });

    expect(methods()).toEqual(["imbot.message.add"]);
    expect(calls[0].body).toMatchObject({ BOT_ID: "42", DIALOG_ID: "chat42", MESSAGE: "привет" });
  });

  it("uploads a local file into the chat folder and commits it, in that order", async () => {
    const { calls, fetchMock, methods } = makePortal();
    const ch = makeChannel(fetchMock);
    const file = writeMedia("krug.mp4");

    await ch.send("chat42", { text: "вот кружочек", mode: "video", mediaPath: file });

    expect(methods()).toEqual(["im.disk.folder.get", "disk.folder.uploadfile", "im.disk.file.commit"]);

    const [folder, upload, commit] = calls;
    // CHAT_ID из dialogId вида chatNN — без лишнего похода в портал.
    expect(folder.body.CHAT_ID).toBe(42);
    expect(upload.body.id).toBe(500);
    expect((upload.body.data as Record<string, unknown>).NAME).toBe("krug.mp4");
    const content = upload.body.fileContent as [string, string];
    expect(content[0]).toBe("krug.mp4");
    expect(Buffer.from(content[1], "base64").length).toBe(1024);
    expect(commit.body.CHAT_ID).toBe(42);
    expect(commit.body.DISK_ID).toBe(900);
  });

  it("does not lose the text when media goes out", async () => {
    const { calls, fetchMock } = makePortal();
    const ch = makeChannel(fetchMock);

    await ch.send("chat42", { text: "вот кружочек", mediaPath: writeMedia("krug.mp4") });

    const commit = calls.find((c) => c.method === "im.disk.file.commit");
    expect(String(commit!.body.MESSAGE)).toContain("вот кружочек");
  });

  it("explains itself in Russian when the portal has no disk right — and still delivers the text", async () => {
    const { calls, fetchMock } = makePortal({
      "disk.folder.uploadfile": {
        ok: false,
        status: 401,
        json: { error: "insufficient_scope", error_description: "the app has no disk scope" },
      },
    });
    const ch = makeChannel(fetchMock);

    await expect(ch.send("chat42", { text: "вот кружочек", mode: "video", mediaPath: writeMedia("krug.mp4") })).resolves.toBeUndefined();

    const said = messages(calls);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("вот кружочек");
    expect(said[0]).toMatch(/[А-Яа-я]/);
    expect(said[0]).toMatch(/не получилось|не могу|не умею/);
    // Человеку — по-человечески: ни кода ошибки, ни английского из портала.
    expect(said[0]).not.toContain("insufficient_scope");
    expect(said[0]).not.toContain("disk");
  });

  it("explains itself when the file is gone from disk, instead of throwing", async () => {
    const { calls, fetchMock, methods } = makePortal();
    const ch = makeChannel(fetchMock);

    await expect(
      ch.send("chat42", { text: "вот кружочек", mode: "video", mediaPath: path.join(tmpDir, "nope.mp4") }),
    ).resolves.toBeUndefined();

    // Портал файловыми методами не тревожим — грузить нечего.
    expect(methods()).toEqual(["imbot.message.add"]);
    const said = messages(calls);
    expect(said[0]).toContain("вот кружочек");
    expect(said[0]).toMatch(/[А-Яа-я]/);
  });

  it("refuses an over-sized file in words instead of reading it into memory", async () => {
    const { calls, fetchMock, methods } = makePortal();
    const ch = makeChannel(fetchMock);
    const big = writeMedia("big.mp4", MAX_MEDIA_BYTES + 1);

    await expect(ch.send("chat42", { text: "вот кружочек", mediaPath: big })).resolves.toBeUndefined();

    expect(methods()).toEqual(["imbot.message.add"]);
    const said = messages(calls);
    expect(said[0]).toContain("вот кружочек");
    expect(said[0]).toMatch(/МБ|тяж/);
  });

  it("resolves a personal dialog id through im.dialog.get", async () => {
    const { calls, fetchMock, methods } = makePortal();
    const ch = makeChannel(fetchMock);

    await ch.send("17", { text: "вот кружочек", mediaPath: writeMedia("krug.mp4") });

    expect(methods()).toEqual([
      "im.dialog.get",
      "im.disk.folder.get",
      "disk.folder.uploadfile",
      "im.disk.file.commit",
    ]);
    expect(calls[0].body.DIALOG_ID).toBe("17");
    // Личный диалог — это тоже чат, но его номер знает только портал.
    expect(calls[1].body.CHAT_ID).toBe(777);
    expect(calls[3].body.CHAT_ID).toBe(777);
  });

  it("takes the chat id straight out of a chatNN dialog id", async () => {
    const { calls, fetchMock, methods } = makePortal();
    const ch = makeChannel(fetchMock);

    await ch.send("chat18452", { text: "файл", mediaPath: writeMedia("doc.pdf") });

    expect(methods()).not.toContain("im.dialog.get");
    expect(calls[0].body.CHAT_ID).toBe(18452);
  });

  it("answers a webhook with media the same way it answers with text", async () => {
    const { calls, fetchMock, methods } = makePortal();
    const ch = makeChannel(fetchMock);
    const file = writeMedia("krug.mp4");
    ch.onMessage(async () => ({ text: "вот кружочек", mode: "video" as const, mediaPath: file }));

    const p = new URLSearchParams();
    p.set("event", "ONIMBOTMESSAGEADD");
    p.set("data[PARAMS][DIALOG_ID]", "chat42");
    p.set("data[PARAMS][FROM_USER_ID]", "17");
    p.set("data[PARAMS][MESSAGE]", "сделай кружочек");
    p.set("auth[application_token]", APP_TOKEN);

    expect(ch.handleWebhook(p.toString()).status).toBe(200);
    await ch.idle();

    expect(methods()).toEqual(["im.disk.folder.get", "disk.folder.uploadfile", "im.disk.file.commit"]);
    expect(String(calls[2].body.MESSAGE)).toContain("вот кружочек");
  });

  it("sends a data: URL as a file", async () => {
    const { calls, fetchMock, methods } = makePortal();
    const ch = makeChannel(fetchMock);
    const base64 = Buffer.from("картинка").toString("base64");

    await ch.send("chat42", { text: "селфи", mode: "selfie", mediaUrl: `data:image/jpeg;base64,${base64}` });

    expect(methods()).toEqual(["im.disk.folder.get", "disk.folder.uploadfile", "im.disk.file.commit"]);
    const upload = calls[1];
    expect(String((upload.body.data as Record<string, unknown>).NAME)).toMatch(/\.jpg$/);
  });

  it("explains itself when a media reference is of a kind it cannot fetch", async () => {
    const { calls, fetchMock, methods } = makePortal();
    const ch = makeChannel(fetchMock);

    await expect(ch.send("chat42", { text: "селфи", mode: "selfie", mediaUrl: "ftp://example.org/a.jpg" })).resolves.toBeUndefined();

    expect(methods()).toEqual(["imbot.message.add"]);
    expect(messages(calls)[0]).toContain("селфи");
    expect(messages(calls)[0]).toMatch(/[А-Яа-я]/);
  });
});

describe("BitrixClient.sendFile", () => {
  function makeClient(fetchMock: ReturnType<typeof vi.fn>) {
    return new BitrixClient({
      tokens: makeStore(),
      botId: "42",
      clientId: "local.app.id",
      clientSecret: CLIENT_SECRET,
      fetchImpl: fetchMock as unknown as typeof fetch,
      refreshImpl: vi.fn(async () => tokens()) as never,
    });
  }

  it("keeps tokens and the application key out of every media failure message", async () => {
    const leaks = [ACCESS, REFRESH, CLIENT_SECRET, APP_TOKEN];
    const cases: Array<Record<string, Answer>> = [
      {
        "disk.folder.uploadfile": {
          ok: false,
          status: 401,
          json: { error: "insufficient_scope", error_description: `no disk scope for auth=${ACCESS}` },
        },
      },
      { "im.disk.folder.get": { ok: false, status: 500, json: { error_description: ACCESS } } },
      { "im.disk.file.commit": { json: { error: "CHAT_NOT_FOUND", error_description: `token ${ACCESS}` } } },
      { "im.dialog.get": { json: { error: "DIALOG_ID_EMPTY", error_description: APP_TOKEN } } },
    ];

    for (const answers of cases) {
      const { fetchMock } = makePortal(answers);
      const err = await makeClient(fetchMock)
        .sendFile("17", { name: "krug.mp4", bytes: Buffer.alloc(8) }, "текст")
        .then(
          () => null,
          (e: Error) => e,
        );
      expect(err).toBeInstanceOf(Error);
      for (const secret of leaks) expect(err!.message).not.toContain(secret);
      expect(err!.stack ?? "").not.toContain(ACCESS);
    }
  });

  it("names the portal error code so a log says what happened", async () => {
    const { fetchMock } = makePortal({
      "disk.folder.uploadfile": { ok: false, status: 401, json: { error: "insufficient_scope" } },
    });
    await expect(
      makeClient(fetchMock).sendFile("chat42", { name: "a.mp4", bytes: Buffer.alloc(8) }, "текст"),
    ).rejects.toThrow(/insufficient_scope/);
  });
});
