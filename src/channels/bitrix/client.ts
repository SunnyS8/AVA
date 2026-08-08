import { refreshTokens, type BitrixTokens } from "./tokens.js";

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

/** Outcome of a single attempt: either the portal took the message, or the
 *  access token had died and a fresh one may help. */
type Attempt = "ok" | "expired";

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
    let tokens = this.currentTokens();

    // Refresh ahead of the deadline rather than waiting to be refused: a
    // rejected call costs a round trip and, on a portal that answers oddly,
    // could lose the message outright.
    if (this.tokens.isExpired(tokens)) {
      tokens = await this.refresh(tokens);
    }

    const payload = { BOT_ID: this.botId, DIALOG_ID: dialogId, MESSAGE: clip(text) };

    if ((await this.attempt(tokens, payload)) === "ok") return;

    // The portal still called the token dead. Refresh ONCE and retry. A loop
    // here — refresh on every refusal — would hammer the portal forever when
    // the refresh token itself is the broken one.
    tokens = await this.refresh(tokens);
    if ((await this.attempt(tokens, payload)) === "expired") {
      throw new Error(`Bitrix imbot.message.add rejected: ${EXPIRED_TOKEN} (after a refresh)`);
    }
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

    // A pair that never reaches the disk is a pair the next start does not
    // have: the old refresh token is already spent, so a silent failure here
    // would leave the application permanently locked out.
    try {
      this.tokens.save(fresh);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(`Bitrix token store write failed: ${code ?? "unknown error"}`);
    }

    return fresh;
  }

  /** One call to imbot.message.add. Throws on anything a retry cannot fix. */
  private async attempt(tokens: BitrixTokens, payload: Record<string, string>): Promise<Attempt> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://${tokens.domain}/rest/imbot.message.add.json`, {
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
    let data: { error?: string };
    try {
      data = JSON.parse(raw) as { error?: string };
    } catch {
      if (!res.ok) throw new Error(`Bitrix imbot.message.add failed: HTTP ${res.status}`);
      throw new Error("Bitrix imbot.message.add returned a non-JSON body");
    }

    if (data.error === EXPIRED_TOKEN) return "expired";
    if (!res.ok) throw new Error(`Bitrix imbot.message.add failed: HTTP ${res.status}`);

    // Bitrix answers 200 with an `error` field for application-level failures.
    // Treating that as success loses the message silently: the employee gets no
    // answer and nothing says why.
    if (data.error) {
      // error_description may echo request data — only the code goes out.
      throw new Error(`Bitrix imbot.message.add rejected: ${data.error}`);
    }
    return "ok";
  }
}
