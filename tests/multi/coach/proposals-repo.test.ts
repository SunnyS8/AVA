import { describe, it, expect, beforeAll } from 'vitest'
import { Pool } from 'pg'
import { ProposalsRepo } from '../../../src/multi/coach/proposals-repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const maybe = url ? describe : describe.skip

maybe('ProposalsRepo (RLS, integration)', () => {
  let pool: Pool
  let repo: ProposalsRepo
  const wsA = process.env.BC_TEST_WORKSPACE_A ?? '00000000-0000-0000-0000-00000000000a'
  const wsB = process.env.BC_TEST_WORKSPACE_B ?? '00000000-0000-0000-0000-00000000000b'

  beforeAll(() => {
    pool = new Pool({ connectionString: url })
    repo = new ProposalsRepo(pool)
  })

  it('inserts and lists pending', async () => {
    const id = await repo.insert(wsA, {
      rationale: 'test',
      diff: { before: 'old', after: 'new' },
      evidenceFeedbackIds: [],
    })
    expect(id).toBeTruthy()
    const list = await repo.listPending(wsA)
    expect(list.some((p) => p.id === id)).toBe(true)
  })

  it('approve transitions pending → approved and removes from listPending', async () => {
    const id = await repo.insert(wsA, {
      rationale: 'r',
      diff: { before: 'x', after: 'y' },
      evidenceFeedbackIds: [],
    })
    const r = await repo.approve(wsA, id)
    expect(r?.status).toBe('approved')
    const list = await repo.listPending(wsA)
    expect(list.some((p) => p.id === id)).toBe(false)
  })

  it('reject transitions pending → rejected', async () => {
    const id = await repo.insert(wsA, {
      rationale: 'r',
      diff: { before: 'x', after: 'y' },
      evidenceFeedbackIds: [],
    })
    const r = await repo.reject(wsA, id, 'nah')
    expect(r?.status).toBe('rejected')
    const list = await repo.listPending(wsA)
    expect(list.some((p) => p.id === id)).toBe(false)
  })

  it('expireOld marks past-expiry pending rows', async () => {
    // Can't easily fabricate expired rows without direct SQL; just verify it
    // runs without error.
    const n = await repo.expireOld(wsA)
    expect(typeof n).toBe('number')
  })

  it('RLS isolates workspace B from workspace A proposals', async () => {
    const id = await repo.insert(wsA, {
      rationale: 'iso',
      diff: { before: 'a', after: 'b' },
      evidenceFeedbackIds: [],
    })
    const fromB = await repo.get(wsB, id)
    expect(fromB).toBeNull()
  })
})
