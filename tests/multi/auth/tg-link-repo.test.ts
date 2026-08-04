import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { TgLinkRepo } from '../../../src/multi/auth/tg-link-repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('TgLinkRepo', () => {
  let pool: Pool
  let repo: TgLinkRepo

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    repo = new TgLinkRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate bc_tg_link_nonces')
  })

  it('creates a nonce with ~5 min expiry', async () => {
    const before = Date.now()
    const n = await repo.create('abc-123', 'betsy-default')
    expect(n.nonce).toBe('abc-123')
    expect(n.presetId).toBe('betsy-default')
    expect(n.expiresAt.getTime()).toBeGreaterThan(before + 4 * 60_000)
    expect(n.completedAt).toBeNull()
    expect(n.used).toBe(false)
    expect(n.workspaceId).toBeNull()
    expect(n.jwt).toBeNull()
  })

  it('findActive returns nonce if not expired or used', async () => {
    await repo.create('n1', 'betsy-pro')
    const found = await repo.findActive('n1')
    expect(found?.presetId).toBe('betsy-pro')
  })

  it('findActive returns null for unknown nonce', async () => {
    const found = await repo.findActive('does-not-exist')
    expect(found).toBeNull()
  })

  it('findActive returns null for used nonce', async () => {
    await repo.create('n2', 'betsy-default')
    await repo.markUsed('n2')
    expect(await repo.findActive('n2')).toBeNull()
  })

  it('findActive returns null for expired nonce', async () => {
    await pool.query(
      `insert into bc_tg_link_nonces (nonce, preset_id, expires_at)
       values ('expired-x', 'betsy-default', now() - interval '1 minute')`,
    )
    expect(await repo.findActive('expired-x')).toBeNull()
  })

  it('findById returns the row regardless of used/expired state', async () => {
    await repo.create('n2b', 'betsy-default')
    await repo.markUsed('n2b')
    const r = await repo.findById('n2b')
    expect(r?.used).toBe(true)
  })

  it('complete sets workspace_id + jwt + completed_at + used', async () => {
    await repo.create('n3', 'betsy-default')
    const { rows } = await pool.query(
      `insert into workspaces (owner_tg_id) values (888001) returning id`,
    )
    const wsId = rows[0].id as string
    await repo.complete('n3', wsId, 'fake-jwt-xyz')
    const after = await repo.findById('n3')
    expect(after?.workspaceId).toBe(wsId)
    expect(after?.jwt).toBe('fake-jwt-xyz')
    expect(after?.completedAt).toBeInstanceOf(Date)
    expect(after?.used).toBe(true)
  })

  it('sweepExpired deletes nonces past expires_at', async () => {
    await pool.query(
      `insert into bc_tg_link_nonces (nonce, preset_id, expires_at)
       values ('expired-1', 'betsy-default', now() - interval '1 hour')`,
    )
    const deleted = await repo.sweepExpired()
    expect(deleted).toBe(1)
    expect(await repo.findActive('expired-1')).toBeNull()
  })
})
