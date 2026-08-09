import { describe, it, expect, vi } from "vitest";
import { BitrixClient, clip } from "../../src/channels/bitrix/client.js";
import type { BitrixTokens } from "../../src/channels/bitrix/tokens.js";

const ACCESS = "access-token-secret";
const REFRESH = "refresh-token-secret";
const CLIENT_SECRET = "client-secret-secret";
const HOUR = 3_600_000;

function tokens(over: Partial<BitrixTokens> = {}): BitrixTokens {
  return {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: Date.now() + HOUR,
    domain: "example.bitrix24.ru",
    memberId: "member-1",
    ...over,
  };
}

/** In-memory stand-in for BitrixTokenStore: same three methods, no disk. */
function makeStore(initial: BitrixTokens | null = tokens()) {
  const store = {
    current: initial,
    load: () => store.current,
    save: vi.fn((t: BitrixTokens) => {
      store.current = t;
    }),
    isExpired: (t: BitrixTokens, now: number = Date.now()) => now >= t.expiresAt - 60_000,
  };
  return store;
}

const FRESH: BitrixTokens = {
  accessToken: "fresh-access",
  refreshToken: "fresh-refresh",
  expiresAt: Date.now() + HOUR,
  domain: "example.bitrix24.ru",
  memberId: "member-1",
};

function makeClient(
  fetchMock: ReturnType<typeof vi.fn>,
  store = makeStore(),
  refreshImpl = vi.fn(async () => FRESH),
) {
  const client = new BitrixClient({
    tokens: store,
    botId: "42",
    clientId: "local.app.id",
    clientSecret: CLIENT_SECRET,
    fetchImpl: fetchMock as unknown as typeof fetch,
    refreshImpl: refreshImpl as never,
  });
  return { client, store, refreshImpl };
}

const okOnce = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ result: 123 }) });
const expiredOnce = () => ({
  ok: false,
  status: 401,
  text: async () => JSON.stringify({ error: "expired_token", error_description: "The access token provided has expired" }),
});

describe("clip", () => {
  it("leaves a short text alone", () => {
    expect(clip("hello", 100)).toBe("hello");
  });

  it("keeps the head and the tail of a long text", () => {
    const long = "A".repeat(50) + "MIDDLE" + "B".repeat(50);
    const out = clip(long, 40);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("B")).toBe(true);
    expect(out).toContain("…");
  });
});

describe("BitrixClient", () => {
  it("calls the portal from the token store, authorised by the access token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okOnce());
    const { client } = makeClient(fetchMock);
    await client.sendMessage("chat42", "привет");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // Адрес строится из домена портала в хранилище, а не из вебхука: бот
    // принадлежит приложению, и вебхук владельца тут больше ни при чём.
    expect(url).toBe("https://example.bitrix24.ru/rest/imbot.message.add.json");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent.auth).toBe(ACCESS);
    // imbot.message.add — сообщение от имени бота. im.message.add отправил бы
    // его от имени владельца токена, и сотрудники увидели бы живого человека.
    expect(sent.BOT_ID).toBe("42");
    expect(sent.DIALOG_ID).toBe("chat42");
    expect(sent.MESSAGE).toBe("привет");
  });

  it("puts the token in the body, never in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okOnce());
    const { client } = makeClient(fetchMock);
    await client.sendMessage("chat42", "привет");

    const [url, init] = fetchMock.mock.calls[0];
    // Строка адреса оседает в журналах промежуточных узлов, тело — нет.
    expect(String(url)).not.toContain(ACCESS);
    expect(String(url)).not.toContain("auth");
    expect(init.body as string).toContain(ACCESS);
  });

  it("refreshes an already-expired token BEFORE sending", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okOnce());
    const store = makeStore(tokens({ expiresAt: Date.now() - 1000 }));
    const { client, refreshImpl } = makeClient(fetchMock, store);
    await client.sendMessage("chat42", "привет");

    expect(refreshImpl).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.auth).toBe(FRESH.accessToken);
  });

  it("refreshes once and retries when the portal answers expired_token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(expiredOnce()).mockResolvedValueOnce(okOnce());
    const { client, refreshImpl } = makeClient(fetchMock);
    await expect(client.sendMessage("chat42", "привет")).resolves.toBeUndefined();

    expect(refreshImpl).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).auth).toBe(ACCESS);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).auth).toBe(FRESH.accessToken);
  });

  it("gives up after one refresh instead of looping on expired_token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(expiredOnce());
    const { client, refreshImpl } = makeClient(fetchMock);
    await expect(client.sendMessage("chat42", "привет")).rejects.toThrow(/expired_token/);

    // Ровно одно обновление и ровно две попытки — иначе бесконечный цикл.
    expect(refreshImpl).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("saves refreshed tokens so the next start does not begin with dead ones", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(expiredOnce()).mockResolvedValueOnce(okOnce());
    const { client, store } = makeClient(fetchMock);
    await client.sendMessage("chat42", "привет");

    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.load()).toEqual(FRESH);
  });

  it("refuses to send when the application is not installed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okOnce());
    const { client } = makeClient(fetchMock, makeStore(null));
    await expect(client.sendMessage("chat42", "привет")).rejects.toThrow(/не установлено/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps tokens and the client secret out of every failure message", async () => {
    const leaks = [ACCESS, REFRESH, CLIENT_SECRET, FRESH.accessToken, FRESH.refreshToken];
    const expectClean = async (p: Promise<unknown>) => {
      const err = await p.then(
        () => null,
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      for (const secret of leaks) expect(err!.message).not.toContain(secret);
      expect(err!.stack ?? "").not.toContain(CLIENT_SECRET);
    };

    // HTTP failure.
    await expectClean(makeClient(vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" })).client.sendMessage("c", "hi"));

    // Network failure: fetch bakes the whole request into its message.
    const netMock = vi.fn().mockRejectedValue(new TypeError(`Failed to fetch: auth=${ACCESS}`));
    await expectClean(makeClient(netMock).client.sendMessage("c", "hi"));

    // Refresh failure on a proactive refresh.
    const expiredStore = makeStore(tokens({ expiresAt: Date.now() - 1000 }));
    const failingRefresh = vi.fn(async () => {
      throw new Error(`refresh blew up with client_secret=${CLIENT_SECRET} and ${REFRESH}`);
    });
    await expectClean(
      makeClient(vi.fn().mockResolvedValue(okOnce()), expiredStore, failingRefresh as never).client.sendMessage("c", "hi"),
    );

    // Refresh failure on the retry path.
    await expectClean(
      makeClient(vi.fn().mockResolvedValue(expiredOnce()), makeStore(), failingRefresh as never).client.sendMessage("c", "hi"),
    );

    // Store write failure after a successful refresh.
    const badStore = makeStore(tokens({ expiresAt: Date.now() - 1000 }));
    badStore.save = vi.fn(() => {
      throw Object.assign(new Error(`EACCES: cannot write ${FRESH.accessToken}`), { code: "EACCES" });
    });
    await expectClean(makeClient(vi.fn().mockResolvedValue(okOnce()), badStore).client.sendMessage("c", "hi"));

    // Non-JSON body and an application-level error field.
    await expectClean(makeClient(vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "<html>" })).client.sendMessage("c", "hi"));
    await expectClean(
      makeClient(
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ error: "BOT_ID_NOT_FOUND", error_description: `token ${ACCESS}` }),
        }),
      ).client.sendMessage("c", "hi"),
    );

    // Not installed.
    await expectClean(makeClient(vi.fn(), makeStore(null)).client.sendMessage("c", "hi"));
  });

  it("clips an over-long message before sending", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okOnce());
    const { client } = makeClient(fetchMock);
    await client.sendMessage("chat1", "x".repeat(9000));
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.MESSAGE.length).toBeLessThanOrEqual(8001);
    expect(sent.BOT_ID).toBe("42");
  });

  it("reports the HTTP status when the portal fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    const { client } = makeClient(fetchMock);
    await expect(client.sendMessage("chat1", "hi")).rejects.toThrow(/500/);
  });

  it("treats an error field in a 200 response as a failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error: "BOT_ID_NOT_FOUND", error_description: "no such bot" }),
    });
    const { client } = makeClient(fetchMock);
    await expect(client.sendMessage("chat1", "hi")).rejects.toThrow(/BOT_ID_NOT_FOUND/);
  });

  it("accepts a normal successful answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okOnce());
    const { client } = makeClient(fetchMock);
    await expect(client.sendMessage("chat1", "hi")).resolves.toBeUndefined();
  });

  it("does not cut an emoji in half when clipping", () => {
    const out = clip("😀".repeat(20), 11);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

/** One MP4 box: 4-byte size, 4-byte type, payload. */
function mp4Box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
}

/** A movie laid out the way fal.ai returns one: the index last. */
function moovLastMovie(): Buffer {
  const stcoBody = Buffer.alloc(12);
  stcoBody.writeUInt32BE(1, 4);
  stcoBody.writeUInt32BE(32, 8);
  const moov = mp4Box("moov", mp4Box("trak", mp4Box("mdia", mp4Box("minf", mp4Box("stbl", mp4Box("stco", stcoBody))))));
  return Buffer.concat([
    mp4Box("ftyp", Buffer.from("isomiso2avc1mp41", "latin1")),
    mp4Box("mdat", Buffer.from("media-payload")),
    moov,
  ]);
}

/** The four answers sendFile needs, in the order it asks for them. */
function fileUploadFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ result: { id: 7 } }) })
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ result: { ID: 55 } }) })
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ result: { ID: 900 } }) })
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ result: true }) });
}

/** The base64 payload of the upload call, decoded. */
function uploadedBytes(fetchMock: ReturnType<typeof vi.fn>): Buffer {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes("disk.folder.uploadfile"));
  const body = JSON.parse((call![1] as { body: string }).body) as { fileContent: [string, string] };
  return Buffer.from(body.fileContent[1], "base64");
}

describe("BitrixClient.sendFile", () => {
  it("uploads the video with its index moved to the front", async () => {
    const fetchMock = fileUploadFetch();
    const { client } = makeClient(fetchMock);

    await client.sendFile("6", { name: "krug.mp4", bytes: moovLastMovie() }, "готово");

    const sent = uploadedBytes(fetchMock);
    expect(sent.toString("latin1", 4, 8)).toBe("ftyp");
    // moov must now precede mdat: the portal makes no preview for a video, so
    // the chat plays the file itself and needs the index up front.
    expect(sent.indexOf("moov")).toBeLessThan(sent.indexOf("mdat"));
    expect(sent.length).toBe(moovLastMovie().length);
  });

  it("leaves a file that is not a moov-last MP4 exactly as it was", async () => {
    const fetchMock = fileUploadFetch();
    const { client } = makeClient(fetchMock);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

    await client.sendFile("6", { name: "selfie.png", bytes: png }, "вот");

    expect(uploadedBytes(fetchMock).equals(png)).toBe(true);
  });

  it("sends the answer text together with the file", async () => {
    const fetchMock = fileUploadFetch();
    const { client } = makeClient(fetchMock);

    await client.sendFile("6", { name: "krug.mp4", bytes: moovLastMovie() }, "готово");

    const commit = fetchMock.mock.calls.find(([url]) => String(url).includes("im.disk.file.commit"));
    const body = JSON.parse((commit![1] as { body: string }).body) as { MESSAGE: string; DISK_ID: number };
    expect(body.MESSAGE).toBe("готово");
    expect(body.DISK_ID).toBe(900);
  });
});
