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
