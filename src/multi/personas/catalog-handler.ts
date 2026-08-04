/**
 * P1.A — HTTP handler for `GET /catalog/personas`.
 *
 * Public endpoint (no auth) — the Windows-app fetches the persona catalog on
 * first launch so the wizard can render persona picker + per-step lines.
 * Cached for 5 minutes since the catalog is static (built-in array).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { listPresets } from './presets.js'

export const CATALOG_CACHE_MAX_AGE_SEC = 300

export function createCatalogPersonasHandler(): (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> {
  return async (_req, res) => {
    const body = JSON.stringify(listPresets())
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', `public, max-age=${CATALOG_CACHE_MAX_AGE_SEC}`)
    res.writeHead(200)
    res.end(body)
  }
}
