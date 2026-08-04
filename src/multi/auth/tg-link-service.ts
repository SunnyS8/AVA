/**
 * P1.A — Business logic for the Telegram deep-link login flow.
 *
 * Sits between the HTTP / bot handlers and {@link TgLinkRepo}. Responsible for:
 *   - generating UUIDv4 nonces
 *   - validating the requested presetId against the static catalog
 *   - building the t.me deep link
 *   - polling for completion
 *   - minting the workspace JWT once /start arrives
 */
import { randomUUID } from 'node:crypto'
import { getPreset } from '../personas/presets.js'
import { signJwt } from './jwt.js'
import type { TgLinkRepo } from './tg-link-repo.js'
import type { TgLinkResult } from './tg-link-types.js'

export interface TgLinkServiceConfig {
  /** Bot username without @ (e.g. "betsyai_bot"). */
  botUsername: string
  /** HS256 secret for minted JWTs. */
  jwtSecret: string
  /** JWT validity in seconds. Default 60 days. */
  jwtTtlSeconds?: number
}

export interface TgLinkStartResult {
  nonce: string
  deepLink: string
  /** Seconds until the nonce expires. Constant 300 (5 min) for now. */
  expiresIn: number
}

const DEFAULT_JWT_TTL_SECONDS = 60 * 60 * 24 * 60 // 60 days
const NONCE_TTL_SECONDS = 5 * 60

export class TgLinkService {
  constructor(
    private repo: TgLinkRepo,
    private config: TgLinkServiceConfig,
  ) {}

  /**
   * Begin a new login session for the given preset. Generates a fresh UUIDv4
   * nonce, persists it with a 5-minute TTL, and returns the deep link the
   * Windows-app should open in the user's browser.
   */
  async start(presetId: string): Promise<TgLinkStartResult> {
    if (!getPreset(presetId)) {
      throw new Error(`unknown preset: ${presetId}`)
    }
    const nonce = randomUUID()
    await this.repo.create(nonce, presetId)
    return {
      nonce,
      deepLink: `https://t.me/${this.config.botUsername}?start=${nonce}`,
      expiresIn: NONCE_TTL_SECONDS,
    }
  }

  /**
   * Returns {jwt, workspaceId} if the nonce has been completed by the bot
   * handler, or null if it's still pending. Used by the long-poll endpoint.
   */
  async poll(nonce: string): Promise<TgLinkResult | null> {
    const row = await this.repo.findById(nonce)
    if (!row || !row.completedAt || !row.jwt || !row.workspaceId) return null
    return { jwt: row.jwt, workspaceId: row.workspaceId }
  }

  /**
   * Called by the bot handler on `/start <nonce>`. Validates the nonce is
   * still active, mints a workspace JWT, and persists it on the nonce row
   * so the long-poll endpoint can hand it back to the Windows-app.
   */
  async complete(nonce: string, workspaceId: string): Promise<TgLinkResult> {
    const active = await this.repo.findActive(nonce)
    if (!active) {
      throw new Error(`nonce not active: ${nonce}`)
    }
    const ttl = this.config.jwtTtlSeconds ?? DEFAULT_JWT_TTL_SECONDS
    const jwt = signJwt({ sub: workspaceId, type: 'tg-link' }, this.config.jwtSecret, ttl)
    await this.repo.complete(nonce, workspaceId, jwt)
    return { jwt, workspaceId }
  }

  /**
   * Read presetId out of an active nonce. Used by the bot handler so it
   * knows which preset to apply when creating the workspace.
   * Returns null when the nonce is unknown, expired, or already used.
   */
  async getPresetId(nonce: string): Promise<string | null> {
    const active = await this.repo.findActive(nonce)
    return active?.presetId ?? null
  }
}
