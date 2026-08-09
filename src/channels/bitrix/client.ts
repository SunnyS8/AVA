import { refreshTokens, type BitrixTokens } from "./tokens.js";
import type { MediaPayload } from "./media.js";
import { faststart } from "./mp4.js";

export const MAX_MESSAGE_LEN = 8000;

/** Slicing can leave half of a surrogate pair behind, which renders as "�". */
function dropDanglingSurrogate(s: string, side: "end" | "start"): string {
  if (s.length === 0) return s;
  if (side === "end") {
    const last = s.charCodeAt(s.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
  }
  const first = s.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? s.slice(1) : s;
}

/**
 * Trims the middle out of a long text, keeping the head and the tail.
 * Bitrix cuts long messages itself, and the tail is usually the conclusion —
 * losing it is worse than losing the middle.
 */
export function clip(text: string, limit: number = MAX_MESSAGE_LEN): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 2);
  const tail = limit - head - 1;
  const start = dropDanglingSurrogate(text.slice(0, head), "end");
  const end = dropDanglingSurrogate(text.slice(text.length - tail), "start");
  return `${start}…${end}`;
}

/** What the client needs from a token store — the subset BitrixTokenStore
 *  implements, so tests can hand over an in-memory stand-in. */
export interface BitrixTokenSource {
  load(): BitrixTokens | null;
  save(tokens: BitrixTokens): void;
  isExpired(tokens: BitrixTokens, now?: number): boolean;
}

export interface BitrixClientOptions {
  tokens: BitrixTokenSource;
  botId: string;
  /** Application credentials, needed to trade a refresh token for a new pair. */
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  /** Seam for tests; production always refreshes through tokens.ts. */
  refreshImpl?: typeof refreshTokens;
}

/** The one portal error that a retry can actually fix. */
const EXPIRED_TOKEN = "expired_token";

/** Outcome of a single attempt: either the portal answered, or the access
 *  token had died and a fresh one may help. */
type Attempt = { outcome: "ok"; result: unknown } | { outcome: "expired" };

/**
 * Pulls an id out of a portal answer.
 *
 * Bitrix is not consistent about the case: `im.disk.folder.get` answers `ID`,
 * `im.dialog.get` answers `id`, and some builds answer a bare number. Guessing
 * one shape and getting `undefined` would send `CHAT_ID: undefined` onward and
 * fail three calls later with something unrelated-looking.
 */
function pickId(method: string, result: unknown): number {
  const raw =
    typeof result === "object" && result !== null
      ? ((result as Record<string, unknown>).ID ?? (result as Record<string, unknown>).id)
      : result;
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) {
    // The answer body may carry file names and portal internals — only the
    // method name says what happened.
    throw new Error(`Bitrix ${method} returned no usable id`);
  }
  return id;
}

/**
 * Bitrix REST as the application: every call is authorised by the access
 * token from the token store, addressed to the portal domain stored with it.
 *
 * Both tokens and `client_secret` are live credentials: they travel in the
 * request body (a URL lands in every proxy log along the way) and never
 * appear in an error message or a log line — errors carry an error kind, an
 * HTTP status or a portal error code, and nothing else.
 */
export class BitrixClient {
  private tokens: BitrixTokenSource;
  private botId: string;
  private clientId: string;
  private clientSecret: string;
  private fetchImpl: typeof fetch;
  private refreshImpl: typeof refreshTokens;

  constructor(options: BitrixClientOptions) {
    this.tokens = options.tokens;
    this.botId = options.botId;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.refreshImpl = options.refreshImpl ?? refreshTokens;
  }

  async sendMessage(dialogId: string, text: string): Promise<void> {
    await this.call("imbot.message.add", { BOT_ID: this.botId, DIALOG_ID: dialogId, MESSAGE: clip(text) });
  }

  /**
   * Puts a file into the chat, with the answer text as its message.
   *
   * Three portal calls, in the only order that works: the chat has a folder on
   * Drive, the file goes into that folder, and only then is it attached to the
   * chat. `im.disk.file.commit` carries the text, so a delivered file always
   * arrives WITH what Ava said about it — one message, not two that can
   * half-fail.
   *
   * Throws on any refusal. The caller — BitrixChannel — turns that into words
   * a person can act on; nothing here decides what to say.
   */
  async sendFile(dialogId: string, file: MediaPayload, text: string): Promise<void> {
    const chatId = await this.resolveChatId(dialogId);

    // The portal makes no preview for a video (measured 09.08.2026: it does for
    // an image, never for a video, whatever method or parameters the upload
    // uses), so the chat falls back to playing the file itself. Handing it a
    // movie whose index sits at the end means the player has nothing to show
    // until the whole file is down — see mp4.ts. Anything that is not a
    // moov-last MP4 comes back from faststart() untouched.
    const bytes = faststart(file.bytes);

    const folderId = pickId("im.disk.folder.get", await this.call("im.disk.folder.get", { CHAT_ID: chatId }));

    // `disk` scope lives here: without it the portal answers HTTP 401
    // insufficient_scope and this is the call that gets it (measured on the
    // live portal, 08.08.2026).
    const diskId = pickId(
      "disk.folder.uploadfile",
      await this.call("disk.folder.uploadfile", {
        id: folderId,
        data: { NAME: file.name },
        // The file-field shape Bitrix expects everywhere: name and base64.
        fileContent: [file.name, bytes.toString("base64")],
        // Two videos in a row are both "krug.mp4"; let the portal keep both.
        generateUniqueName: "Y",
      }),
    );

    await this.call("im.disk.file.commit", { CHAT_ID: chatId, DISK_ID: diskId, MESSAGE: clip(text) });
  }

  /**
   * The numeric chat id behind a dialog id.
   *
   * `chat42` carries it in plain sight — no round trip. A one-on-one dialog is
   * addressed by the PERSON's id ("17"), and the chat behind it has an id of
   * its own that only the portal knows: `im.disk.folder.get` takes `CHAT_ID`,
   * and its `DIALOG_ID` form is documented for `chatXXX` only. So a personal
   * dialog costs one extra call to `im.dialog.get`, which does accept a bare
   * user id and answers with the chat's `id`.
   */
  private async resolveChatId(dialogId: string): Promise<number> {
    const direct = /^chat(\d+)$/i.exec(dialogId);
    if (direct) return Number(direct[1]);

    return pickId("im.dialog.get", await this.call("im.dialog.get", { DIALOG_ID: dialogId }));
  }

  /** One REST method, with the token dance around it. Returns `result`. */
  private async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    let tokens = this.currentTokens();

    // Refresh ahead of the deadline rather than waiting to be refused: a
    // rejected call costs a round trip and, on a portal that answers oddly,
    // could lose the message outright.
    if (this.tokens.isExpired(tokens)) {
      tokens = await this.refresh(tokens);
    }

    const first = await this.attempt(tokens, method, payload);
    if (first.outcome === "ok") return first.result;

    // The portal still called the token dead. Refresh ONCE and retry. A loop
    // here — refresh on every refusal — would hammer the portal forever when
    // the refresh token itself is the broken one.
    tokens = await this.refresh(tokens);
    const second = await this.attempt(tokens, method, payload);
    if (second.outcome === "expired") {
      throw new Error(`Bitrix ${method} rejected: ${EXPIRED_TOKEN} (after a refresh)`);
    }
    return second.result;
  }

  /** Tokens or a refusal — an uninstalled application must fail loudly, not
   *  quietly drop the answer an employee is waiting for. */
  private currentTokens(): BitrixTokens {
    const tokens = this.tokens.load();
    if (!tokens) {
      throw new Error(
        "Bitrix: приложение не установлено — токены портала не найдены. " +
          "Установите приложение в портале и повторите.",
      );
    }
    return tokens;
  }

  private async refresh(tokens: BitrixTokens): Promise<BitrixTokens> {
    let fresh: BitrixTokens;
    try {
      fresh = await this.refreshImpl(tokens.refreshToken, this.clientId, this.clientSecret, this.fetchImpl);
    } catch (err) {
      // refreshTokens already keeps its own messages clean, but a custom
      // implementation (or a future one) might not: only the kind goes out.
      throw new Error(`Bitrix token refresh failed: ${(err as Error).name}`);
    }

    // Two things a refresh must never change, both carried over explicitly:
    //
    // `domain` — the portal we are installed in. The refresh answer comes from
    // the authorisation server (oauth.bitrix.info), and its `domain` field
    // names ITSELF, not the portal; only `client_endpoint` names the portal.
    // That already cost an outage: the value was taken from `domain`, and an
    // hour after the install every bot call went to
    // https://oauth.bitrix.info/rest/… → 404 ERROR_METHOD_NOT_FOUND, i.e. the
    // bot silently stopped answering. tokens.ts reads the right field now;
    // this is the second line of defence. The client knows which portal it
    // serves — no refresh answer, and no other refreshImpl, may move it.
    //
    // `applicationToken` — issued once, at install, and never returned by a
    // refresh. Saving the fresh pair as-is would drop it an hour in, and from
    // then on every incoming event fails verification: another break that
    // looks like "it worked and then stopped by itself".
    const merged: BitrixTokens = {
      ...fresh,
      domain: tokens.domain,
      applicationToken: tokens.applicationToken,
    };

    // A pair that never reaches the disk is a pair the next start does not
    // have: the old refresh token is already spent, so a silent failure here
    // would leave the application permanently locked out.
    try {
      this.tokens.save(merged);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(`Bitrix token store write failed: ${code ?? "unknown error"}`);
    }

    return merged;
  }

  /** One call to one REST method. Throws on anything a retry cannot fix. */
  private async attempt(tokens: BitrixTokens, method: string, payload: Record<string, unknown>): Promise<Attempt> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://${tokens.domain}/rest/${method}.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `auth` goes in the body, never the query string: intermediate
        // proxies and access logs record request URLs, and this is a live
        // credential.
        body: JSON.stringify({ ...payload, auth: tokens.accessToken }),
      });
    } catch (err) {
      // fetch puts the whole request into its error message. Only the error
      // kind may leave this module.
      throw new Error(`Bitrix request failed: ${(err as Error).name}`);
    }

    // The body is read even on a non-2xx answer: an expired token arrives as
    // HTTP 401 with `error: "expired_token"`, and that is the one case worth
    // retrying rather than reporting.
    const raw = await res.text();
    let data: { error?: string; result?: unknown };
    try {
      data = JSON.parse(raw) as { error?: string; result?: unknown };
    } catch {
      if (!res.ok) throw new Error(`Bitrix ${method} failed: HTTP ${res.status}`);
      throw new Error(`Bitrix ${method} returned a non-JSON body`);
    }

    if (data.error === EXPIRED_TOKEN) return { outcome: "expired" };
    // The portal's error code outranks the status line: a missing `disk` right
    // arrives as HTTP 401 `insufficient_scope`, and "HTTP 401" alone reads like
    // a dead token and sends whoever debugs it the wrong way.
    if (data.error) {
      // error_description may echo request data — only the code goes out.
      throw new Error(`Bitrix ${method} rejected: ${data.error} (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`Bitrix ${method} failed: HTTP ${res.status}`);

    // Bitrix answers 200 with an `error` field for application-level failures
    // (handled just above). Treating that as success loses the message
    // silently: the employee gets no answer and nothing says why.
    return { outcome: "ok", result: data.result };
  }
}
