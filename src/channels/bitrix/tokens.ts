import fs from "node:fs";
import path from "node:path";

/**
 * Access/refresh token pair issued by a Bitrix24 portal to a local
 * application. Access tokens live about an hour; the refresh token is used
 * to obtain a new pair once the access token expires.
 */
export interface BitrixTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix ms timestamp when the access token formally expires. */
  expiresAt: number;
  /** Portal domain the tokens were issued for, e.g. "example.bitrix24.ru". */
  domain: string;
  memberId: string;
}

const REQUIRED_FIELDS: (keyof BitrixTokens)[] = [
  "accessToken",
  "refreshToken",
  "expiresAt",
  "domain",
  "memberId",
];

function isBitrixTokens(value: unknown): value is BitrixTokens {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    REQUIRED_FIELDS.every((f) => f in v) &&
    typeof v.accessToken === "string" &&
    typeof v.refreshToken === "string" &&
    typeof v.expiresAt === "number" &&
    typeof v.domain === "string" &&
    typeof v.memberId === "string"
  );
}

/** Tokens expire in an hour; refresh a minute early so an in-flight request
 *  never lands with an already-dead access token. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Reads and writes Bitrix application tokens to a single JSON file.
 *
 * Writes are atomic (write to a sibling temp file, then rename) so a crash
 * mid-write never leaves a half-written, unparsable file behind. Reads are
 * forgiving: any problem (missing file, bad JSON, missing fields) yields
 * `null` and a logged reason — never a thrown exception and never the raw
 * file content in the log, since that content is a live credential.
 */
export class BitrixTokenStore {
  constructor(private filePath: string) {}

  load(): BitrixTokens | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error(`bitrix tokens: failed to read token file (${code ?? "unknown error"})`);
      }
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("bitrix tokens: token file is not valid JSON");
      return null;
    }

    if (!isBitrixTokens(parsed)) {
      console.error("bitrix tokens: token file is missing required fields");
      return null;
    }

    return parsed;
  }

  save(tokens: BitrixTokens): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`);

    // Create the temp file and lock down its permissions before any content
    // lands in it — otherwise there is a window where the token sits in a
    // world-readable file. `wx` also fails loudly on a name collision
    // instead of silently truncating someone else's file.
    const fd = fs.openSync(tmpPath, "wx", 0o600);
    try {
      try {
        fs.writeFileSync(fd, JSON.stringify(tokens, null, 2));
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      // A failed write must not leave a copy of live tokens lying around.
      // Cleanup is best-effort: the original failure is what the caller
      // needs, so a failed unlink here must not replace it.
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* nothing more we can do */
      }
      throw err;
    }

    // Rename is atomic within the same filesystem: readers either see the
    // old complete file or the new complete file, never a partial one.
    fs.renameSync(tmpPath, this.filePath);
  }

  isExpired(tokens: BitrixTokens, now: number = Date.now()): boolean {
    return now >= tokens.expiresAt - EXPIRY_MARGIN_MS;
  }
}

/** OAuth token endpoint shared by every Bitrix24 portal — not portal-specific. */
const OAUTH_TOKEN_URL = "https://oauth.bitrix.info/oauth/token/";

interface BitrixOAuthResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  domain?: string;
  member_id?: string;
  error?: string;
}

/**
 * Exchanges a refresh token for a fresh access/refresh token pair.
 *
 * Parameters travel in the POST body, never the query string: intermediate
 * proxies and access logs commonly record the request URL but not the body,
 * and `client_secret` plus both tokens are live credentials.
 */
export async function refreshTokens(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BitrixTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  let res: Response;
  try {
    res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    // fetch bakes the whole request — including a query string, were the
    // secrets ever moved there — into its error message on network failure.
    // Only the error kind may leave this module.
    throw new Error(`Bitrix token refresh request failed: ${(err as Error).name}`);
  }

  const raw = await res.text();
  let data: BitrixOAuthResponse;
  try {
    data = JSON.parse(raw) as BitrixOAuthResponse;
  } catch {
    throw new Error("Bitrix token refresh returned a non-JSON body");
  }

  if (!res.ok || typeof data.error === "string") {
    // error_description may echo request data back (e.g. the bad refresh
    // token) — only the error code goes out.
    throw new Error(`Bitrix token refresh rejected: ${data.error ?? `HTTP ${res.status}`}`);
  }

  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresAt: Date.now() + (data.expires_in as number) * 1000,
    domain: data.domain as string,
    memberId: data.member_id as string,
  };
}
