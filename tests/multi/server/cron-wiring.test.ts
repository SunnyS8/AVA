// Fix4 — unit tests for pg-boss cron wiring + admin trigger endpoint.
// Uses a mock boss so we never touch real Postgres.
import { describe, it, expect, vi } from 'vitest'
import {
  registerCronWiring,
  createAdminCronHandler,
  type CronRunners,
  type MinimalLogger,
} from '../../../src/multi/cron-wiring.js'

function makeLogger(): MinimalLogger & {
  infos: Array<[string, any]>
  warns: Array<[string, any]>
} {
  const infos: Array<[string, any]> = []
  const warns: Array<[string, any]> = []
  return {
    infos,
    warns,
    info: (m, meta) => infos.push([m, meta]),
    warn: (m, meta) => warns.push([m, meta]),
    error: () => {},
  }
}

function makeRunners(overrides: Partial<CronRunners> = {}): CronRunners & {
  learnerRegister: ReturnType<typeof vi.fn>
  coachRegister: ReturnType<typeof vi.fn>
  skillsRegister: ReturnType<typeof vi.fn>
  learnerRun: ReturnType<typeof vi.fn>
  coachRun: ReturnType<typeof vi.fn>
} {
  const learnerRegister = vi.fn(async () => {})
  const coachRegister = vi.fn(async () => {})
  const skillsRegister = vi.fn(async () => ({ registered: 3 }))
  const learnerRun = vi.fn(async () => ({ ok: true }))
  const coachRun = vi.fn(async () => ({ ok: true }))
  return {
    learner: { registerCron: learnerRegister, runNightly: learnerRun },
    skillManager: { registerCronTriggers: skillsRegister },
    coach: { registerCron: coachRegister, runNightly: coachRun },
    learnerRegister,
    coachRegister,
    skillsRegister,
    learnerRun,
    coachRun,
    ...overrides,
  } as any
}

describe('registerCronWiring', () => {
  it('calls all three registerCron methods on happy path', async () => {
    const r = makeRunners()
    const logger = makeLogger()
    const boss = { schedule: vi.fn(), work: vi.fn() }
    await registerCronWiring(boss, r, logger)
    expect(r.learnerRegister).toHaveBeenCalledWith(boss)
    expect(r.skillsRegister).toHaveBeenCalledWith(boss)
    expect(r.coachRegister).toHaveBeenCalledWith(boss)
    expect(logger.infos.map((x) => x[0])).toContain('learner cron registered')
    expect(logger.infos.map((x) => x[0])).toContain('skill cron triggers registered')
    expect(logger.infos.map((x) => x[0])).toContain('coach cron registered')
  })

  it('isolates failures: if learner throws, skills and coach still register', async () => {
    const r = makeRunners()
    r.learnerRegister.mockRejectedValueOnce(new Error('learner boom'))
    const logger = makeLogger()
    await registerCronWiring({}, r, logger)
    expect(r.skillsRegister).toHaveBeenCalled()
    expect(r.coachRegister).toHaveBeenCalled()
    expect(logger.warns.map((x) => x[0])).toContain('learner cron registration failed')
  })

  it('isolates failures: if skills throws, learner and coach still register', async () => {
    const r = makeRunners()
    r.skillsRegister.mockRejectedValueOnce(new Error('skills boom'))
    const logger = makeLogger()
    await registerCronWiring({}, r, logger)
    expect(r.learnerRegister).toHaveBeenCalled()
    expect(r.coachRegister).toHaveBeenCalled()
    expect(logger.warns.map((x) => x[0])).toContain('skill cron registration failed')
  })
})

// --- admin endpoint ---

function mockReqRes(
  headers: Record<string, string>,
  url: string,
): {
  req: any
  res: any
  getStatus: () => number
  getBody: () => any
} {
  let status = 0
  let body = ''
  const req: any = { headers, url, method: 'POST' }
  const res: any = {
    writeHead: (s: number) => {
      status = s
    },
    end: (b: string) => {
      body = b
    },
  }
  return {
    req,
    res,
    getStatus: () => status,
    getBody: () => JSON.parse(body || '{}'),
  }
}

describe('createAdminCronHandler', () => {
  it('returns 503 when secret is unset', async () => {
    const runners = makeRunners()
    const handler = createAdminCronHandler({
      runners,
      secret: undefined,
      logger: makeLogger(),
    })
    const { req, res, getStatus } = mockReqRes({}, '/admin/cron/run?name=coach')
    await handler(req, res)
    expect(getStatus()).toBe(503)
    expect(runners.coachRun).not.toHaveBeenCalled()
  })

  it('returns 401 when Authorization header is missing or wrong', async () => {
    const runners = makeRunners()
    const handler = createAdminCronHandler({
      runners,
      secret: 's3cret',
      logger: makeLogger(),
    })
    const a = mockReqRes({}, '/admin/cron/run?name=coach')
    await handler(a.req, a.res)
    expect(a.getStatus()).toBe(401)

    const b = mockReqRes(
      { authorization: 'Bearer wrong' },
      '/admin/cron/run?name=coach',
    )
    await handler(b.req, b.res)
    expect(b.getStatus()).toBe(401)
    expect(runners.coachRun).not.toHaveBeenCalled()
  })

  it('returns 400 when name is missing or not whitelisted', async () => {
    const runners = makeRunners()
    const handler = createAdminCronHandler({
      runners,
      secret: 's3cret',
      logger: makeLogger(),
    })
    const a = mockReqRes(
      { authorization: 'Bearer s3cret' },
      '/admin/cron/run',
    )
    await handler(a.req, a.res)
    expect(a.getStatus()).toBe(400)

    const b = mockReqRes(
      { authorization: 'Bearer s3cret' },
      '/admin/cron/run?name=evil',
    )
    await handler(b.req, b.res)
    expect(b.getStatus()).toBe(400)
  })

  it('runs coach.runNightly on 200 happy path and logs without secret', async () => {
    const runners = makeRunners()
    const logger = makeLogger()
    const handler = createAdminCronHandler({
      runners,
      secret: 's3cret',
      logger,
    })
    const { req, res, getStatus, getBody } = mockReqRes(
      { authorization: 'Bearer s3cret' },
      '/admin/cron/run?name=coach',
    )
    await handler(req, res)
    expect(getStatus()).toBe(200)
    expect(getBody()).toEqual({ status: 'ok', name: 'coach' })
    expect(runners.coachRun).toHaveBeenCalledTimes(1)

    // secret must NEVER appear in logs
    const serialized = JSON.stringify(logger.infos.concat(logger.warns))
    expect(serialized).not.toContain('s3cret')
  })

  it('runs learner.runNightly for name=learner', async () => {
    const runners = makeRunners()
    const handler = createAdminCronHandler({
      runners,
      secret: 's3cret',
      logger: makeLogger(),
    })
    const { req, res, getStatus } = mockReqRes(
      { authorization: 'Bearer s3cret' },
      '/admin/cron/run?name=learner',
    )
    await handler(req, res)
    expect(getStatus()).toBe(200)
    expect(runners.learnerRun).toHaveBeenCalledTimes(1)
  })

  it('returns 500 if runner throws', async () => {
    const runners = makeRunners()
    runners.coachRun.mockRejectedValueOnce(new Error('coach boom'))
    const handler = createAdminCronHandler({
      runners,
      secret: 's3cret',
      logger: makeLogger(),
    })
    const { req, res, getStatus } = mockReqRes(
      { authorization: 'Bearer s3cret' },
      '/admin/cron/run?name=coach',
    )
    await handler(req, res)
    expect(getStatus()).toBe(500)
  })
})
