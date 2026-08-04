import http from 'node:http'
import type { Socket } from 'node:net'
import type { Pool } from 'pg'

export type ExtraRoute = {
  method: string
  path: string
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void
}

export interface HealthzServerOptions {
  extraRoutes?: ExtraRoute[]
  /** Optional handler for WS upgrade requests (e.g. /ws/chat). When set, the
   *  server registers it as the sole 'upgrade' listener — internal dispatch by
   *  pathname is the handler's responsibility. */
  upgrade?: (req: http.IncomingMessage, socket: Socket, head: Buffer) => void
}

export interface HealthzDeps {
  dbCheck: () => Promise<boolean>
}

export interface HealthzResponse {
  status: number
  body: string
}

export async function handleHealthz(deps: HealthzDeps): Promise<HealthzResponse> {
  try {
    const ok = await deps.dbCheck()
    if (ok) return { status: 200, body: '{"status":"ok"}' }
    return { status: 503, body: '{"status":"error"}' }
  } catch {
    return { status: 503, body: '{"status":"error"}' }
  }
}

export function startHealthzServer(
  port: number,
  pool: Pool,
  optsOrExtraRoutes: HealthzServerOptions | ExtraRoute[] = [],
): http.Server {
  // Backwards-compat: pre-P1.5 call sites passed `extraRoutes` directly as
  // the third positional argument.
  const opts: HealthzServerOptions = Array.isArray(optsOrExtraRoutes)
    ? { extraRoutes: optsOrExtraRoutes }
    : optsOrExtraRoutes
  const extraRoutes = opts.extraRoutes ?? []

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const result = await handleHealthz({
        dbCheck: async () => {
          const r = await pool.query('select 1')
          return r.rows.length > 0
        },
      })
      res.writeHead(result.status, { 'content-type': 'application/json' })
      res.end(result.body)
      return
    }
    for (const route of extraRoutes) {
      // Match on method + pathname only (strip query string). This lets
      // handlers like /auth/tg-link/poll?nonce=... still match /auth/tg-link/poll.
      const pathname = (req.url ?? '').split('?')[0]
      if (req.method === route.method && pathname === route.path) {
        try {
          await route.handler(req, res)
        } catch (e) {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'internal error' }))
          }
        }
        return
      }
    }
    res.writeHead(404)
    res.end()
  })
  if (opts.upgrade) {
    server.on('upgrade', opts.upgrade)
  }
  server.listen(port)
  return server
}
