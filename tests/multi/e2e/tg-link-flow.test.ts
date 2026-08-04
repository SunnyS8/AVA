/**
 * P1.A — end-to-end happy-path: Windows-app wizard begins login, user presses
 * /start in TG, app receives JWT through long-poll.
 *
 * Doesn't bring up the full multi-server (which needs Gemini + channels +
 * pg-boss). Instead wires the small subset of moving parts directly:
 *   - TgLinkRepo + TgLinkService against a real Postgres
 *   - In-process simulation of `/start <nonce>` via {@link handleStartCommand}
 *   - The HTTP poll handler called as a function (no socket)
 *
 * Gated on BC_TEST_DATABASE_URL — skips when unset.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { TgLinkRepo } from '../../../src/multi/auth/tg-link-repo.js'
import { TgLinkService } from '../../../src/multi/auth/tg-link-service.js'
import {
  createTgLinkStartHandler,
  createTgLinkPollHandler,
} from '../../../src/multi/auth/tg-link-http.js'
import { handleStartCommand } from '../../../src/multi/bot-router/tg-link-start.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { PersonaRepo } from '../../../src/multi/personas/repo.js'
import { verifyJwt } from '../../../src/multi/auth/jwt.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

// Minimal req/res mocks matching node:http shape needed by handlers.
function makeReq(method: string, path: string, body?: unknown): any {
  const handlers: Record<string, Array<(...args: any[]) => void>> = {}
  const req: any = {
    method,
    url: path,
    headers: {},
    on(event: string, cb: any) {
      ;(handlers[event] ||= []).push(cb)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== undefined) {
      const raw =
        typeof body === 'string' ? body : JSON.stringify(body)
      handlers.data?.forEach((cb) => cb(Buffer.from(raw, 'utf-8')))
    }
    handlers.end?.forEach((cb) => cb())
  })
  return req
}

function makeRes(): {
  res: any
  done: Promise<{ status: number; body: any }>
} {
  let resolve: (v: { status: number; body: any }) => void = () => {}
  const done = new Promise<{ status: number; body: any }>((r) => (resolve = r))
  let status = 0
  let body = ''
  const res: any = {
    headersSent: false,
    setHeader: () => {},
    writeHead: (s: number) => {
      status = s
      res.headersSent = true
    },
    end: (b: string) => {
      body = b
      try {
        resolve({ status, body: body ? JSON.parse(body) : {} })
      } catch {
        resolve({ status, body })
      }
    },
  }
  return { res, done }
}

d('e2e tg-link flow', () => {
  let pool: Pool
  let repo: TgLinkRepo
  let service: TgLinkService
  let workspaces: WorkspaceRepo
  let personas: PersonaRepo
  let startHandler: ReturnType<typeof createTgLinkStartHandler>
  let pollHandler: ReturnType<typeof createTgLinkPollHandler>

  const JWT_SECRET = 'e2e-secret'

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    repo = new TgLinkRepo(pool)
    service = new TgLinkService(repo, {
      botUsername: 'betsyai_bot',
      jwtSecret: JWT_SECRET,
    })
    workspaces = new WorkspaceRepo(pool)
    personas = new PersonaRepo(pool)
    startHandler = createTgLinkStartHandler({ service })
    pollHandler = createTgLinkPollHandler({ service, repo })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(`delete from workspaces where owner_tg_id in (999001, 999002)`)
    await pool.query(`truncate bc_tg_link_nonces`)
  })

  it('full flow: start → bot /start → poll returns jwt', async () => {
    // 1. App calls /auth/tg-link/start
    const startReq = makeReq('POST', '/auth/tg-link/start', {
      presetId: 'betsy-default',
    })
    const startResC = makeRes()
    await startHandler(startReq, startResC.res)
    const startBody = (await startResC.done).body as {
      nonce: string
      deepLink: string
      expiresIn: number
    }
    expect(startBody.nonce).toMatch(/^[0-9a-f-]{36}$/i)
    expect(startBody.deepLink).toContain(startBody.nonce)

    // 2. Start the long-poll in parallel.
    const pollReq = makeReq(
      'GET',
      `/auth/tg-link/poll?nonce=${startBody.nonce}&maxWaitMs=5000`,
    )
    const pollResC = makeRes()
    const pollPromise = pollHandler(pollReq, pollResC.res)

    // 3. After a brief delay, simulate the user pressing /start in TG.
    setTimeout(() => {
      void handleStartCommand(
        { tgUserId: 999001, payload: startBody.nonce },
        {
          tgLinkService: service,
          workspaces,
          personas,
          sendMessage: () => Promise.resolve(),
        },
      )
    }, 200)

    // 4. Poll resolves with jwt + workspaceId.
    await pollPromise
    const polled = (await pollResC.done) as { status: number; body: any }
    expect(polled.status).toBe(200)
    expect(typeof polled.body.jwt).toBe('string')
    expect(typeof polled.body.workspaceId).toBe('string')

    // 5. JWT is valid and references the new workspace.
    const decoded = verifyJwt(polled.body.jwt, JWT_SECRET)
    expect(decoded).not.toBeNull()
    expect(decoded?.sub).toBe(polled.body.workspaceId)

    // 6. Workspace has a persona linked.
    const { rows } = await pool.query(
      `select persona_id from workspaces where id = $1`,
      [polled.body.workspaceId],
    )
    expect(rows[0].persona_id).not.toBeNull()
  })

  it('replay protection: same nonce, second /start no-op (already used)', async () => {
    // 1. start
    const startReq = makeReq('POST', '/auth/tg-link/start', {
      presetId: 'betsy-default',
    })
    const startResC = makeRes()
    await startHandler(startReq, startResC.res)
    const { nonce } = (await startResC.done).body as { nonce: string }

    // 2. simulate the first /start — completes the nonce
    await handleStartCommand(
      { tgUserId: 999002, payload: nonce },
      {
        tgLinkService: service,
        workspaces,
        personas,
        sendMessage: () => Promise.resolve(),
      },
    )

    // 3. second /start with the same nonce — handler should gracefully tell
    //    the user the link is stale; nonce row stays in completed state.
    await expect(
      handleStartCommand(
        { tgUserId: 999002, payload: nonce },
        {
          tgLinkService: service,
          workspaces,
          personas,
          sendMessage: () => Promise.resolve(),
        },
      ),
    ).resolves.not.toThrow()

    const { rows } = await pool.query(
      `select used, completed_at from bc_tg_link_nonces where nonce = $1`,
      [nonce],
    )
    expect(rows[0].used).toBe(true)
    expect(rows[0].completed_at).not.toBeNull()
  })
})
