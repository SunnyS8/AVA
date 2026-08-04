/**
 * P1.A — Telegram bot `/start <nonce>` handler for the Windows-app wizard.
 *
 * When the user presses Start in the t.me/<bot>?start=<nonce> deep link,
 * Telegram delivers a message like `/start <nonce>`. We:
 *   1. Look up the presetId stored against the nonce.
 *   2. Create-or-fetch the workspace for the user and link the preset's
 *      persona.
 *   3. Mark the nonce as completed and stash the workspace JWT — the
 *      Windows-app polling the /auth/tg-link/poll endpoint picks it up.
 *   4. Send the user a one-liner confirmation.
 *
 * Extracted from `router.ts` so it can be unit-tested without bringing up
 * the whole bot router.
 */
import { getPreset } from '../personas/presets.js'
import type { TgLinkService } from '../auth/tg-link-service.js'
import type { WorkspaceRepo } from '../workspaces/repo.js'
import type { PersonaRepo } from '../personas/repo.js'

export interface StartCommandEvent {
  /** Telegram numeric user id (chat id for a private chat). */
  tgUserId: number
  /** Payload after `/start ` — empty string when the user opened the bot
   *  directly without a deep link. */
  payload: string
}

export interface StartCommandDeps {
  tgLinkService: Pick<TgLinkService, 'getPresetId' | 'complete'>
  workspaces: Pick<WorkspaceRepo, 'createFromTelegramLogin'>
  personas: PersonaRepo
  /** Used to send the success / stale-link reply to the user. */
  sendMessage: (tgUserId: number, text: string) => Promise<void> | void
  /** Called when /start has no nonce — the existing onboarding flow. */
  plainStart?: (tgUserId: number) => Promise<void> | void
}

/**
 * Handle one `/start <payload>` event.
 *
 * - When payload is empty, defers to {@link StartCommandDeps.plainStart} if
 *   provided, otherwise no-ops (router's existing onboarding flow handles it).
 * - When payload is a known active nonce, creates/links the workspace +
 *   completes the nonce + sends a Russian confirmation.
 * - When the nonce is unknown/expired/used, sends a "ссылка устарела" message.
 */
export async function handleStartCommand(
  event: StartCommandEvent,
  deps: StartCommandDeps,
): Promise<void> {
  const { tgUserId } = event
  const nonce = event.payload.trim()

  if (!nonce) {
    if (deps.plainStart) await deps.plainStart(tgUserId)
    return
  }

  const presetId = await deps.tgLinkService.getPresetId(nonce)
  if (!presetId) {
    await deps.sendMessage(
      tgUserId,
      'Ссылка устарела. Открой Бетси на компьютере и нажми «Войти через Telegram» снова.',
    )
    return
  }

  const ws = await deps.workspaces.createFromTelegramLogin(tgUserId, presetId, deps.personas)
  await deps.tgLinkService.complete(nonce, ws.id)

  const preset = getPreset(presetId)
  const personaName = preset?.name ?? 'Бетси'
  await deps.sendMessage(
    tgUserId,
    `Готово! Я — ${personaName}. Пиши мне сюда, я отвечу.`,
  )
}
