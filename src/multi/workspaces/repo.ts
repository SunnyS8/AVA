import type { Pool } from 'pg'
import { asAdmin } from '../db/rls.js'
import type {
  Workspace,
  PlanType,
  WorkspaceStatus,
  ChannelName,
  NotifyPref,
} from './types.js'
import { getPreset } from '../personas/presets.js'
import type { PersonaRepo } from '../personas/repo.js'

function rowToWorkspace(r: any): Workspace {
  return {
    id: r.id,
    ownerTgId: r.owner_tg_id === null ? null : Number(r.owner_tg_id),
    ownerMaxId: r.owner_max_id === null ? null : Number(r.owner_max_id),
    displayName: r.display_name,
    businessContext: r.business_context,
    addressForm: r.address_form,
    personaId: r.persona_id,
    plan: r.plan as PlanType,
    status: r.status as WorkspaceStatus,
    tokensUsedPeriod: Number(r.tokens_used_period),
    tokensLimitPeriod: Number(r.tokens_limit_period),
    periodResetAt: r.period_reset_at,
    balanceKopecks: Number(r.balance_kopecks),
    lastActiveChannel: r.last_active_channel as ChannelName | null,
    notifyChannelPref: r.notify_channel_pref as NotifyPref,
    tz: r.tz,
    createdAt: r.created_at,
  }
}

/**
 * WorkspaceRepo performs all operations as admin (bypassing RLS)
 * because workspace lookup by tg_id/max_id happens BEFORE we know the workspace.
 * All OTHER repositories (Personas, Memory, Conversation) use withWorkspace.
 */
export class WorkspaceRepo {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<Workspace | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select * from workspaces where id = $1`,
        [id],
      )
      return rows[0] ? rowToWorkspace(rows[0]) : null
    })
  }

  async findByTelegram(tgId: number): Promise<Workspace | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select * from workspaces where owner_tg_id = $1`,
        [tgId],
      )
      return rows[0] ? rowToWorkspace(rows[0]) : null
    })
  }

  async findByMax(maxId: number): Promise<Workspace | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select * from workspaces where owner_max_id = $1`,
        [maxId],
      )
      return rows[0] ? rowToWorkspace(rows[0]) : null
    })
  }

  async upsertForTelegram(tgId: number): Promise<Workspace> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `insert into workspaces (owner_tg_id)
         values ($1)
         on conflict (owner_tg_id) do update set owner_tg_id = excluded.owner_tg_id
         returning *`,
        [tgId],
      )
      return rowToWorkspace(rows[0])
    })
  }

  async upsertForMax(maxId: number): Promise<Workspace> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `insert into workspaces (owner_max_id)
         values ($1)
         on conflict (owner_max_id) do update set owner_max_id = excluded.owner_max_id
         returning *`,
        [maxId],
      )
      return rowToWorkspace(rows[0])
    })
  }

  async updateStatus(id: string, status: WorkspaceStatus): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set status = $2 where id = $1`,
        [id, status],
      )
    })
  }

  async updatePlan(id: string, plan: PlanType): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set plan = $2 where id = $1`,
        [id, plan],
      )
    })
  }

  async updateLastActiveChannel(id: string, channel: ChannelName): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set last_active_channel = $2 where id = $1`,
        [id, channel],
      )
    })
  }

  async updateNotifyPref(id: string, pref: NotifyPref): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set notify_channel_pref = $2 where id = $1`,
        [id, pref],
      )
    })
  }

  async updateDisplayName(id: string, displayName: string): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set display_name = $2 where id = $1`,
        [id, displayName],
      )
    })
  }

  async updateBusinessContext(id: string, context: string): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set business_context = $2 where id = $1`,
        [id, context],
      )
    })
  }

  async updatePersonaId(id: string, personaId: string): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set persona_id = $2 where id = $1`,
        [id, personaId],
      )
    })
  }

  async updateOwnerTg(id: string, tgId: number): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set owner_tg_id = $2 where id = $1`,
        [id, tgId],
      )
    })
  }

  async updateOwnerMax(id: string, maxId: number): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set owner_max_id = $2 where id = $1`,
        [id, maxId],
      )
    })
  }

  /**
   * P1.A — Telegram deep-link login: wraps `upsertForTelegram` + creating a
   * persona from a built-in preset + linking persona_id in a single flow.
   *
   * Idempotent: if a workspace already exists for the given tgId and already
   * has a persona, returns it unchanged — preset switches on re-login are
   * intentionally NOT supported here (user can change persona later via the
   * control panel).
   *
   * Throws if `presetId` is not in the built-in catalog.
   */
  async createFromTelegramLogin(
    tgId: number,
    presetId: string,
    personas: PersonaRepo,
  ): Promise<Workspace> {
    const preset = getPreset(presetId)
    if (!preset) throw new Error(`unknown preset: ${presetId}`)

    // If the user has logged in before and already picked a persona, leave
    // their existing setup alone — don't silently swap presets.
    const existing = await this.findByTelegram(tgId)
    if (existing && existing.personaId) return existing

    const ws = await this.upsertForTelegram(tgId)

    // upsertForTelegram returns persona_id='betsy' by default (column default).
    // We need to check the *persona table* — if there's no real persona row
    // yet, create one from the preset and link it.
    const existingPersona = await personas.findByWorkspace(ws.id)
    if (!existingPersona) {
      const persona = await personas.create(ws.id, {
        presetId: preset.id,
        name: preset.name,
        gender: preset.gender,
        voiceId: preset.voiceId,
        personalityPrompt: preset.defaultPersonalityPrompt,
        biography: preset.biography,
        behaviorConfig: preset.defaultBehavior,
      })
      await this.updatePersonaId(ws.id, persona.id)
      const refreshed = await this.findById(ws.id)
      // findById must succeed: we just created the workspace.
      if (!refreshed) throw new Error('createFromTelegramLogin: workspace vanished after create')
      return refreshed
    }
    // Workspace existed without persona_id linked but persona row was already
    // there — link it now and return refreshed workspace.
    if (ws.personaId !== existingPersona.id) {
      await this.updatePersonaId(ws.id, existingPersona.id)
      const refreshed = await this.findById(ws.id)
      if (!refreshed) throw new Error('createFromTelegramLogin: workspace vanished after relink')
      return refreshed
    }
    return ws
  }
}
