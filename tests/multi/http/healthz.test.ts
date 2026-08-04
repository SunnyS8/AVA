import { describe, it, expect, vi } from 'vitest'
import { Pool } from 'pg'
import WebSocket from 'ws'
import { handleHealthz, startHealthzServer } from '../../../src/multi/http/healthz.js'

describe('handleHealthz', () => {
  it('returns 200 when db check passes', async () => {
    const dbCheck = vi.fn().mockResolvedValue(true)
    const res = await handleHealthz({ dbCheck })
    expect(res.status).toBe(200)
    expect(res.body).toBe('{"status":"ok"}')
  })

  it('returns 503 when db check fails', async () => {
    const dbCheck = vi.fn().mockRejectedValue(new Error('down'))
    const res = await handleHealthz({ dbCheck })
    expect(res.status).toBe(503)
    expect(res.body).toBe('{"status":"error"}')
  })

  it('returns 503 when db check returns false', async () => {
    const dbCheck = vi.fn().mockResolvedValue(false)
    const res = await handleHealthz({ dbCheck })
    expect(res.status).toBe(503)
  })
})

describe('startHealthzServer upgrade hook', () => {
  it('invokes upgrade handler on /ws/chat', async () => {
    const upgradeCalls: string[] = []
    const server = startHealthzServer(0, {} as Pool, {
      upgrade: (req) => {
        upgradeCalls.push(req.url ?? '')
        req.socket.destroy() // close immediately for the test
      },
    })
    const { port } = server.address() as { port: number }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`)
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve())
      ws.on('error', () => resolve())
    })
    expect(upgradeCalls).toContain('/ws/chat')
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('still serves /healthz when upgrade handler set', async () => {
    const server = startHealthzServer(0, {} as Pool, {
      upgrade: () => {},
    })
    const { port } = server.address() as { port: number }
    const res = await fetch(`http://127.0.0.1:${port}/healthz`)
    // dbCheck will throw because pool is empty mock -> 503 not 200,
    // but the route is still reachable.
    expect([200, 503]).toContain(res.status)
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('accepts ExtraRoute[] as third arg (backwards-compat)', async () => {
    let called = false
    const server = startHealthzServer(0, {} as Pool, [
      {
        method: 'GET',
        path: '/foo',
        handler: (_req, res) => {
          called = true
          res.writeHead(200)
          res.end('ok')
        },
      },
    ])
    const { port } = server.address() as { port: number }
    const res = await fetch(`http://127.0.0.1:${port}/foo`)
    expect(res.status).toBe(200)
    expect(called).toBe(true)
    await new Promise<void>((r) => server.close(() => r()))
  })
})
