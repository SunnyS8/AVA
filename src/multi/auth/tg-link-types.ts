/**
 * P1.A — Types for the Telegram deep-link login flow.
 */

export interface TgLinkNonce {
  nonce: string
  presetId: string
  expiresAt: Date
  workspaceId: string | null
  jwt: string | null
  completedAt: Date | null
  createdAt: Date
  used: boolean
}

/** Returned by service when nonce is completed (user pressed /start). */
export interface TgLinkResult {
  jwt: string
  workspaceId: string
}
