import { describe, expect, it, vi } from 'vitest'
import { TgLinkService } from '../../../src/multi/auth/tg-link-service.js'
import { verifyJwt } from '../../../src/multi/auth/jwt.js'

interface Row {
  nonce: string
  presetId: string
  expiresAt: Date
  workspaceId: string | null
  jwt: string | null
  completedAt: Date | null
  createdAt: Date
  used: boolean
}

function makeMockRepo() {
  const storage: Row[] = []
  return {
    storage,
    repo: {
      create: vi.fn(async (n: string, p: string) => {
        const row: Row = {
          nonce: n,
          presetId: p,
          expiresAt: new Date(Date.now() + 5 * 60_000),
          workspaceId: null,
          jwt: null,
          completedAt: null,
          createdAt: new Date(),
          used: false,
        }
        storage.push(row)
        return row
      }),
      findById: vi.fn(async (n: string) => storage.find((c) => c.nonce === n) ?? null),
      findActive: vi.fn(
        async (n: string) => storage.find((c) => c.nonce === n && !c.used) ?? null,
      ),
      complete: vi.fn(async (n: string, ws: string, jwt: string) => {
        const row = storage.find((c) => c.nonce === n)
        if (row) {
          row.workspaceId = ws
          row.jwt = jwt
          row.completedAt = new Date()
          row.used = true
        }
      }),
      markUsed: vi.fn(),
      sweepExpired: vi.fn(),
    },
  }
}

describe('TgLinkService', () => {
  it('start() generates a uuid nonce and returns deep link', async () => {
    const { repo } = makeMockRepo()
    const svc = new TgLinkService(repo as any, {
      botUsername: 'betsyai_bot',
      jwtSecret: 'test-secret',
    })
    const result = await svc.start('betsy-default')
    expect(result.nonce).toMatch(/^[0-9a-f-]{36}$/i)
    expect(result.deepLink).toBe(`https://t.me/betsyai_bot?start=${result.nonce}`)
    expect(result.expiresIn).toBe(300)
    expect(repo.create).toHaveBeenCalledWith(result.nonce, 'betsy-default')
  })

  it('start() rejects unknown preset id', async () => {
    const { repo } = makeMockRepo()
    const svc = new TgLinkService(repo as any, {
      botUsername: 'betsyai_bot',
      jwtSecret: 's',
    })
    await expect(svc.start('unknown-preset')).rejects.toThrow(/unknown preset/i)
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('poll() returns null while nonce not completed', async () => {
    const { repo, storage } = makeMockRepo()
    storage.push({
      nonce: 'n1',
      presetId: 'betsy-default',
      completedAt: null,
      workspaceId: null,
      jwt: null,
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    })
    const svc = new TgLinkService(repo as any, {
      botUsername: 'betsyai_bot',
      jwtSecret: 's',
    })
    expect(await svc.poll('n1')).toBeNull()
  })

  it('poll() returns {jwt, workspaceId} when completed', async () => {
    const { repo, storage } = makeMockRepo()
    storage.push({
      nonce: 'n2',
      presetId: 'betsy-default',
      completedAt: new Date(),
      workspaceId: 'ws-1',
      jwt: 'jwt-xyz',
      used: true,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    })
    const svc = new TgLinkService(repo as any, {
      botUsername: 'betsyai_bot',
      jwtSecret: 's',
    })
    const r = await svc.poll('n2')
    expect(r).toEqual({ jwt: 'jwt-xyz', workspaceId: 'ws-1' })
  })

  it('complete() mints jwt for given workspace and stores in repo', async () => {
    const { repo } = makeMockRepo()
    await repo.create('n3', 'betsy-default')
    const svc = new TgLinkService(repo as any, {
      botUsername: 'betsyai_bot',
      jwtSecret: 'secret',
    })
    const out = await svc.complete('n3', 'ws-abc')
    expect(out.workspaceId).toBe('ws-abc')
    expect(typeof out.jwt).toBe('string')
    expect(out.jwt.length).toBeGreaterThan(20)
    expect(repo.complete).toHaveBeenCalledWith('n3', 'ws-abc', out.jwt)

    // Verify the minted JWT is actually valid.
    const decoded = verifyJwt(out.jwt, 'secret')
    expect(decoded).not.toBeNull()
    expect(decoded?.sub).toBe('ws-abc')
    expect(decoded?.type).toBe('tg-link')
  })

  it('complete() throws if nonce is not active', async () => {
    const { repo } = makeMockRepo()
    const svc = new TgLinkService(repo as any, {
      botUsername: 'betsyai_bot',
      jwtSecret: 's',
    })
    await expect(svc.complete('missing', 'ws-x')).rejects.toThrow(/not active|expired|unknown/i)
  })

  it('getPresetId returns presetId of an active nonce', async () => {
    const { repo } = makeMockRepo()
    await repo.create('np1', 'betsy-pro')
    const svc = new TgLinkService(repo as any, {
      botUsername: 'betsyai_bot',
      jwtSecret: 's',
    })
    expect(await svc.getPresetId('np1')).toBe('betsy-pro')
  })

  it('getPresetId returns null when nonce is unknown', async () => {
    const { repo } = makeMockRepo()
    const svc = new TgLinkService(repo as any, {
      botUsername: 'betsyai_bot',
      jwtSecret: 's',
    })
    expect(await svc.getPresetId('does-not-exist')).toBeNull()
  })
})
