/**
 * P1.A — Postgres repo for Telegram deep-link nonces.
 *
 * All queries run via `asAdmin` because the target user has no workspace_id
 * at row-creation time (the workspace is created later by the /start handler).
 * The table still has FORCE ROW LEVEL SECURITY enabled defensively in case
 * a future code path scopes a query by workspace_id.
 */
import type { Pool } from 'pg'
import { asAdmin } from '../db/rls.js'
import type { TgLinkNonce } from './tg-link-types.js'

function rowToNonce(r: any): TgLinkNonce {
  return {
    nonce: r.nonce,
    presetId: r.preset_id,
    expiresAt: r.expires_at,
    workspaceId: r.workspace_id,
    jwt: r.jwt,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    used: r.used,
  }
}

export class TgLinkRepo {
  constructor(private pool: Pool) {}

  /** Creates a new nonce row with 5-minute TTL. */
  async create(nonce: string, presetId: string): Promise<TgLinkNonce> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `insert into bc_tg_link_nonces (nonce, preset_id, expires_at)
         values ($1, $2, now() + interval '5 minutes')
         returning *`,
        [nonce, presetId],
      )
      return rowToNonce(rows[0])
    })
  }

  /** Returns the row by nonce regardless of expiry/used status. Used by poll endpoint. */
  async findById(nonce: string): Promise<TgLinkNonce | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select * from bc_tg_link_nonces where nonce = $1`,
        [nonce],
      )
      return rows[0] ? rowToNonce(rows[0]) : null
    })
  }

  /** Returns nonce only if it exists, is not used, and is not expired. */
  async findActive(nonce: string): Promise<TgLinkNonce | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select * from bc_tg_link_nonces
         where nonce = $1 and used = false and expires_at > now()`,
        [nonce],
      )
      return rows[0] ? rowToNonce(rows[0]) : null
    })
  }

  /** Marks the nonce as used without completing it (e.g. for cancellation). */
  async markUsed(nonce: string): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update bc_tg_link_nonces set used = true where nonce = $1`,
        [nonce],
      )
    })
  }

  /** Sets workspace_id + jwt + completed_at + used=true atomically. */
  async complete(nonce: string, workspaceId: string, jwt: string): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update bc_tg_link_nonces
         set workspace_id = $2, jwt = $3, completed_at = now(), used = true
         where nonce = $1`,
        [nonce, workspaceId, jwt],
      )
    })
  }

  /** Deletes all expired nonces. Returns number of rows removed. */
  async sweepExpired(): Promise<number> {
    return asAdmin(this.pool, async (client) => {
      const { rowCount } = await client.query(
        `delete from bc_tg_link_nonces where expires_at < now()`,
      )
      return rowCount ?? 0
    })
  }
}
