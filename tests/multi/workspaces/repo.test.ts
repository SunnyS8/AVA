import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { PersonaRepo } from '../../../src/multi/personas/repo.js'
import { getPreset } from '../../../src/multi/personas/presets.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('WorkspaceRepo', () => {
  let pool: Pool
  let repo: WorkspaceRepo

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    repo = new WorkspaceRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
  })

  it('upsertForTelegram creates new workspace', async () => {
    const ws = await repo.upsertForTelegram(12345)
    expect(ws.ownerTgId).toBe(12345)
    expect(ws.status).toBe('onboarding')
    expect(ws.plan).toBe('trial')
    expect(ws.personaId).toBe('betsy')
  })

  it('upsertForTelegram is idempotent', async () => {
    const a = await repo.upsertForTelegram(99)
    const b = await repo.upsertForTelegram(99)
    expect(a.id).toBe(b.id)
  })

  it('upsertForMax creates for MAX id', async () => {
    const ws = await repo.upsertForMax(777)
    expect(ws.ownerMaxId).toBe(777)
    expect(ws.ownerTgId).toBeNull()
  })

  it('updateStatus changes status', async () => {
    const ws = await repo.upsertForTelegram(1)
    await repo.updateStatus(ws.id, 'active')
    const found = await repo.findById(ws.id)
    expect(found?.status).toBe('active')
  })

  it('updatePlan changes plan', async () => {
    const ws = await repo.upsertForTelegram(1)
    await repo.updatePlan(ws.id, 'personal')
    const found = await repo.findById(ws.id)
    expect(found?.plan).toBe('personal')
  })

  it('updateLastActiveChannel tracks channel', async () => {
    const ws = await repo.upsertForTelegram(1)
    await repo.updateLastActiveChannel(ws.id, 'telegram')
    const found = await repo.findById(ws.id)
    expect(found?.lastActiveChannel).toBe('telegram')
  })

  it('findByTelegram returns workspace by tg id', async () => {
    const created = await repo.upsertForTelegram(55)
    const found = await repo.findByTelegram(55)
    expect(found?.id).toBe(created.id)
  })

  it('findByTelegram returns null for unknown', async () => {
    const found = await repo.findByTelegram(9999)
    expect(found).toBeNull()
  })
})

d('WorkspaceRepo.createFromTelegramLogin', () => {
  let pool: Pool
  let workspaces: WorkspaceRepo
  let personas: PersonaRepo

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    workspaces = new WorkspaceRepo(pool)
    personas = new PersonaRepo(pool)
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
  })

  it('creates workspace + persona from preset, links persona_id', async () => {
    const ws = await workspaces.createFromTelegramLogin(555001, 'betsy-default', personas)
    expect(ws.ownerTgId).toBe(555001)
    expect(ws.personaId).not.toBeNull()
    const persona = await personas.findById(ws.id, ws.personaId!)
    expect(persona).not.toBeNull()
    const preset = getPreset('betsy-default')!
    expect(persona!.name).toBe(preset.name)
    expect(persona!.voiceId).toBe(preset.voiceId)
    expect(persona!.personalityPrompt).toBe(preset.defaultPersonalityPrompt)
  })

  it('idempotent — second call returns existing workspace, does not create extra persona', async () => {
    const ws1 = await workspaces.createFromTelegramLogin(555002, 'betsy-default', personas)
    const ws2 = await workspaces.createFromTelegramLogin(555002, 'betsy-pro', personas)
    expect(ws1.id).toBe(ws2.id)
    // persona id stays the same — re-login doesn't switch presets
    expect(ws2.personaId).toBe(ws1.personaId)
  })

  it('throws on unknown preset', async () => {
    await expect(
      workspaces.createFromTelegramLogin(555003, 'unknown-preset', personas),
    ).rejects.toThrow(/unknown preset/i)
  })
})
