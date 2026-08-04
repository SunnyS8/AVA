import { describe, expect, it } from 'vitest'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { BackendConnector } from '../../src/main/backend-connector'

interface FakeServer {
  port: number
  close: () => Promise<void>
  wss: WebSocketServer
}

async function fakeServer(): Promise<FakeServer> {
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  return await new Promise<FakeServer>((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port
      resolve({
        port,
        wss,
        close: () =>
          new Promise((r) => {
            wss.close()
            server.close(() => r())
          }),
      })
    })
  })
}

describe('BackendConnector', () => {
  it('connects with Bearer header and emits open', async () => {
    const s = await fakeServer()
    let receivedAuth = ''
    s.wss.on('connection', (_ws, req) => {
      receivedAuth = req.headers.authorization ?? ''
    })

    const events: string[] = []
    const c = new BackendConnector({
      url: `ws://127.0.0.1:${s.port}/ws/chat`,
      jwt: 'tok-1',
    })
    c.on('open', () => events.push('open'))
    c.start()
    await new Promise((r) => setTimeout(r, 150))

    expect(receivedAuth).toBe('Bearer tok-1')
    expect(events).toContain('open')

    c.stop()
    await s.close()
  })

  it('emits message events for inbound JSON frames', async () => {
    const s = await fakeServer()
    s.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'pong' }))
    })
    const c = new BackendConnector({
      url: `ws://127.0.0.1:${s.port}/ws/chat`,
      jwt: 'x',
    })
    const messages: unknown[] = []
    c.on('message', (m) => messages.push(m))
    c.start()
    await new Promise((r) => setTimeout(r, 150))
    expect(messages[0]).toEqual({ type: 'pong' })
    c.stop()
    await s.close()
  })

  it('reconnects on close with exponential backoff', async () => {
    const s = await fakeServer()
    let conns = 0
    s.wss.on('connection', (ws) => {
      conns++
      if (conns < 3) {
        ws.close()
      }
    })
    const c = new BackendConnector({
      url: `ws://127.0.0.1:${s.port}/ws/chat`,
      jwt: 'x',
      backoffStartMs: 20,
      backoffMaxMs: 200,
    })
    c.start()
    await new Promise((r) => setTimeout(r, 800))
    expect(conns).toBeGreaterThanOrEqual(3)
    c.stop()
    await s.close()
  })

  it('emits auth-failed on close code 4001 and stops reconnecting', async () => {
    const s = await fakeServer()
    let conns = 0
    s.wss.on('connection', (ws) => {
      conns++
      ws.close(4001, 'auth_failed')
    })
    const c = new BackendConnector({
      url: `ws://127.0.0.1:${s.port}/ws/chat`,
      jwt: 'x',
      backoffStartMs: 20,
      backoffMaxMs: 200,
    })
    const events: string[] = []
    c.on('auth-failed', () => events.push('auth-failed'))
    c.start()
    await new Promise((r) => setTimeout(r, 400))
    expect(events).toContain('auth-failed')
    // Critically: must NOT keep reconnecting after auth-failed
    expect(conns).toBe(1)
    c.stop()
    await s.close()
  })

  it('send() forwards JSON to server', async () => {
    const s = await fakeServer()
    const received: unknown[] = []
    s.wss.on('connection', (ws) => {
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))
    })
    const c = new BackendConnector({
      url: `ws://127.0.0.1:${s.port}/ws/chat`,
      jwt: 'x',
    })
    c.start()
    await new Promise((r) => setTimeout(r, 150))
    c.send({ type: 'ping' })
    await new Promise((r) => setTimeout(r, 80))
    expect(received).toEqual([{ type: 'ping' }])
    c.stop()
    await s.close()
  })

  it('stop() prevents reconnect after disconnect', async () => {
    const s = await fakeServer()
    let conns = 0
    s.wss.on('connection', (ws) => {
      conns++
      ws.close()
    })
    const c = new BackendConnector({
      url: `ws://127.0.0.1:${s.port}/ws/chat`,
      jwt: 'x',
      backoffStartMs: 50,
      backoffMaxMs: 200,
    })
    c.start()
    // Let one reconnect cycle land so we know the backoff timer is the
    // thing keeping us in flight, then stop.
    await new Promise((r) => setTimeout(r, 200))
    c.stop()
    const after = conns
    // Wait longer than the max backoff so a leaked reconnect timer would
    // have produced another `conns++` by now.
    await new Promise((r) => setTimeout(r, 500))
    expect(conns).toBe(after)
    await s.close()
  })
})
