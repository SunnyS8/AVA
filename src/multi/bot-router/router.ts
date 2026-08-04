import type { InboundEvent, ChannelAdapter, ChannelName } from '../channels/base.js'
import type { WorkspaceRepo } from '../workspaces/repo.js'
import type { PersonaRepo } from '../personas/repo.js'
import type { FactsRepo } from '../memory/facts-repo.js'
import type { ConversationRepo } from '../memory/conversation-repo.js'
import type { LinkingService } from '../linking/service.js'
import type {
  runBetsy as runBetsyType,
  runBetsyStream as runBetsyStreamType,
  RunBetsyDeps,
} from '../agents/runner.js'
import {
  nextOnboardingStep,
  parseOnboardingAnswer,
  isOnboardingComplete,
} from './onboarding-flow.js'
import { handleCommand } from './commands.js'
import { handleStartCommand } from './tg-link-start.js'
import type { TgLinkService } from '../auth/tg-link-service.js'
import { log } from '../observability/logger.js'
import { drainPendingMedia, clearPendingMedia } from '../agents/pending-media.js'
import { getChatAction, clearChatAction } from '../agents/chat-action-state.js'
import { InboundCoalescer } from './inbound-coalescer.js'
import { classifyIntent, type ClassifierAction } from '../agents/intent-classifier.js'
// FIX2: generate feedback refId for stream path so telegram adapter attaches
// the 👍/👎 keyboard under the assistant's reply.
import { getFeedbackRefStore, FeedbackRefStore } from '../feedback/ref-store.js'
import { feedbackEnabled } from '../channels/telegram.js'

const COALESCE_DEBOUNCE_MS = Number(process.env.BC_INBOUND_DEBOUNCE_MS ?? 0)
const COALESCE_MIN_DEBOUNCE_MS = Number(process.env.BC_INBOUND_MIN_DEBOUNCE_MS ?? 0)
const COALESCE_MAX_DEBOUNCE_MS = Number(process.env.BC_INBOUND_MAX_DEBOUNCE_MS ?? 15000)
const COALESCE_MAX_WAIT_MS = Number(process.env.BC_INBOUND_MAX_WAIT_MS ?? 30000)
const COALESCE_MAX_BATCH = Number(process.env.BC_INBOUND_MAX_BATCH ?? 10)

async function deliverPendingMedia(
  workspaceId: string,
  channel: ChannelAdapter,
  chatId: string,
): Promise<void> {
  const items = drainPendingMedia(workspaceId)
  for (const item of items) {
    try {
      if (item.kind === 'photo') {
        await channel.sendMessage({
          chatId,
          text: '',
          image: { base64: item.buffer.toString('base64'), mimeType: item.mimeType },
        })
        log().info('media: photo delivered', { workspaceId, bytes: item.buffer.length })
      }
      // future: video circles → channel.sendVideo
    } catch (e) {
      log().error('media: delivery failed', {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
}

export interface BotRouterDeps {
  wsRepo: WorkspaceRepo
  personaRepo: PersonaRepo
  factsRepo: FactsRepo
  convRepo?: ConversationRepo
  linkingSvc: LinkingService
  channels: Partial<Record<ChannelName, ChannelAdapter>>
  runBetsyFn: typeof runBetsyType
  /** Optional streaming variant; when present and the channel supports
   *  streamMessage, used in preference to runBetsyFn for normal messages. */
  runBetsyStreamFn?: typeof runBetsyStreamType
  runBetsyDeps: RunBetsyDeps
  /** P1.A — when set, `/start <nonce>` from the Windows-app wizard deep-link
   *  routes through {@link handleStartCommand} to bind the workspace to the
   *  chosen preset before the normal onboarding flow runs. */
  tgLinkService?: TgLinkService
}

const TG_START_NONCE_RE = /^\/start(?:@\S+)?\s+(\S.*)$/

const LINK_CODE_RE = /^\s*(\d{6})\s*$/

/**
 * Fix5: merge a coalesced batch of inbound events into one logical inbound.
 * Exported (not a class method) so it can be unit-tested directly without
 * standing up an entire BotRouter.
 *
 * Rules:
 *  - Text: join non-empty texts in arrival order with "\n".
 *  - Attachments: concat in arrival order; empty → undefined.
 *  - replyToText: first non-empty wins.
 *  - mediaGroupId: first defined wins (album events share the same id).
 *  - Everything else is taken from the LAST event (chatId, messageId, ts).
 */
export function mergeInboundBatch(batch: InboundEvent[]): InboundEvent {
  if (batch.length === 0) throw new Error('mergeInboundBatch: empty batch')
  const last = batch[batch.length - 1]
  const combinedText = batch
    .map((e) => e.text ?? '')
    .filter((t) => t.length > 0)
    .join('\n')
  const mergedAttachments = batch.flatMap((e) => e.attachments ?? [])
  const replyToText = batch.map((e) => e.replyToText).find((v) => !!v)
  const mediaGroupId = batch.map((e) => e.mediaGroupId).find((v) => !!v)
  return {
    ...last,
    text: combinedText,
    attachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
    replyToText,
    mediaGroupId,
  }
}

// 2 attempts only — tools have their OWN internal retries (selfie does
// 4 retries × 2 models = up to 8 calls). Adding router-level retry on top
// just re-runs the entire agent loop and duplicates tool work.
const MAX_ATTEMPTS = 2
// 240s — selfie generation via Nano Banana 3.1 can legitimately take
// 40-210 seconds (preview model is slow), and the tool itself has internal
// retries on 429/5xx that can multiply this. Anything shorter cuts off work
// in progress and triggers a useless retry that re-runs the tool.
const ATTEMPT_TIMEOUT_MS = 240_000
const RETRY_DELAYS_MS = [2_000]

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function startTypingLoop(
  channel: ChannelAdapter,
  chatId: string,
  workspaceId: string,
): () => void {
  if (!channel.sendTyping) return () => {}
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try {
      // Override comes from chat-action-state — tools (e.g. selfie) flip it
      // to "upload_photo" while they're working, then clear it when done.
      const action = getChatAction(workspaceId)
      await channel.sendTyping!(chatId, action)
    } catch {
      // ignore
    }
  }
  void tick()
  // 3s — Telegram chat actions auto-expire after ~5s, so this keeps the
  // indicator continuous and reacts quickly when a tool flips the override.
  const interval = setInterval(tick, 3000)
  return () => {
    stopped = true
    clearInterval(interval)
    clearChatAction(workspaceId)
  }
}

export class BotRouter {
  private coalescer: InboundCoalescer
  /** Tracks in-flight processBatch promises so graceful shutdown can wait. */
  private inFlight = new Set<Promise<unknown>>()
  /** When true, new inbound is dropped — set during shutdown. */
  private shuttingDown = false

  constructor(private deps: BotRouterDeps) {
    this.coalescer = new InboundCoalescer(
      {
        debounceMs: COALESCE_DEBOUNCE_MS,
        minDebounceMs: COALESCE_MIN_DEBOUNCE_MS,
        maxDebounceMs: COALESCE_MAX_DEBOUNCE_MS,
        maxWaitMs: COALESCE_MAX_WAIT_MS,
        maxBatchSize: COALESCE_MAX_BATCH,
      },
      (batch) => this.runTracked(() => this.processBatch(batch)),
    )
  }

  /**
   * Wraps a piece of work so that {@link drainInFlight} can wait for it
   * during graceful shutdown. Errors are swallowed to keep the set clean
   * (the inner code logs them itself).
   */
  private runTracked<T>(fn: () => Promise<T>): Promise<T> {
    const p = (async () => {
      try {
        return await fn()
      } catch (e) {
        log().error('runTracked: work failed', {
          error: e instanceof Error ? e.message : String(e),
        })
        throw e
      }
    })()
    this.inFlight.add(p as any)
    void p.finally(() => this.inFlight.delete(p as any))
    return p
  }

  /**
   * Wait for all currently-running processBatch invocations to complete
   * (or for `timeoutMs` to elapse). Used by graceful shutdown so we don't
   * kill in-flight selfie generations that take 1-3 minutes.
   */
  async drainInFlight(timeoutMs: number): Promise<void> {
    this.shuttingDown = true
    const start = Date.now()
    while (this.inFlight.size > 0) {
      const remaining = timeoutMs - (Date.now() - start)
      if (remaining <= 0) {
        log().warn('drainInFlight: timeout, abandoning in-flight work', {
          count: this.inFlight.size,
        })
        return
      }
      log().info('drainInFlight: waiting', {
        inFlight: this.inFlight.size,
        remainingMs: remaining,
      })
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((r) => setTimeout(r, Math.min(remaining, 2000))),
      ])
    }
    log().info('drainInFlight: done')
  }

  attach(): void {
    for (const adapter of Object.values(this.deps.channels)) {
      if (!adapter) continue
      adapter.onMessage((ev) => {
        if (this.shuttingDown) {
          log().info('inbound dropped: shutting down', { channel: ev.channel })
          return Promise.resolve()
        }
        this.coalescer.push(ev)
        return Promise.resolve()
      })
    }
  }

  /**
   * Called by the coalescer with a batch of 1+ events from the same user.
   * Builds a single combined InboundEvent (texts joined) and routes it
   * through the existing handleInbound pipeline. Each original message is
   * still persisted as its own row in conversation history (handled inside
   * handleInbound by appending the combined event once — the granular
   * messages are stored individually below).
   */
  private async processBatch(batch: InboundEvent[]): Promise<void> {
    if (batch.length === 1) {
      await this.handleInbound(batch[0])
      return
    }
    const combined = mergeInboundBatch(batch)
    log().info('coalescer: processing batch', {
      channel: combined.channel,
      userId: combined.userId,
      count: batch.length,
      combinedLen: combined.text.length,
      attachmentCount: combined.attachments?.length ?? 0,
      mediaGroupId: combined.mediaGroupId,
    })
    await this.handleInbound(combined)
  }

  async handleInbound(ev: InboundEvent): Promise<void> {
    log().info('inbound received', {
      channel: ev.channel,
      userId: String(ev.userId),
      chatId: String(ev.chatId),
      textLen: ev.text?.length ?? 0,
      hasVoice: Boolean((ev as any).voice),
    })
    try {
      const channel = this.deps.channels[ev.channel]
      if (!channel) {
        log().warn('inbound: no channel adapter', { channel: ev.channel })
        return
      }

      // P1.A — Windows-app wizard deep-link: `/start <nonce>` from Telegram.
      // Handled BEFORE workspace resolution because the start handler is the
      // one that creates the workspace (binding it to the chosen preset).
      // Plain `/start` (no payload) falls through to the existing onboarding
      // path below.
      const startNonceMatch =
        ev.channel === 'telegram' && this.deps.tgLinkService
          ? ev.text.match(TG_START_NONCE_RE)
          : null
      if (startNonceMatch) {
        const payload = startNonceMatch[1].trim()
        log().info('routing: tg-link /start <nonce>', {
          tgUserId: ev.userId,
          payloadLen: payload.length,
        })
        try {
          await handleStartCommand(
            { tgUserId: Number(ev.userId), payload },
            {
              tgLinkService: this.deps.tgLinkService!,
              workspaces: this.deps.wsRepo,
              personas: this.deps.personaRepo,
              sendMessage: async (tgUserId, text) => {
                await channel.sendMessage({ chatId: String(tgUserId), text })
              },
              // No plainStart — payload is guaranteed non-empty by the regex above.
            },
          )
        } catch (e) {
          log().error('tg-link /start handler failed', {
            tgUserId: ev.userId,
            error: e instanceof Error ? e.message : String(e),
          })
          await channel
            .sendMessage({
              chatId: ev.chatId,
              text: 'Не получилось привязать Бетси. Попробуй ещё раз через минуту 💙',
            })
            .catch(() => {})
        }
        return
      }

      // Resolve workspace
      // Desktop: ev.userId is the workspaceId (UUID) set by DesktopAdapter
      // from the verified JWT, so we look up directly. TG/Max: userId is the
      // numeric chat id, upsert by it.
      let workspace
      if (ev.channel === 'desktop') {
        const found = await this.deps.wsRepo.findById(ev.userId)
        if (!found) {
          log().warn('desktop inbound: workspace not found, dropping', {
            workspaceId: ev.userId,
          })
          return
        }
        workspace = found
      } else if (ev.channel === 'telegram') {
        workspace = await this.deps.wsRepo.upsertForTelegram(Number(ev.userId))
      } else {
        workspace = await this.deps.wsRepo.upsertForMax(Number(ev.userId))
      }

      log().info('workspace resolved', {
        workspaceId: workspace.id,
        status: workspace.status,
        displayName: workspace.displayName,
      })

      await this.deps.wsRepo.updateLastActiveChannel(workspace.id, ev.channel)

      // Try link code match
      // Desktop channel has no link-codes UX (it auths via JWT), so the
      // 6-digit verification path is restricted to telegram/max inbound.
      const linkMatch = ev.text.match(LINK_CODE_RE)
      if (
        linkMatch &&
        workspace.status !== 'onboarding' &&
        (ev.channel === 'telegram' || ev.channel === 'max')
      ) {
        const result = await this.deps.linkingSvc.verifyAndLink(linkMatch[1], {
          fromChannel: ev.channel,
          newChannelUserId: Number(ev.userId),
        })
        if (result.success) {
          await channel.sendMessage({
            chatId: ev.chatId,
            text: `✅ Канал ${ev.channel} подключён! Теперь мы с тобой на связи и здесь тоже 💙`,
          })
          return
        } else if (result.reason === 'invalid_or_expired') {
          // silently fall through — maybe user just sent a 6-digit number
        } else {
          await channel.sendMessage({
            chatId: ev.chatId,
            text: `⚠️ Не получилось связать: ${result.reason}`,
          })
          return
        }
      }

      // Commands for active workspace go through commands handler
      // (onboarding flow has its own / handling and shouldn't intercept commands here)
      if (ev.text.startsWith('/') && workspace.status !== 'onboarding') {
        log().info('routing: command (active)', { workspaceId: workspace.id, cmd: ev.text.split(' ')[0] })
        const result = await handleCommand(ev.text, workspace as any, {
          wsRepo: this.deps.wsRepo,
          factsRepo: this.deps.factsRepo,
          convRepo: this.deps.convRepo,
          linkingSvc: this.deps.linkingSvc,
        })
        if (result) {
          await channel.sendMessage({ chatId: ev.chatId, text: result.text })
          return
        }
      }

      // Onboarding only when status is explicitly 'onboarding'.
      // Trust the workspace status — if active, onboarding is done.
      if (workspace.status === 'onboarding') {
        log().info('routing: onboarding', { workspaceId: workspace.id })
        await this.handleOnboarding(ev, workspace, channel)
        return
      }

      // Normal message → runBetsy. Prefer streaming path when:
      //  - the channel adapter supports streamMessage,
      //  - the streaming runner is wired in,
      //  - the persona is NOT in voice_always mode (voice needs full text up front).
      const persona = await this.deps.personaRepo.findByWorkspace(workspace.id)
      const voiceAlways = persona?.behaviorConfig?.voice === 'voice_always'
      const canStream = Boolean(
        channel.streamMessage && this.deps.runBetsyStreamFn && !voiceAlways,
      )

      // Persist user message ONCE here so retries don't duplicate it.
      // Fix5: annotate persisted content when attachments were present so
      // recall / fact-extractor see evidence of the image in history.
      const attachmentCount = ev.attachments?.length ?? 0
      const persistedContent =
        attachmentCount > 0
          ? (ev.text?.length
              ? `${ev.text}\n\n[прислано ${attachmentCount} фото]`
              : `[прислано ${attachmentCount} фото без подписи]`)
          : ev.text
      if (this.deps.convRepo) {
        try {
          await this.deps.convRepo.append(workspace.id, {
            channel: ev.channel,
            role: 'user',
            content: persistedContent,
            chatId: ev.chatId,
            externalMessageId: /^\d+$/.test(ev.messageId) ? Number(ev.messageId) : null,
          })
        } catch (e) {
          log().error('inbound: failed to persist user message', {
            workspaceId: workspace.id,
            error: e instanceof Error ? e.message : String(e),
          })
          throw e
        }
      }

      // P1.5 — broadcast user message to ALL non-primary channels so the
      // conversation stays in sync across desktop / TG / Max. Dispatcher
      // skips the primary channel itself.
      if (this.deps.runBetsyDeps.outboundDispatcher && persistedContent) {
        await this.deps.runBetsyDeps.outboundDispatcher
          .afterPrimarySend({
            workspaceId: workspace.id,
            primaryChannel: ev.channel,
            role: 'user',
            text: persistedContent,
            recipientChatIds: {
              telegram: workspace.ownerTgId != null ? String(workspace.ownerTgId) : null,
              max: workspace.ownerMaxId != null ? String(workspace.ownerMaxId) : null,
            },
          })
          .catch((e) =>
            log().warn('outboundDispatcher: user broadcast failed', {
              workspaceId: workspace.id,
              error: e instanceof Error ? e.message : String(e),
            }),
          )
      }

      // Semantic intent classification — one tiny Gemini Flash call decides:
      //  - force a specific tool (e.g. generate_selfie) with extracted args
      //  - ask a clarifying question and skip the main turn
      //  - normal: pass through unchanged
      // Replaces regex-based intent detection. Understands synonyms, context,
      // and ambiguity ("ну?" / "и?" → clarify instead of guessing).
      // Fix5: skip intent classifier when attachments are present — empty text
      // with a photo would otherwise trigger a "clarify" question and drop the
      // image on the floor.
      const intent =
        attachmentCount > 0
          ? ({ action: 'normal' as const } as any)
          : await classifyIntent(this.deps.runBetsyDeps.gemini, ev.text)
      log().info('inbound: classifier', { workspaceId: workspace.id, intent: intent.action })

      let forceTool: string | undefined
      // FIX6: clarify branch REMOVED. Classifier has no history, so any
      // "clarifying question" is a blind guess that throws away the user's
      // actual message. User said "да" → classifier without history can only
      // respond "что именно?" which is wrong 100% of the time when there was
      // a pending question from Бэтси. Always let the agent (with full
      // history) handle ambiguous inputs.
      if (intent.action === 'clarify') {
        log().warn('inbound: clarify from classifier ignored, falling through to agent', {
          workspaceId: workspace.id,
        })
      }
      if (intent.action === 'force_tool') {
        forceTool = intent.tool
        log().info('inbound: force-tool', { workspaceId: workspace.id, forceTool, args: intent.args })
      }

      const stopTyping = startTypingLoop(channel, ev.chatId, workspace.id)
      let succeeded = false
      try {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            if (canStream) {
              log().info('routing: runBetsyStream attempt', { workspaceId: workspace.id, attempt })
              const { textStream, done, replyToPromise, assistantRowIdPromise, finalTextPromise } =
                await this.deps.runBetsyStreamFn!({
                  workspaceId: workspace.id,
                  userMessage: ev.text,
                  channel: ev.channel,
                  deps: this.deps.runBetsyDeps,
                  skipAppendUser: true,
                  currentChatId: ev.chatId,
                  forceTool,
                  attachments: ev.attachments,
                  replyToText: ev.replyToText,
                })
              // Race the whole streaming turn against the timeout. If timeout
              // hits, both streamMessage and done are abandoned. streamMessage
              // will NOT finalize the partial draft (see telegram.ts), so the
              // user sees nothing — clean for retry.
              // FIX2: if feedback is enabled and this is telegram, generate a
              // refId and stash the outgoing context in the ref store. The
              // telegram adapter reads feedbackRefId off StreamableOutbound,
              // backfills messageId after send, and the callback handler
              // resolves refId→rawText/userMessage when the user clicks 👍/👎.
              let feedbackRefId: string | undefined
              if (feedbackEnabled() && ev.channel === 'telegram') {
                feedbackRefId = FeedbackRefStore.newRefId()
                getFeedbackRefStore().set(feedbackRefId, {
                  workspaceId: workspace.id,
                  channel: 'telegram',
                  chatId: ev.chatId,
                  rawText: '', // backfilled after done() resolves below
                  userMessage: ev.text,
                })
              }
              const turnPromise = (async () => {
                const sendResult = await channel.streamMessage!({
                  chatId: ev.chatId,
                  textStream,
                  replyToPromise,
                  finalTextOverride: finalTextPromise, // FIX1: post-stream critic
                  feedbackRefId, // FIX2
                })
                const d = await done
                // FIX2: backfill final text into ref store so feedback rows
                // record what the user actually saw (post-critic, if any).
                if (feedbackRefId) {
                  getFeedbackRefStore().update(feedbackRefId, {
                    rawText: d.text ?? '',
                  })
                }
                const rowId = await assistantRowIdPromise
                if (sendResult.externalMessageId != null && rowId && this.deps.convRepo) {
                  await this.deps.convRepo
                    .setExternalMessageId(workspace.id, rowId, sendResult.externalMessageId)
                    .catch((e) =>
                      log().warn('bot-router(stream): setExternalMessageId failed', {
                        workspaceId: workspace.id,
                        error: e instanceof Error ? e.message : String(e),
                      }),
                    )
                }
                return d
              })()
              const result = await withTimeout(
                turnPromise,
                ATTEMPT_TIMEOUT_MS,
                'runBetsyStream',
              )
              log().info('runBetsyStream returned', {
                workspaceId: workspace.id,
                attempt,
                textLen: result.text?.length ?? 0,
                toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
                replyTo: result.replyTo,
              })
              // P1.5 — broadcast assistant reply to all non-primary channels.
              // Fail-open: dispatcher errors never block the turn.
              if (this.deps.runBetsyDeps.outboundDispatcher && result.text) {
                await this.deps.runBetsyDeps.outboundDispatcher
                  .afterPrimarySend({
                    workspaceId: workspace.id,
                    primaryChannel: ev.channel,
                    role: 'assistant',
                    text: result.text,
                    recipientChatIds: {
                      telegram: workspace.ownerTgId != null ? String(workspace.ownerTgId) : null,
                      max: workspace.ownerMaxId != null ? String(workspace.ownerMaxId) : null,
                    },
                  })
                  .catch((e) =>
                    log().warn('outboundDispatcher: stream broadcast failed', {
                      workspaceId: workspace.id,
                      error: e instanceof Error ? e.message : String(e),
                    }),
                  )
              }
            } else {
              log().info('routing: runBetsy attempt', { workspaceId: workspace.id, attempt })
              const response = await withTimeout(
                this.deps.runBetsyFn({
                  workspaceId: workspace.id,
                  userMessage: ev.text,
                  channel: ev.channel,
                  deps: this.deps.runBetsyDeps,
                  skipAppendUser: true,
                  currentChatId: ev.chatId,
                  forceTool,
                  attachments: ev.attachments,
                  replyToText: ev.replyToText,
                }),
                ATTEMPT_TIMEOUT_MS,
                'runBetsy',
              )
              log().info('runBetsy returned', {
                workspaceId: workspace.id,
                attempt,
                textLen: response.text?.length ?? 0,
                hasAudio: Boolean(response.audio),
                toolCalls: Array.isArray(response.toolCalls) ? response.toolCalls.length : 0,
                replyTo: response.replyTo,
              })
              const sendResult = await channel.sendMessage({
                chatId: ev.chatId,
                text: response.text,
                audio: response.audio && {
                  base64: response.audio.base64,
                  mimeType: response.audio.mimeType,
                },
                replyToMessageId: response.replyTo != null ? String(response.replyTo) : undefined,
              })
              if (sendResult.externalMessageId != null && response.assistantRowId && this.deps.convRepo) {
                await this.deps.convRepo
                  .setExternalMessageId(
                    workspace.id,
                    response.assistantRowId,
                    sendResult.externalMessageId,
                  )
                  .catch((e) =>
                    log().warn('bot-router: setExternalMessageId failed', {
                      workspaceId: workspace.id,
                      error: e instanceof Error ? e.message : String(e),
                    }),
                  )
              }
              // P1.5 — broadcast assistant reply to all non-primary channels.
              if (this.deps.runBetsyDeps.outboundDispatcher && response.text) {
                await this.deps.runBetsyDeps.outboundDispatcher
                  .afterPrimarySend({
                    workspaceId: workspace.id,
                    primaryChannel: ev.channel,
                    role: 'assistant',
                    text: response.text,
                    recipientChatIds: {
                      telegram: workspace.ownerTgId != null ? String(workspace.ownerTgId) : null,
                      max: workspace.ownerMaxId != null ? String(workspace.ownerMaxId) : null,
                    },
                  })
                  .catch((e) =>
                    log().warn('outboundDispatcher: send broadcast failed', {
                      workspaceId: workspace.id,
                      error: e instanceof Error ? e.message : String(e),
                    }),
                  )
              }
            }
            succeeded = true
            break
          } catch (attemptErr) {
            log().warn('inbound: attempt failed', {
              workspaceId: workspace.id,
              attempt,
              error: attemptErr instanceof Error ? attemptErr.message : String(attemptErr),
            })
            if (attempt < MAX_ATTEMPTS) {
              const delay = RETRY_DELAYS_MS[attempt - 1] ?? 5_000
              await new Promise((r) => setTimeout(r, delay))
            }
          }
        }
      } finally {
        stopTyping()
      }

      if (!succeeded) {
        // Drop any half-built media from failed attempts so they don't leak
        // into the next request.
        clearPendingMedia(workspace.id)
        log().error('inbound: all attempts failed', { workspaceId: workspace.id })
        await channel.sendMessage({
          chatId: ev.chatId,
          text: 'Что-то у меня сегодня туго с мыслями... попробуй ещё раз через минутку, ладно? 💙',
        })
        return
      }
      // Ship any media (selfies, video circles) the tools generated this turn.
      // Sent AFTER the text so the user reads what Betsy "said" first, then
      // sees the photo arrive.
      await deliverPendingMedia(workspace.id, channel, ev.chatId)
      log().info('inbound: response sent', { workspaceId: workspace.id })
    } catch (err) {
      log().error('inbound failed', {
        channel: ev.channel,
        userId: String(ev.userId),
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })
      // Best-effort user notification
      try {
        const ch = this.deps.channels[ev.channel]
        if (ch) {
          await ch.sendMessage({
            chatId: ev.chatId,
            text: 'Ой, у меня сейчас сбой. Я уже разбираюсь, попробуй ещё раз через минуту 💙',
          })
        }
      } catch (notifyErr) {
        log().error('inbound: failed to notify user about error', {
          error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        })
      }
    }
  }

  private async handleOnboarding(
    ev: InboundEvent,
    workspace: { id: string; displayName: string | null; businessContext: string | null; addressForm: string },
    channel: ChannelAdapter,
  ): Promise<void> {
    const profile = workspaceToProfile(workspace)

    if (ev.text.trim() && !ev.text.startsWith('/')) {
      // Store answer for current step
      const currentStep = nextOnboardingStep(profile)
      if (currentStep) {
        const patch = parseOnboardingAnswer(currentStep, ev.text)
        const value = patch[currentStep.key]
        if (currentStep.key === 'name' && typeof value === 'string') {
          await this.deps.wsRepo.updateDisplayName(workspace.id, value)
          profile.name = value
        } else if (currentStep.key === 'business_context' && typeof value === 'string') {
          await this.deps.wsRepo.updateBusinessContext(workspace.id, value)
          profile.business_context = value
        } else if (currentStep.key === 'address_form') {
          await this.deps.wsRepo.updateStatus(workspace.id, 'onboarding')
          profile.address_form = value
        }
      }
    }

    const next = nextOnboardingStep(profile)
    if (next) {
      await channel.sendMessage({ chatId: ev.chatId, text: next.question })
      return
    }

    // Onboarding complete — ensure persona exists, activate workspace
    const existing = await this.deps.personaRepo.findByWorkspace(workspace.id)
    if (!existing) {
      await this.deps.personaRepo.create(workspace.id, {
        presetId: 'betsy',
        name: 'Betsy',
        gender: 'female',
        voiceId: 'Aoede',
      })
    }
    await this.deps.wsRepo.updateStatus(workspace.id, 'active')

    await channel.sendMessage({
      chatId: ev.chatId,
      text:
        `Приятно познакомиться, ${profile.name}! 💙\n\n` +
        `Теперь я буду здесь — можешь писать мне что угодно. Я запомню важное.\n\n` +
        `Подробнее: /help`,
    })
  }
}

function workspaceToProfile(ws: {
  displayName: string | null
  businessContext: string | null
  addressForm: string
}): Record<string, unknown> {
  return {
    name: ws.displayName,
    business_context: ws.businessContext,
    address_form: ws.addressForm,
  }
}
