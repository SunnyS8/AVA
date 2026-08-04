import { describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { Readable } from 'node:stream'
import { createHistoryHandler } from '../../../src/multi/chat/history-handler.js'
import type { Conversation } from '../../../src/multi/memory/types.js'

function mockReq(opts: { headers?: Record<string, string>; url?: string }): http.IncomingMessage {
  const r = new Readable() as any
  r.headers = opts.headers ?? {}
  r.url = opts.url ?? '/chat/history'
  r.method = 'GET'
  r._read = () => {}
  return r
}
function mockRes(): http.ServerResponse & {
  _body: string
  _status: number
  _headers: Record<string, string>
} {
  let _body = ''
  let _status = 0
  const _headers: Record<string, string> = {}
  return {
    setHeader: (k: string, v: string) => {
      _headers[k.toLowerCase()] = v
    },
    writeHead: (s: number, h?: Record<string, string>) => {
      _status = s
      if (h) for (const k of Object.keys(h)) _headers[k.toLowerCase()] = h[k]
    },
    end: (chunk: string = '') => {
      _body += chunk
    },
    get _body() {
      return _body
    },
    get _status() {
      return _status
    },
    get _headers() {
      return _headers
    },
  } as any
}

function fakeConv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: overrides.id ?? 'c-default',
    workspaceId: overrides.workspaceId ?? 'ws-1',
    channel: overrides.channel ?? 'desktop',
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'hello',
    toolCalls: overrides.toolCalls ?? null,
    tokensUsed: overrides.tokensUsed ?? 0,
    meta: overrides.meta ?? {},
    chatId: overrides.chatId ?? null,
    externalMessageId: overrides.externalMessageId ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-05-24T10:00:00Z'),
  }
}

describe('GET /chat/history', () => {
  it('returns 401 without Authorization header', async () => {
    const handler = createHistoryHandler({ verifyJwt: () => null, listBefore: vi.fn() })
    const res = mockRes()
    await handler(mockReq({}), res)
    expect(res._status).toBe(401)
  })

  it('returns 401 with invalid JWT', async () => {
    const handler = createHistoryHandler({
      verifyJwt: () => null,
      listBefore: vi.fn(),
    })
    const res = mockRes()
    await handler(mockReq({ headers: { authorization: 'Bearer fake' } }), res)
    expect(res._status).toBe(401)
  })

  it('returns 200 + messages when authed, no cursor', async () => {
    const fakeMessages = [
      fakeConv({ id: 'm1', role: 'assistant', content: 'hi', channel: 'desktop' }),
    ]
    const handler = createHistoryHandler({
      verifyJwt: () => ({ sub: 'ws-abc' }),
      listBefore: vi.fn(async (ws, before, limit) => {
        expect(ws).toBe('ws-abc')
        expect(before).toBe(null)
        expect(limit).toBe(50)
        return fakeMessages
      }),
    })
    const res = mockRes()
    await handler(mockReq({ headers: { authorization: 'Bearer x' } }), res)
    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].id).toBe('m1')
    expect(body.hasMore).toBe(false)
  })

  it('passes ?before=<id>&limit=20 through to listBefore', async () => {
    const calls: any[] = []
    const handler = createHistoryHandler({
      verifyJwt: () => ({ sub: 'ws-x' }),
      listBefore: async (ws, before, limit) => {
        calls.push({ ws, before, limit })
        return []
      },
    })
    const res = mockRes()
    await handler(
      mockReq({
        headers: { authorization: 'Bearer x' },
        url: '/chat/history?before=msg-123&limit=20',
      }),
      res,
    )
    expect(res._status).toBe(200)
    expect(calls[0]).toEqual({ ws: 'ws-x', before: 'msg-123', limit: 20 })
  })

  it('hasMore=true when limit messages returned', async () => {
    const handler = createHistoryHandler({
      verifyJwt: () => ({ sub: 'ws-x' }),
      listBefore: vi.fn(async () =>
        Array.from({ length: 50 }, (_, i) =>
          fakeConv({ id: `m${i}`, content: `t${i}` }),
        ),
      ),
    })
    const res = mockRes()
    await handler(mockReq({ headers: { authorization: 'Bearer x' } }), res)
    const body = JSON.parse(res._body)
    expect(body.hasMore).toBe(true)
    expect(body.messages).toHaveLength(50)
  })

  it('clamps limit to 200', async () => {
    let receivedLimit = 0
    const handler = createHistoryHandler({
      verifyJwt: () => ({ sub: 'ws-x' }),
      listBefore: async (_ws, _before, limit) => {
        receivedLimit = limit
        return []
      },
    })
    const res = mockRes()
    await handler(
      mockReq({
        headers: { authorization: 'Bearer x' },
        url: '/chat/history?limit=10000',
      }),
      res,
    )
    expect(receivedLimit).toBe(200)
  })

  it('filters out tool rows', async () => {
    const handler = createHistoryHandler({
      verifyJwt: () => ({ sub: 'ws-x' }),
      listBefore: async () => [
        fakeConv({ id: 'u1', role: 'user', content: 'hi' }),
        fakeConv({ id: 't1', role: 'tool', content: '{"result": true}' }),
        fakeConv({ id: 'a1', role: 'assistant', content: 'response' }),
      ],
    })
    const res = mockRes()
    await handler(mockReq({ headers: { authorization: 'Bearer x' } }), res)
    const body = JSON.parse(res._body)
    expect(body.messages).toHaveLength(2)
    expect(body.messages.map((m: any) => m.id)).toEqual(['u1', 'a1'])
  })
})
