/**
 * P1.A — HS256 JWT helpers via node:crypto. No external library.
 *
 * Same pattern as `src/server.ts` (single-mode), but kept inside `src/multi/`
 * so the multi-mode code never reaches across the core/multi boundary.
 *
 * Caveats:
 *  - Symmetric only (HS256). All clients trust the same secret.
 *  - Expiry is a numeric date (ms since epoch), NOT seconds-since-epoch like
 *    standard JWT. This matches `src/server.ts` and keeps the format simple.
 *    Callers should treat "exp" as a millisecond timestamp.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

function base64urlEncodeBuffer(buf: Buffer): string {
  return buf.toString('base64url')
}

function base64urlEncode(str: string): string {
  return base64urlEncodeBuffer(Buffer.from(str, 'utf-8'))
}

function base64urlDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf-8')
}

/**
 * Sign an HS256 JWT.
 *
 * @param payload  Arbitrary claims. An `exp` claim is added automatically
 *                 (ms-since-epoch, see file docs).
 * @param secret   HMAC secret.
 * @param ttlSeconds  Lifetime of the token in seconds.
 */
export function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds: number,
): string {
  if (!secret) throw new Error('signJwt: secret required')
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const exp = Date.now() + ttlSeconds * 1000
  const body = base64urlEncode(JSON.stringify({ ...payload, exp }))
  const signature = base64urlEncodeBuffer(
    createHmac('sha256', secret).update(`${header}.${body}`).digest(),
  )
  return `${header}.${body}.${signature}`
}

/**
 * Verify an HS256 JWT and return the decoded payload, or null on any failure
 * (malformed, bad signature, expired). Uses timing-safe comparison.
 */
export function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  try {
    const [header, body, signature] = token.split('.')
    if (!header || !body || !signature) return null
    const expected = base64urlEncodeBuffer(
      createHmac('sha256', secret).update(`${header}.${body}`).digest(),
    )
    const sigBuf = Buffer.from(signature)
    const expBuf = Buffer.from(expected)
    if (sigBuf.length !== expBuf.length) return null
    if (!timingSafeEqual(sigBuf, expBuf)) return null
    const payload = JSON.parse(base64urlDecode(body)) as Record<string, unknown>
    if (typeof payload.exp === 'number' && payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}
