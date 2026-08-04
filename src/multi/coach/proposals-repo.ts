// Fix3 — CoachAgent: persona tweak proposal persistence (bc_persona_tweak_proposals).
//
// All access goes through withWorkspace() so Postgres RLS enforces
// per-workspace isolation. No admin helpers here — every method requires a
// workspaceId.
import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'
import type { PersonaTweakProposal, PersonaTweakStatus } from './types.js'

function rowToProposal(r: any): PersonaTweakProposal {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    rationale: r.rationale,
    diff: { before: r.diff_before, after: r.diff_after },
    evidenceFeedbackIds: Array.isArray(r.evidence_feedback_ids)
      ? r.evidence_feedback_ids.map((x: unknown) => String(x))
      : [],
    status: r.status as PersonaTweakStatus,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? undefined,
    expiresAt: r.expires_at,
  }
}

export interface InsertProposalInput {
  rationale: string
  diff: { before: string; after: string }
  evidenceFeedbackIds: string[]
}

export class ProposalsRepo {
  constructor(private readonly pool: Pool) {}

  /** List still-pending, not-yet-expired proposals (newest first). */
  async listPending(workspaceId: string): Promise<PersonaTweakProposal[]> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const { rows } = await c.query(
        `select * from bc_persona_tweak_proposals
          where status = 'pending' and expires_at > now()
          order by created_at desc`,
      )
      return rows.map(rowToProposal)
    })
  }

  async get(
    workspaceId: string,
    id: string,
  ): Promise<PersonaTweakProposal | null> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const { rows } = await c.query(
        `select * from bc_persona_tweak_proposals where id = $1`,
        [id],
      )
      return rows[0] ? rowToProposal(rows[0]) : null
    })
  }

  async insert(
    workspaceId: string,
    input: InsertProposalInput,
  ): Promise<string> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const { rows } = await c.query(
        `insert into bc_persona_tweak_proposals
           (workspace_id, rationale, diff_before, diff_after, evidence_feedback_ids)
         values ($1, $2, $3, $4, $5::uuid[])
         returning id`,
        [
          workspaceId,
          input.rationale,
          input.diff.before,
          input.diff.after,
          input.evidenceFeedbackIds,
        ],
      )
      return rows[0].id as string
    })
  }

  async approve(workspaceId: string, id: string): Promise<PersonaTweakProposal | null> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const { rows } = await c.query(
        `update bc_persona_tweak_proposals
            set status = 'approved', decided_at = now()
          where id = $1 and status = 'pending'
          returning *`,
        [id],
      )
      return rows[0] ? rowToProposal(rows[0]) : null
    })
  }

  async reject(
    workspaceId: string,
    id: string,
    _reason?: string,
  ): Promise<PersonaTweakProposal | null> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const { rows } = await c.query(
        `update bc_persona_tweak_proposals
            set status = 'rejected', decided_at = now()
          where id = $1 and status = 'pending'
          returning *`,
        [id],
      )
      return rows[0] ? rowToProposal(rows[0]) : null
    })
  }

  /** Mark stale pending proposals as expired. Returns the number updated. */
  async expireOld(workspaceId: string): Promise<number> {
    return withWorkspace(this.pool, workspaceId, async (c) => {
      const res = await c.query(
        `update bc_persona_tweak_proposals
            set status = 'expired', decided_at = now()
          where status = 'pending' and expires_at <= now()`,
      )
      return res.rowCount ?? 0
    })
  }
}
