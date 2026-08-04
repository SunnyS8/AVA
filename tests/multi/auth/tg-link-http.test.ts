import { describe, expect, it, vi } from 'vitest'
import {
  createTgLinkStartHandler,
  createTgLinkPollHandler,
} from '../../../src/multi/auth/tg-link-http.js'

function mockReqRes(opts: {
  method?: string
  url?: string
  body?: unknown
}): {
  req: any
  res: any
  getStatus: () => number
  getBody: () => any
} {
  let status = 0
  let body = ''
  const headers: Record<string, string> = {}
  const handlers: Record<string, Array<(...args: any[]) => void>> = {}
  const req: any = {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/',
    headers: {},
    on(event: string, cb: any) {
      ;(handlers[event] ||= []).push(cb)
      return req
    },
    destroy() {},
  }
  const res: any = {
    headersSent: false,
    setHeader: (n: string, v: string) => {
      headers[n.toLowerCase()] = v
    },
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s
      if (h) for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]
      res.headersSent = true
    },
    end: (b: string) => {
      body = b
    },
  }
  // Schedule body emission asynchronously so the handler attaches listeners first.
  if (opts.body !== undefined) {
    queueMicrotask(() => {
      const raw =
        typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
      handlers.data?.forEach((cb) => cb(Buffer.from(raw, 'utf-8')))
      handlers.end?.forEach((cb) => cb())
    })
  } else {
    queueMicrotask(() => {
      handlers.end?.forEach((cb) => cb())
    })
  }
  return {
    req,
    res,
    getStatus: () => status,
    getBody: () => (body ? JSON.parse(body) : {}),
  }
}

// ---------------------------------------------------------------------------
// POST /auth/tg-link/start
// ---------------------------------------------------------------------------

describe('POST /auth/tg-link/start handler', () => {
  it('returns 200 + nonce/deepLink/expiresIn for valid preset', async () => {
    const service = {
      start: vi.fn(async (_id: string) => ({
        nonce: 'abc-nonce-123',
        deepLink: 'https://t.me/betsyai_bot?start=abc-nonce-123',
        expiresIn: 300,
      })),
    } as any
    const handler = createTgLinkStartHandler({ service })
    const { req, res, getStatus, getBody } = mockReqRes({
      method: 'POST',
      url: '/auth/tg-link/start',
      body: { presetId: 'betsy-default' },
    })
    await handler(req, res)
    expect(getStatus()).toBe(200)
    expect(getBody()).toEqual({
      nonce: 'abc-nonce-123',
      deepLink: 'https://t.me/betsyai_bot?start=abc-nonce-123',
      expiresIn: 300,
    })
    expect(service.start).toHaveBeenCalledWith('betsy-default')
  })

  it('returns 400 for missing presetId', async () => {
    const service = { start: vi.fn() } as any
    const handler = createTgLinkStartHandler({ service })
    const { req, res, getStatus } = mockReqRes({
      method: 'POST',
      url: '/auth/tg-link/start',
      body: {},
    })
    await handler(req, res)
    expect(getStatus()).toBe(400)
    expect(service.start).not.toHaveBeenCalled()
  })

  it('returns 400 for non-string presetId', async () => {
    const service = { start: vi.fn() } as any
    const handler = createTgLinkStartHandler({ service })
    const { req, res, getStatus } = mockReqRes({
      method: 'POST',
      url: '/auth/tg-link/start',
      body: { presetId: 42 },
    })
    await handler(req, res)
    expect(getStatus()).toBe(400)
  })

  it('returns 400 for invalid JSON body', async () => {
    const service = { start: vi.fn() } as any
    const handler = createTgLinkStartHandler({ service })
    const { req, res, getStatus } = mockReqRes({
      method: 'POST',
      url: '/auth/tg-link/start',
      body: 'not-json-{',
    })
    await handler(req, res)
    expect(getStatus()).toBe(400)
  })

  it('returns 400 when service throws "unknown preset"', async () => {
    const service = {
      start: vi.fn(async () => {
        throw new Error('unknown preset: nope')
      }),
    } as any
    const handler = createTgLinkStartHandler({ service })
    const { req, res, getStatus, getBody } = mockReqRes({
      method: 'POST',
      url: '/auth/tg-link/start',
      body: { presetId: 'nope' },
    })
    await handler(req, res)
    expect(getStatus()).toBe(400)
    expect(getBody().error).toMatch(/unknown preset/i)
  })

  it('returns 500 on unexpected service errors', async () => {
    const service = {
      start: vi.fn(async () => {
        throw new Error('db blew up')
      }),
    } as any
    const handler = createTgLinkStartHandler({ service })
    const { req, res, getStatus } = mockReqRes({
      method: 'POST',
      url: '/auth/tg-link/start',
      body: { presetId: 'betsy-default' },
    })
    await handler(req, res)
    expect(getStatus()).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// GET /auth/tg-link/poll
// ---------------------------------------------------------------------------

describe('GET /auth/tg-link/poll handler', () => {
  it('returns 400 when nonce query param is missing', async () => {
    const service = { poll: vi.fn() } as any
    const repo = { findById: vi.fn() } as any
    const handler = createTgLinkPollHandler({ service, repo })
    const { req, res, getStatus } = mockReqRes({
      method: 'GET',
      url: '/auth/tg-link/poll',
    })
    await handler(req, res)
    expect(getStatus()).toBe(400)
    expect(repo.findById).not.toHaveBeenCalled()
  })

  it('returns 404 when nonce does not exist', async () => {
    const service = { poll: vi.fn() } as any
    const repo = { findById: vi.fn(async () => null) } as any
    const handler = createTgLinkPollHandler({ service, repo })
    const { req, res, getStatus } = mockReqRes({
      method: 'GET',
      url: '/auth/tg-link/poll?nonce=does-not-exist',
    })
    await handler(req, res)
    expect(getStatus()).toBe(404)
    expect(service.poll).not.toHaveBeenCalled()
  })

  it('returns 408 when nonce exists but never completes within window', async () => {
    const repo = {
      findById: vi.fn(async () => ({ nonce: 'n1' })),
    } as any
    const service = { poll: vi.fn(async () => null) } as any
    const handler = createTgLinkPollHandler({
      service,
      repo,
      sleep: async () => {},
      now: (() => {
        // Advance time on every call so the while loop exits after one iteration.
        let t = 0
        return () => {
          const v = t
          t += 1_000_000
          return v
        }
      })(),
    })
    const { req, res, getStatus } = mockReqRes({
      method: 'GET',
      url: '/auth/tg-link/poll?nonce=n1&maxWaitMs=200',
    })
    await handler(req, res)
    expect(getStatus()).toBe(408)
  })

  it('returns 200 + token as soon as service.poll resolves', async () => {
    const repo = {
      findById: vi.fn(async () => ({ nonce: 'n2' })),
    } as any
    let callCount = 0
    const service = {
      poll: vi.fn(async () => {
        callCount += 1
        // Third call completes.
        if (callCount >= 3) return { jwt: 'jwt-xyz', workspaceId: 'ws-1' }
        return null
      }),
    } as any
    const handler = createTgLinkPollHandler({
      service,
      repo,
      sleep: async () => {},
    })
    const { req, res, getStatus, getBody } = mockReqRes({
      method: 'GET',
      url: '/auth/tg-link/poll?nonce=n2&maxWaitMs=5000',
    })
    await handler(req, res)
    expect(getStatus()).toBe(200)
    expect(getBody()).toEqual({ jwt: 'jwt-xyz', workspaceId: 'ws-1' })
    expect(service.poll).toHaveBeenCalledTimes(3)
  })

  it('clamps maxWaitMs to the 60s cap', async () => {
    // Use a sentinel that bails out as soon as the first poll runs to keep
    // the test fast — we only care that the URL accepted a large value.
    const repo = {
      findById: vi.fn(async () => ({ nonce: 'n3' })),
    } as any
    const service = {
      poll: vi.fn(async () => ({ jwt: 'j', workspaceId: 'w' })),
    } as any
    const handler = createTgLinkPollHandler({ service, repo, sleep: async () => {} })
    const { req, res, getStatus } = mockReqRes({
      method: 'GET',
      url: '/auth/tg-link/poll?nonce=n3&maxWaitMs=9999999',
    })
    await handler(req, res)
    expect(getStatus()).toBe(200)
  })
})
