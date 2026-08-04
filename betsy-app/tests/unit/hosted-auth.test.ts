import { describe, expect, it, vi } from 'vitest'
import { HostedAuth } from '../../src/main/hosted-auth'

describe('HostedAuth', () => {
  it('start() POSTs to /auth/tg-link/start and returns nonce + deepLink', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        nonce: 'n1',
        deepLink: 'https://t.me/x?start=n1',
        expiresIn: 300,
      }),
    }))
    const a = new HostedAuth('https://api.test', fetchMock)
    const r = await a.start('betsy-default')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/auth/tg-link/start',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetId: 'betsy-default' }),
      }),
    )
    expect(r.nonce).toBe('n1')
  })

  it('poll() returns completed on 200', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jwt: 'jwt-1', workspaceId: 'ws-1' }),
    }))
    const a = new HostedAuth('https://api.test', fetchMock)
    const r = await a.poll('n1')
    expect(r).toEqual({ kind: 'completed', jwt: 'jwt-1', workspaceId: 'ws-1' })
  })

  it('poll() returns timeout on 408', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 408,
      json: async () => ({}),
    }))
    const a = new HostedAuth('https://api.test', fetchMock)
    const r = await a.poll('n1')
    expect(r).toEqual({ kind: 'timeout' })
  })

  it('poll() returns expired on 404', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }))
    const a = new HostedAuth('https://api.test', fetchMock)
    const r = await a.poll('n1')
    expect(r).toEqual({ kind: 'expired' })
  })

  it('start() throws on non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }))
    const a = new HostedAuth('https://api.test', fetchMock)
    await expect(a.start('p')).rejects.toThrow(/start failed: 500/)
  })
})
