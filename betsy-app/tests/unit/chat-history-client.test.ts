import { describe, expect, it, vi } from 'vitest'
import { ChatHistoryClient } from '../../src/main/chat-history-client'

function okResponse(body: unknown): { ok: true; status: 200; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body }
}

describe('ChatHistoryClient', () => {
  it('fetches initial history with no cursor', async () => {
    const fetchMock = vi.fn(async () => okResponse({ messages: [], hasMore: false }))
    const c = new ChatHistoryClient('https://api.test', 'jwt-1', fetchMock)
    const r = await c.fetchHistory()
    expect(r).toEqual({ messages: [], hasMore: false })
    const call = fetchMock.mock.calls[0]
    expect(call[0]).toBe('https://api.test/chat/history')
    expect(call[1]?.headers?.authorization).toBe('Bearer jwt-1')
  })

  it('passes before + limit in query', async () => {
    const fetchMock = vi.fn(async () => okResponse({ messages: [], hasMore: false }))
    const c = new ChatHistoryClient('https://api.test', 'jwt-1', fetchMock)
    await c.fetchHistory({ before: 'msg-9', limit: 25 })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/chat/history?before=msg-9&limit=25')
  })

  it('encodes special characters in cursor', async () => {
    const fetchMock = vi.fn(async () => okResponse({ messages: [], hasMore: false }))
    const c = new ChatHistoryClient('https://api.test', 'jwt-1', fetchMock)
    await c.fetchHistory({ before: 'abc/def' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/chat/history?before=abc%2Fdef')
  })

  it('throws auth_failed on 401', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }))
    const c = new ChatHistoryClient('https://api.test', 'bad', fetchMock)
    await expect(c.fetchHistory()).rejects.toThrow('auth_failed')
  })

  it('throws generic error on non-401 failures', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }))
    const c = new ChatHistoryClient('https://api.test', 'x', fetchMock)
    await expect(c.fetchHistory()).rejects.toThrow(/history fetch failed: 500/)
  })

  it('parses returned messages payload', async () => {
    const fakeMessages = [
      {
        id: 'm1',
        role: 'assistant',
        text: 'hi',
        channel: 'desktop',
        createdAt: '2026-05-24T10:00:00.000Z',
      },
    ]
    const fetchMock = vi.fn(async () => okResponse({ messages: fakeMessages, hasMore: true }))
    const c = new ChatHistoryClient('https://api.test', 'x', fetchMock)
    const r = await c.fetchHistory({ limit: 50 })
    expect(r.messages).toEqual(fakeMessages)
    expect(r.hasMore).toBe(true)
  })
})
