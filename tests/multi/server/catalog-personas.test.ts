import { describe, expect, it } from 'vitest'
import { createCatalogPersonasHandler } from '../../../src/multi/personas/catalog-handler.js'

function mockReqRes(): {
  req: any
  res: any
  getStatus: () => number
  getBody: () => any
  getHeader: (name: string) => string | undefined
} {
  let status = 0
  let body = ''
  const headers: Record<string, string> = {}
  const req: any = { headers: {}, url: '/catalog/personas', method: 'GET' }
  const res: any = {
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value
    },
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s
      if (h) {
        for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]
      }
    },
    end: (b: string) => {
      body = b
    },
    headersSent: false,
  }
  return {
    req,
    res,
    getStatus: () => status,
    getBody: () => JSON.parse(body || '{}'),
    getHeader: (name: string) => headers[name.toLowerCase()],
  }
}

describe('GET /catalog/personas handler', () => {
  it('returns array of presets', async () => {
    const handler = createCatalogPersonasHandler()
    const { req, res, getStatus, getBody } = mockReqRes()
    await handler(req, res)
    expect(getStatus()).toBe(200)
    const body = getBody()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(2)
  })

  it('each preset has id, name, avatar, wizardLines', async () => {
    const handler = createCatalogPersonasHandler()
    const { req, res, getBody } = mockReqRes()
    await handler(req, res)
    const body = getBody()
    for (const p of body) {
      expect(typeof p.id).toBe('string')
      expect(typeof p.name).toBe('string')
      expect(typeof p.avatar.static).toBe('string')
      expect(typeof p.wizardLines.mode_intro).toBe('string')
    }
  })

  it('sets cache-control with max-age', async () => {
    const handler = createCatalogPersonasHandler()
    const { req, res, getHeader } = mockReqRes()
    await handler(req, res)
    expect(getHeader('cache-control') ?? '').toMatch(/max-age=\d+/)
  })

  it('sets content-type application/json', async () => {
    const handler = createCatalogPersonasHandler()
    const { req, res, getHeader } = mockReqRes()
    await handler(req, res)
    expect(getHeader('content-type') ?? '').toMatch(/application\/json/)
  })
})
