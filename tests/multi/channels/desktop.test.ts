import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import WebSocket from 'ws'
import { DesktopAdapter } from '../../../src/multi/channels/desktop.js'

function makeServer(
  adapter: DesktopAdapter,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer()
    server.on('upgrade', (req, socket, head) => adapter.handleUpgrade(req, socket, head))
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

describe('DesktopAdapter handshake', () => {
  let s: { port: number; close: () => Promise<void> }
  let adapter: DesktopAdapter

  beforeEach(async () => {
    adapter = new DesktopAdapter({
      verifyJwt: (token) => (token === 'good-jwt' ? { sub: 'ws-1' } : null),
    })
    s = await makeServer(adapter)
  })
  afterEach(async () => {
    await adapter.stop()
    await s.close()
  })

  it('accepts WS with valid Bearer JWT', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer good-jwt' },
    })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    expect(adapter.connectionsFor('ws-1')).toBe(1)
    ws.close()
  })

  it('closes with 4001 on missing JWT', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`)
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c))
    })
    expect(code).toBe(4001)
  })

  it('closes with 4001 on invalid JWT', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer bad-jwt' },
    })
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c))
    })
    expect(code).toBe(4001)
  })

  it('ignores requests to other paths', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/something-else`, {
      headers: { authorization: 'Bearer good-jwt' },
    })
    const closed = await new Promise<boolean>((resolve) => {
      ws.on('close', () => resolve(true))
      ws.on('error', () => resolve(true))
    })
    expect(closed).toBe(true)
  })

  it('accepts JWT via ?token= query fallback', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat?token=good-jwt`)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    expect(adapter.connectionsFor('ws-1')).toBe(1)
    ws.close()
  })
})

describe('DesktopAdapter inbound', () => {
  let s: { port: number; close: () => Promise<void> }
  let adapter: DesktopAdapter
  let onInbound: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    onInbound = vi.fn()
    adapter = new DesktopAdapter({
      verifyJwt: () => ({ sub: 'ws-99' }),
    })
    adapter.onMessage(onInbound)
    s = await makeServer(adapter)
  })
  afterEach(async () => {
    await adapter.stop()
    await s.close()
  })

  it('emits InboundEvent on user-message', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.send(
      JSON.stringify({
        type: 'user-message',
        text: 'hello betsy',
        clientMessageId: 'c1',
      }),
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(onInbound).toHaveBeenCalledTimes(1)
    const ev = onInbound.mock.calls[0][0]
    expect(ev.channel).toBe('desktop')
    expect(ev.text).toBe('hello betsy')
    expect(ev.userId).toBe('ws-99')
    expect(ev.chatId).toBe('ws-99')
    expect(ev.messageId).toBe('c1')
    ws.close()
  })

  it('responds to ping with pong', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const reply = await new Promise<any>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())))
      ws.send(JSON.stringify({ type: 'ping' }))
    })
    expect(reply.type).toBe('pong')
    ws.close()
  })

  it('rejects malformed JSON with error frame', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const reply = await new Promise<any>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())))
      ws.send('not-json{')
    })
    expect(reply.type).toBe('error')
    expect(reply.code).toBe('bad-json')
    ws.close()
  })

  it('rejects user-message missing required fields', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const reply = await new Promise<any>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())))
      ws.send(JSON.stringify({ type: 'user-message', text: 'no-id' }))
    })
    expect(reply.type).toBe('error')
    expect(reply.code).toBe('bad-frame')
    ws.close()
  })
})

describe('DesktopAdapter outbound sendMessage', () => {
  let s: { port: number; close: () => Promise<void> }
  let adapter: DesktopAdapter

  beforeEach(async () => {
    adapter = new DesktopAdapter({ verifyJwt: () => ({ sub: 'ws-7' }) })
    s = await makeServer(adapter)
  })
  afterEach(async () => {
    await adapter.stop()
    await s.close()
  })

  it('delivers OutboundMessage to active WS connection as `message` event', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))

    const received: any[] = []
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))

    await adapter.sendMessage({
      chatId: 'ws-7',
      text: 'hi from server',
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('message')
    expect(received[0].message.role).toBe('assistant')
    expect(received[0].message.text).toBe('hi from server')
    expect(received[0].message.channel).toBe('desktop')
    ws.close()
  })

  it('returns externalMessageId undefined (desktop has no platform ids)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const r = await adapter.sendMessage({ chatId: 'ws-7', text: 'x' })
    expect(r.externalMessageId).toBeUndefined()
    ws.close()
  })

  it('no-ops gracefully when workspace has no active connection', async () => {
    const r = await adapter.sendMessage({ chatId: 'ws-7', text: 'hi' })
    expect(r).toEqual({})
  })

  it('broadcasts to multiple connections from same workspace', async () => {
    const w1 = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    const w2 = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await Promise.all([
      new Promise<void>((r) => w1.on('open', () => r())),
      new Promise<void>((r) => w2.on('open', () => r())),
    ])
    const r1: any[] = []
    const r2: any[] = []
    w1.on('message', (d) => r1.push(JSON.parse(d.toString())))
    w2.on('message', (d) => r2.push(JSON.parse(d.toString())))

    await adapter.sendMessage({ chatId: 'ws-7', text: 'broadcast' })
    await new Promise((r) => setTimeout(r, 30))

    expect(r1).toHaveLength(1)
    expect(r2).toHaveLength(1)
    w1.close()
    w2.close()
  })
})

describe('DesktopAdapter streamMessage', () => {
  let s: { port: number; close: () => Promise<void> }
  let adapter: DesktopAdapter

  beforeEach(async () => {
    adapter = new DesktopAdapter({ verifyJwt: () => ({ sub: 'ws-s' }) })
    s = await makeServer(adapter)
  })
  afterEach(async () => {
    await adapter.stop()
    await s.close()
  })

  it('streams deltas then final', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const received: any[] = []
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))

    async function* gen() {
      yield 'Hel'
      yield 'Hello'
      yield 'Hello!'
    }
    await adapter.streamMessage({ chatId: 'ws-s', textStream: gen() })
    await new Promise((r) => setTimeout(r, 50))

    const deltas = received.filter((m) => m.type === 'message-delta')
    const finals = received.filter((m) => m.type === 'message-final')
    expect(deltas.length).toBeGreaterThanOrEqual(2)
    expect(finals).toHaveLength(1)
    expect(finals[0].text).toBe('Hello!')
    const ids = new Set([...deltas, ...finals].map((m) => m.messageId))
    expect(ids.size).toBe(1)
    ws.close()
  })

  it('uses finalText override if provided', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const received: any[] = []
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))

    async function* gen() {
      yield 'A'
      yield 'AB'
    }
    await adapter.streamMessage({
      chatId: 'ws-s',
      textStream: gen(),
      finalText: 'OVERRIDE',
    })
    await new Promise((r) => setTimeout(r, 50))

    const final = received.find((m) => m.type === 'message-final')
    expect(final.text).toBe('OVERRIDE')
    ws.close()
  })

  it('applies finalTextOverride promise when resolved before timeout', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const received: any[] = []
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))

    async function* gen() {
      yield 'partial'
    }
    await adapter.streamMessage({
      chatId: 'ws-s',
      textStream: gen(),
      finalTextOverride: Promise.resolve('CRITIC_FIXED'),
    })
    await new Promise((r) => setTimeout(r, 50))

    const final = received.find((m) => m.type === 'message-final')
    expect(final.text).toBe('CRITIC_FIXED')
    ws.close()
  })
})

describe('DesktopAdapter mirror (for OutboundDispatcher)', () => {
  let s: { port: number; close: () => Promise<void> }
  let adapter: DesktopAdapter

  beforeEach(async () => {
    adapter = new DesktopAdapter({ verifyJwt: () => ({ sub: 'ws-m' }) })
    s = await makeServer(adapter)
  })
  afterEach(async () => {
    await adapter.stop()
    await s.close()
  })

  it('emits message-from-other-channel to workspace connections', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/chat`, {
      headers: { authorization: 'Bearer x' },
    })
    await new Promise<void>((r) => ws.on('open', () => r()))
    const received: any[] = []
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))

    await adapter.mirror('ws-m', {
      id: 'm1',
      role: 'assistant',
      text: 'from TG',
      channel: 'telegram',
      createdAt: new Date().toISOString(),
    })
    await new Promise((r) => setTimeout(r, 30))

    const mirror = received.find((m) => m.type === 'message-from-other-channel')
    expect(mirror).toBeDefined()
    expect(mirror.message.channel).toBe('telegram')
    expect(mirror.message.text).toBe('from TG')
    ws.close()
  })
})
