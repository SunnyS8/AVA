import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../../core/config.js";

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
  /**
   * The `application_token` the portal issued at install time — the shared
   * secret every later event is signed with.
   *
   * Optional on purpose. It is born inside the install event, so a token file
   * written before this field existed (or one filled in from a webhook setup)
   * simply does not have it, and demanding it would make such a file
   * unreadable — which looks exactly like an uninstalled application. Absent
   * means "fall back to the value from the config".
   */
  applicationToken?: string;
}

/** Fields without which a token record is useless. `applicationToken` is
 *  deliberately NOT here — see the field's comment. */
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
    typeof v.memberId === "string" &&
    (v.applicationToken === undefined || typeof v.applicationToken === "string")
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
  constructor(readonly filePath: string) {}

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

/** File name inside the config directory. Kept next to config.yaml because it
 *  belongs to the same installation and is protected the same way. */
const TOKEN_FILE_NAME = "bitrix-tokens.json";

/**
 * The token store the application actually runs with: one file per
 * installation, in the same directory the config lives in (`~/.betsy`), so
 * moving or backing up a Betsy installation carries its portal install along.
 */
export function createBitrixTokenStore(): BitrixTokenStore {
  return new BitrixTokenStore(path.join(getConfigDir(), TOKEN_FILE_NAME));
}

/** OAuth token endpoint shared by every Bitrix24 portal — not portal-specific. */
const OAUTH_TOKEN_URL = "https://oauth.bitrix.info/oauth/token/";

interface BitrixOAuthResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  /**
   * The authorisation server's OWN host ("oauth.bitrix.info") — NOT the
   * portal. Kept here only so the shape matches the wire and nobody
   * "restores" it as the portal domain. Read `client_endpoint` instead.
   */
  domain?: string;
  /** Portal REST root, e.g. "https://example.bitrix24.ru/rest/" — the only
   *  field in this response that names the portal. */
  client_endpoint?: string;
  member_id?: string;
  error?: string;
}

/** Non-error fields a successful response must carry. `client_endpoint` is
 *  checked separately: it must also parse as a URL to be of any use. */
const REQUIRED_OAUTH_STRING_FIELDS: (keyof BitrixOAuthResponse)[] = [
  "access_token",
  "refresh_token",
  "member_id",
];

/**
 * Portal host out of `client_endpoint` ("https://example.bitrix24.ru/rest/" →
 * "example.bitrix24.ru"), or undefined when the value is absent or is not a
 * URL with a host.
 *
 * This is the ONLY place the portal domain comes from on a refresh. The
 * response's own `domain` field carries "oauth.bitrix.info" — the
 * authorisation server naming itself — and trusting it once sent every bot
 * call to https://oauth.bitrix.info/rest/… , where Bitrix answers 404
 * ERROR_METHOD_NOT_FOUND. In production the bot fell silent an hour after
 * the install (at the first refresh) and the symptom read as "the portal
 * revoked our rights", which it had not.
 */
function portalDomainFromEndpoint(clientEndpoint: string | undefined): string | undefined {
  if (typeof clientEndpoint !== "string" || clientEndpoint === "") return undefined;
  let url: URL;
  try {
    url = new URL(clientEndpoint);
  } catch {
    return undefined;
  }
  return url.hostname === "" ? undefined : url.hostname;
}

/**
 * Finds the first required field missing from an otherwise-successful
 * response, so a truncated or half-configured portal reply fails loudly
 * here instead of silently producing a token record with holes in it that
 * only surfaces later, at the next `load()`, as an unrelated-looking
 * "missing required fields" error.
 */
function findMissingOAuthField(data: BitrixOAuthResponse): string | undefined {
  for (const field of REQUIRED_OAUTH_STRING_FIELDS) {
    if (typeof data[field] !== "string" || data[field] === "") return field;
  }
  // Unusable and missing are the same failure here: without a portal host
  // there is nowhere to send the next request, and there is no second field
  // to fall back to. Reported as a plain missing-field name — the response
  // body stays out of the message, it still holds live tokens.
  if (portalDomainFromEndpoint(data.client_endpoint) === undefined) return "client_endpoint";
  // expires_in arrives as JSON so it's normally already a number; Number()
  // is a deliberate, explicit coercion (not relying on `+`/implicit JS
  // coercion) to also accept a numeric string without accepting garbage.
  if (data.expires_in === undefined || data.expires_in === null || Number.isNaN(Number(data.expires_in))) {
    return "expires_in";
  }
  return undefined;
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

  let data: BitrixOAuthResponse;
  try {
    const raw = await res.text();
    data = JSON.parse(raw) as BitrixOAuthResponse;
  } catch {
    throw new Error("Bitrix token refresh returned a non-JSON body");
  }

  if (!res.ok || typeof data.error === "string") {
    // error_description may echo request data back (e.g. the bad refresh
    // token) — only the error code goes out.
    throw new Error(`Bitrix token refresh rejected: ${data.error ?? `HTTP ${res.status}`}`);
  }

  const missingField = findMissingOAuthField(data);
  if (missingField) {
    // Report which field is missing, never the response body — a partial
    // response can still carry a real token in another field.
    throw new Error(`Bitrix token refresh returned an incomplete response: missing ${missingField}`);
  }

  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
    // From client_endpoint, never from data.domain — see
    // portalDomainFromEndpoint. findMissingOAuthField has already proven this
    // parses, so the cast is safe.
    domain: portalDomainFromEndpoint(data.client_endpoint) as string,
    memberId: data.member_id as string,
  };
}
