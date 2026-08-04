/**
 * P1.A — HTTP handlers for the Telegram deep-link login flow.
 *
 * Two endpoints:
 *   POST /auth/tg-link/start   — kicks off the flow; returns nonce + deep link.
 *   GET  /auth/tg-link/poll    — long-polls until /start <nonce> arrives at
 *                                the bot, then returns {jwt, workspaceId}.
 *
 * Both endpoints are public (no Bearer auth) — the nonce itself is the
 * unguessable token.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TgLinkService } from './tg-link-service.js'
import type { TgLinkRepo } from './tg-link-repo.js'

const MAX_BODY_BYTES = 64 * 1024
/** Maximum long-poll wait in ms. Higher caps lead to dangling sockets. */
const MAX_POLL_MS = 60_000
/** Default poll wait if the caller doesn't pass `maxWaitMs`. */
const DEFAULT_POLL_MS = 30_000
/** Interval between poll checks. */
const POLL_INTERVAL_MS = 500

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) return resolve(null)
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

export interface TgLinkStartHandlerDeps {
  service: TgLinkService
}

/**
 * Build the POST /auth/tg-link/start handler.
 *
 * Request:  { presetId: string }
 * Response (200): { nonce, deepLink, expiresIn }
 * Errors:
 *   400 — invalid JSON, missing presetId, or unknown preset
 *   500 — anything else
 */
export function createTgLinkStartHandler(
  deps: TgLinkStartHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (e: any) {
      return sendJson(res, 400, { error: e?.message ?? 'invalid body' })
    }
    if (!body || typeof body !== 'object') {
      return sendJson(res, 400, { error: 'presetId required' })
    }
    const presetId = (body as Record<string, unknown>).presetId
    if (typeof presetId !== 'string' || !presetId) {
      return sendJson(res, 400, { error: 'presetId required' })
    }
    try {
      const result = await deps.service.start(presetId)
      return sendJson(res, 200, result)
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.toLowerCase().startsWith('unknown preset')) {
        return sendJson(res, 400, { error: msg })
      }
      return sendJson(res, 500, { error: 'internal error' })
    }
  }
}

export interface TgLinkPollHandlerDeps {
  service: TgLinkService
  repo: TgLinkRepo
  /** Override the sleep function for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Override clock — tests can use a fake clock for fast timeouts. */
  now?: () => number
}

/**
 * Build the GET /auth/tg-link/poll?nonce=...&maxWaitMs=... handler.
 *
 * Behaviour:
 *   - Returns 400 if `nonce` query param is missing.
 *   - Returns 404 if the nonce is not in the DB at all (caller likely sent
 *     a stale id from a previous run).
 *   - Long-polls up to `maxWaitMs` (clamped to {@link MAX_POLL_MS}) checking
 *     every {@link POLL_INTERVAL_MS} ms.
 *   - Returns 200 + {jwt, workspaceId} as soon as `/start <nonce>` completes
 *     the nonce.
 *   - Returns 408 if the wait window elapses with no completion.
 */
export function createTgLinkPollHandler(
  deps: TgLinkPollHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? (() => Date.now())
  return async (req, res) => {
    let nonce: string | null = null
    let maxWaitMs = DEFAULT_POLL_MS
    try {
      const u = new URL(req.url ?? '', 'http://localhost')
      nonce = u.searchParams.get('nonce')
      const raw = u.searchParams.get('maxWaitMs')
      if (raw) {
        const parsed = parseInt(raw, 10)
        if (Number.isFinite(parsed) && parsed > 0) {
          maxWaitMs = Math.min(parsed, MAX_POLL_MS)
        }
      }
    } catch {
      return sendJson(res, 400, { error: 'invalid url' })
    }
    if (!nonce) {
      return sendJson(res, 400, { error: 'nonce required' })
    }

    // Bail fast on a nonce we have never seen — saves a 30-60s long-poll
    // that we know will time out.
    const exists = await deps.repo.findById(nonce)
    if (!exists) {
      return sendJson(res, 404, { error: 'nonce not found' })
    }

    const startedAt = now()
    while (now() - startedAt < maxWaitMs) {
      const result = await deps.service.poll(nonce)
      if (result) {
        return sendJson(res, 200, result)
      }
      const remaining = maxWaitMs - (now() - startedAt)
      if (remaining <= 0) break
      await sleep(Math.min(POLL_INTERVAL_MS, remaining))
    }
    return sendJson(res, 408, { error: 'timeout' })
  }
}
