import { describe, expect, it, vi } from 'vitest'
import { TgLinkSweepRunner } from '../../../src/multi/auth/tg-link-sweep.js'

function makeLogger() {
  const infos: any[] = []
  const warns: any[] = []
  return {
    infos,
    warns,
    logger: {
      info: (m: string, meta?: any) => infos.push([m, meta]),
      warn: (m: string, meta?: any) => warns.push([m, meta]),
    },
  }
}

describe('TgLinkSweepRunner', () => {
  it('runOnce returns the count returned by the repo', async () => {
    const repo: any = { sweepExpired: vi.fn(async () => 7) }
    const { logger, infos } = makeLogger()
    const runner = new TgLinkSweepRunner({ repo, logger })
    const out = await runner.runOnce()
    expect(out.deleted).toBe(7)
    expect(repo.sweepExpired).toHaveBeenCalledTimes(1)
    expect(infos.find(([m]) => m === 'tg-link-sweep ran')).toBeTruthy()
  })

  it('runOnce swallows errors and logs warn', async () => {
    const repo: any = {
      sweepExpired: vi.fn(async () => {
        throw new Error('boom')
      }),
    }
    const { logger, warns } = makeLogger()
    const runner = new TgLinkSweepRunner({ repo, logger })
    const out = await runner.runOnce()
    expect(out.deleted).toBe(0)
    expect(warns.find(([m]) => m === 'tg-link-sweep failed')).toBeTruthy()
  })

  it('registerCron wires queue + worker + schedule on pg-boss', async () => {
    const repo: any = { sweepExpired: vi.fn(async () => 0) }
    const runner = new TgLinkSweepRunner({ repo })
    const boss = {
      createQueue: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
    }
    await runner.registerCron(boss)
    expect(boss.createQueue).toHaveBeenCalledWith('tg-link-sweep')
    expect(boss.work).toHaveBeenCalledWith('tg-link-sweep', expect.any(Function))
    expect(boss.schedule).toHaveBeenCalledWith('tg-link-sweep', '*/15 * * * *')
  })

  it('registerCron throws when boss is missing', async () => {
    const repo: any = { sweepExpired: vi.fn() }
    const runner = new TgLinkSweepRunner({ repo })
    await expect(runner.registerCron(null)).rejects.toThrow(/boss required/)
  })

  it('registerCron tolerates createQueue throwing (queue already exists)', async () => {
    const repo: any = { sweepExpired: vi.fn() }
    const runner = new TgLinkSweepRunner({ repo })
    const boss = {
      createQueue: vi.fn(async () => {
        throw new Error('already exists')
      }),
      work: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
    }
    await runner.registerCron(boss)
    expect(boss.work).toHaveBeenCalled()
    expect(boss.schedule).toHaveBeenCalled()
  })
})
