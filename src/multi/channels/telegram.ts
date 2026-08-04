import { Bot, type Context, InputFile, InlineKeyboard } from 'grammy'
import type {
  InboundEvent,
  InboundAttachment,
  OutboundMessage,
  ChannelAdapter,
  StreamableOutbound,
} from './base.js'
import { ATTACHMENT_MAX_BYTES } from './base.js'
import { markdownToTelegramHTML } from './markdown-to-html.js'
import { getFeedbackRefStore } from '../feedback/ref-store.js'
import type { FeedbackService } from '../feedback/service.js'
import { log } from '../observability/logger.js'

/** Fix1: max time we will wait for a finalTextOverride promise. Exported so
 *  tests can override via process.env or by importing the constant. */
export const FINAL_TEXT_OVERRIDE_TIMEOUT_MS = Number(
  process.env.BC_FINAL_TEXT_OVERRIDE_TIMEOUT_MS ?? 12_000,
)

/** Wave 2C: Build an inline [👍][👎] keyboard whose buttons encode `refId`
 *  in their callback_data. The refId must be short (we use 12 hex chars,
 *  18 bytes total with the "fb:up:" prefix) because Telegram limits
 *  callback_data to 64 bytes. */
export function buildFeedbackKeyboard(refId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('👍', `fb:up:${refId}`)
    .text('👎', `fb:down:${refId}`)
}

/** Feature flag — only attach feedback keyboards when explicitly enabled. */
export function feedbackEnabled(): boolean {
  return process.env.BC_FEEDBACK_ENABLED === '1'
}

/** Send text with parse_mode=HTML; on Telegram 400 fall back to plain text.
 *  Returns the outgoing message_id (undefined if capture failed). */
async function sendHtmlOrPlainReturningId(
  bot: Bot,
  chatId: number,
  text: string,
  extraOpts: Record<string, unknown> = {},
): Promise<number | undefined> {
  const html = markdownToTelegramHTML(text)
  try {
    const out = await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', ...extraOpts })
    return out?.message_id
  } catch (e: any) {
    if (e?.error_code === 400) {
      try {
        const out = await bot.api.sendMessage(chatId, text, extraOpts)
        return out?.message_id
      } catch {
        return undefined
      }
    } else {
      throw e
    }
  }
}


/**
 * Fix5: build a lazy attachment fetcher closed over grammy's ctx.api. The
 * fetcher downloads on demand, enforces ATTACHMENT_MAX_BYTES, and returns
 * base64. Errors propagate so the runner can catch per-attachment.
 */
function makeTelegramFetcher(
  ctx: Context,
  botToken: string,
  fileId: string,
  mimeType: string,
): () => Promise<{ base64: string; mimeType: string }> {
  return async () => {
    // grammy's ctx.api.getFile(fileId) returns a File with a file_path string
    // ("photos/file_123.jpg"). The bot token is not publicly exposed by
    // grammy's Api class, so we capture it in the adapter constructor and
    // close over it here. Manual URL composition per Bot API docs:
    //   https://api.telegram.org/file/bot<token>/<file_path>
    log().info('telegram attachment: fetch start', { fileId })
    let file: any
    try {
      file = await (ctx.api as any).getFile(fileId)
    } catch (e) {
      log().warn('telegram attachment: getFile failed', {
        fileId,
        error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
    if (!file?.file_path) {
      throw new Error('telegram attachment: no file_path in File object')
    }
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`telegram attachment: HTTP ${res.status}`)
    }
    const ab = await res.arrayBuffer()
    if (ab.byteLength > ATTACHMENT_MAX_BYTES) {
      throw new Error(
        `telegram attachment: too large (${ab.byteLength} > ${ATTACHMENT_MAX_BYTES})`,
      )
    }
    const base64 = Buffer.from(ab).toString('base64')
    log().info('telegram attachment: fetch ok', {
      fileId,
      bytes: ab.byteLength,
      mimeType,
    })
    return { base64, mimeType }
  }
}

/** Fix5: extract photo / document attachments from a Telegram message.
 *  - `msg.photo` is an array of sizes; we take the largest (last).
 *  - `msg.document` is whitelisted to image/* and application/pdf only,
 *    anything else (zip, exe, …) is silently dropped.
 *  Bot token is captured in the adapter constructor and threaded through
 *  so the lazy fetcher can compose the download URL. */
function extractAttachments(ctx: Context, botToken: string): InboundAttachment[] {
  const msg: any = ctx.message
  if (!msg) return []
  const out: InboundAttachment[] = []

  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]
    if (largest?.file_id) {
      const mimeType = 'image/jpeg'
      out.push({
        kind: 'image',
        fileId: largest.file_id,
        mimeType,
        fetch: makeTelegramFetcher(ctx, botToken, largest.file_id, mimeType),
        summary: `photo ${largest.width ?? '?'}x${largest.height ?? '?'}`,
      })
    }
  }

  if (msg.document && typeof msg.document === 'object') {
    const doc = msg.document
    const mime: string | undefined = doc.mime_type
    if (typeof mime === 'string' && (mime.startsWith('image/') || mime === 'application/pdf')) {
      out.push({
        kind: mime.startsWith('image/') ? 'image' : 'document',
        fileId: doc.file_id,
        mimeType: mime,
        fetch: makeTelegramFetcher(ctx, botToken, doc.file_id, mime),
        summary: `${doc.file_name ?? 'document'} (${mime})`,
      })
    }
  }

  return out
}

export function buildInboundFromTelegramCtx(
  ctx: Context,
  botToken: string,
): InboundEvent {
  const msg: any = ctx.message!
  const from = ctx.from!
  const chat = ctx.chat!
  const display =
    from.first_name?.trim() ||
    from.username ||
    String(from.id)
  const isVoice = msg.voice !== undefined
  // Fix5: prefer explicit text, then caption (photo/doc with caption).
  const text: string = msg.text ?? msg.caption ?? ''

  const attachments = extractAttachments(ctx, botToken)

  // Fix5: reply-to text/caption passthrough.
  let replyToText: string | undefined
  const rtm = msg.reply_to_message
  if (rtm) {
    const rtt = rtm.text ?? rtm.caption
    if (typeof rtt === 'string' && rtt.length > 0) replyToText = rtt
  }

  const mediaGroupId: string | undefined =
    typeof msg.media_group_id === 'string' ? msg.media_group_id : undefined

  return {
    channel: 'telegram',
    chatId: String(chat.id),
    userId: String(from.id),
    userDisplay: display,
    text,
    messageId: String(msg.message_id),
    timestamp: new Date((msg.date ?? 0) * 1000),
    isVoiceMessage: isVoice,
    attachments: attachments.length > 0 ? attachments : undefined,
    mediaGroupId,
    replyToText,
    raw: ctx,
  }
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram' as const
  private bot: Bot
  private handler?: (ev: InboundEvent) => Promise<void>
  /** Wave 2C: optional service used by the fb:up/down callback handler. */
  private feedbackService?: FeedbackService
  /** Fix5: captured for attachment download URL composition — grammy does
   *  not publicly expose the token on ctx.api, so we keep our own reference. */
  private readonly botToken: string

  constructor(token: string) {
    this.bot = new Bot(token)
    this.botToken = token
  }

  /** Wave 2C: inject the feedback service (optional). Without it the callback
   *  handler still answers the query but cannot persist. */
  setFeedbackService(svc: FeedbackService): void {
    this.feedbackService = svc
  }

  async start(): Promise<void> {
    this.bot.on('message', async (ctx) => {
      if (!ctx.message || !ctx.from || !ctx.chat) return
      if (!this.handler) return
      const ev = buildInboundFromTelegramCtx(ctx, this.botToken)
      try {
        await this.handler(ev)
      } catch (e) {
        console.error('[telegram] handler failed:', e)
      }
    })

    // Wave 2C: feedback callback handler. Active regardless of feedbackEnabled,
    // because old messages from a previous enabled-run might still have live
    // keyboards. Parses refId → looks up in refStore → submits feedback.
    // refId is generated as exactly 12 hex chars by FeedbackRefStore.newRefId()
    // (security review fix: previously {6,32} accepted shorter IDs which lowers
    // brute-force resistance from 2^48 to 2^24).
    this.bot.callbackQuery(/^fb:(up|down):([a-f0-9]{12})$/, async (ctx) => {
      await handleFeedbackCallback(ctx, this.feedbackService)
    })

    // Set the native Telegram bot menu commands (the list that shows up
    // when the user taps "/" or the menu icon). These are just shortcuts
    // that inject a canonical Russian phrase into the inbound handler — the
    // intent classifier then routes them to the right tool.
    // Failure is non-fatal: some test environments don't allow setMyCommands.
    void this.bot.api
      .setMyCommands([
        { command: 'start', description: 'Начать диалог с Бэтси' },
        { command: 'help', description: 'Что я умею' },
        { command: 'tweaks', description: '🧠 Предложения по тюнингу персоны' },
        { command: 'candidates', description: '✨ Кандидаты в навыки (от Learner)' },
        { command: 'skills', description: '📋 Мои навыки' },
        { command: 'reminders', description: '⏰ Активные напоминания' },
        { command: 'selfie', description: '📸 Прислать селфи' },
        { command: 'integrations', description: '🔌 Подключённые сервисы' },
      ])
      .then(() => log().info('telegram: menu commands set'))
      .catch((e) =>
        log().warn('telegram: setMyCommands failed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      )

    // Fire-and-forget bot start; long polling runs in background
    void this.bot.start()
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }

  async sendMessage(msg: OutboundMessage): Promise<import('./base.js').SendResult> {
    const chatId = Number(msg.chatId)
    const replyParams =
      msg.replyToMessageId != null
        ? {
            reply_parameters: {
              message_id: Number(msg.replyToMessageId),
              allow_sending_without_reply: true,
            },
          }
        : {}

    // Wave 2C: attach feedback keyboard when enabled + refId provided.
    const fbMarkup =
      msg.feedbackRefId && feedbackEnabled()
        ? { reply_markup: buildFeedbackKeyboard(msg.feedbackRefId) }
        : {}

    // If image present — send as photo with caption
    if (msg.image) {
      const captionHtml = msg.text ? markdownToTelegramHTML(msg.text) : undefined
      const opts: any = {
        ...replyParams,
        ...fbMarkup,
        ...(captionHtml ? { caption: captionHtml, parse_mode: 'HTML' as const } : {}),
      }
      try {
        let out
        if ('url' in msg.image) {
          out = await this.bot.api.sendPhoto(chatId, msg.image.url, opts)
        } else {
          const buf = Buffer.from(msg.image.base64, 'base64')
          out = await this.bot.api.sendPhoto(chatId, new InputFile(buf, 'image.png'), opts)
        }
        if (msg.feedbackRefId && out?.message_id != null) {
          getFeedbackRefStore().update(msg.feedbackRefId, {
            messageId: String(out.message_id),
          })
        }
        return { externalMessageId: out?.message_id }
      } catch (e: any) {
        if (e?.error_code === 400 && msg.text) {
          // Retry without parse_mode
          const retryOpts: any = { ...replyParams, caption: msg.text }
          let out
          if ('url' in msg.image) {
            out = await this.bot.api.sendPhoto(chatId, msg.image.url, retryOpts)
          } else {
            const buf = Buffer.from(msg.image.base64, 'base64')
            out = await this.bot.api.sendPhoto(chatId, new InputFile(buf, 'image.png'), retryOpts)
          }
          if (msg.feedbackRefId && out?.message_id != null) {
            getFeedbackRefStore().update(msg.feedbackRefId, {
              messageId: String(out.message_id),
            })
          }
          return { externalMessageId: out?.message_id }
        }
        throw e
      }
    }

    // Text always
    let textOutId: number | undefined
    if (msg.text && msg.text.length > 0) {
      textOutId = await sendHtmlOrPlainReturningId(this.bot, chatId, msg.text, {
        ...replyParams,
        ...fbMarkup,
      })
      if (msg.feedbackRefId && textOutId != null) {
        getFeedbackRefStore().update(msg.feedbackRefId, {
          messageId: String(textOutId),
        })
      }
    }

    // Audio as voice message (no reply quote attached — voice is a secondary artifact)
    if (msg.audio) {
      const buf = Buffer.from(msg.audio.base64, 'base64')
      await this.bot.api.sendVoice(chatId, new InputFile(buf, 'voice.ogg'))
    }

    return { externalMessageId: textOutId }
  }

  onMessage(handler: (ev: InboundEvent) => Promise<void>): void {
    this.handler = handler
  }

  async sendTyping(chatId: string, action?: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(Number(chatId), (action ?? 'typing') as any)
    } catch (e) {
      // not fatal — just no indicator
    }
  }

  /**
   * Stream a message live via Bot API 9.5 sendMessageDraft. Each chunk replaces
   * the previously-shown draft text. When the stream ends, the draft is
   * finalized as a real message via sendMessage.
   *
   * Falls back gracefully to a single sendMessage if sendMessageDraft is not
   * supported on the current Bot API version (older deployments) or fails.
   */
  async streamMessage(msg: StreamableOutbound): Promise<import('./base.js').SendResult> {
    const chatIdNum = Number(msg.chatId)
    // draft_id must be a non-zero Integer per Bot API spec
    const draftId =
      ((Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff)) || 1
    let lastText = ''
    let draftSupported = true
    let throttleUntil = 0
    let streamFailed = false

    try {
      for await (const accumulated of msg.textStream) {
        if (!accumulated || accumulated === lastText) continue
        lastText = accumulated

        if (!draftSupported) continue

        // Light client-side throttle: at most ~5 draft updates/sec.
        // Telegram says no rate limit on drafts, but we still avoid hammering.
        const now = Date.now()
        if (now < throttleUntil) continue
        throttleUntil = now + 200

        // Telegram limits text to 4096 chars; truncate for streaming preview.
        const chunkText = accumulated.length > 4096 ? accumulated.slice(0, 4096) : accumulated
        const chunkHtml = markdownToTelegramHTML(chunkText)

        try {
          await (this.bot.api.raw as any).sendMessageDraft({
            chat_id: chatIdNum,
            draft_id: draftId,
            text: chunkHtml,
            parse_mode: 'HTML',
          })
        } catch (e: any) {
          const desc: string = e?.description ?? e?.message ?? ''
          // Method not present (old Bot API): code 404 or "method not found"
          if (
            e?.error_code === 404 ||
            /method not found|not implemented|unknown method/i.test(desc)
          ) {
            draftSupported = false
          } else {
            // Any other error — stop streaming, will send final via sendMessage below
            draftSupported = false
          }
        }
      }
    } catch (e) {
      streamFailed = true
      throw e
    }

    if (streamFailed || !lastText || lastText.length === 0) {
      return {}
    }

    // Stream ended naturally. Check if a recall tool set a reply target; if so,
    // send the final message as a reply-quote (drafts expire on their own).
    let replyTo: number | undefined
    if (msg.replyToPromise) {
      try {
        // Short guard timeout — the promise should resolve immediately since
        // the agent loop has already finished by the time we reach here.
        replyTo = await Promise.race([
          msg.replyToPromise,
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000)),
        ])
      } catch {
        replyTo = undefined
      }
    }

    // Fix1: post-stream critic. If caller provided a finalTextOverride promise,
    // wait (bounded) for its resolved value and use it instead of the last
    // streamed chunk. Fail-open on any error / timeout / empty string.
    let finalText = lastText.length > 4096 ? lastText.slice(0, 4096) : lastText
    if (msg.finalTextOverride) {
      try {
        const overridden = await Promise.race([
          msg.finalTextOverride,
          new Promise<string>((_, rej) =>
            setTimeout(
              () => rej(new Error('finalTextOverride timeout')),
              FINAL_TEXT_OVERRIDE_TIMEOUT_MS,
            ),
          ),
        ])
        if (typeof overridden === 'string' && overridden.trim().length > 0) {
          finalText = overridden.length > 4096 ? overridden.slice(0, 4096) : overridden
          log().info('telegram: applied finalTextOverride', {
            origLen: lastText.length,
            finalLen: finalText.length,
          })
        }
      } catch (e) {
        log().warn('telegram: finalTextOverride failed, using stream tail', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    const replyParams =
      replyTo != null
        ? {
            reply_parameters: {
              message_id: replyTo,
              allow_sending_without_reply: true,
            },
          }
        : {}
    // Wave 2C: attach feedback keyboard on the finalized streamed message.
    const fbMarkup =
      msg.feedbackRefId && feedbackEnabled()
        ? { reply_markup: buildFeedbackKeyboard(msg.feedbackRefId) }
        : {}
    const outId = await sendHtmlOrPlainReturningId(this.bot, chatIdNum, finalText, {
      ...replyParams,
      ...fbMarkup,
    })
    if (msg.feedbackRefId && outId != null) {
      getFeedbackRefStore().update(msg.feedbackRefId, {
        messageId: String(outId),
      })
    }
    return { externalMessageId: outId }
  }
}

/** Wave 2C: handle a click on a [👍]/[👎] inline button.
 *
 *  Exported as a plain function (not a method) so tests can call it directly
 *  with a mocked Context + mocked FeedbackService without spinning up a Bot. */
export async function handleFeedbackCallback(
  ctx: Context,
  feedbackService: FeedbackService | undefined,
): Promise<void> {
  const data = (ctx.callbackQuery as any)?.data as string | undefined
  const match = data ? /^fb:(up|down):([a-f0-9]{12})$/.exec(data) : null
  if (!match) {
    try {
      await ctx.answerCallbackQuery({ text: 'Неизвестная команда' })
    } catch {}
    return
  }
  const rating: 1 | -1 = match[1] === 'up' ? 1 : -1
  const refId = match[2]
  const refData = getFeedbackRefStore().get(refId)

  if (!refData) {
    try {
      await ctx.answerCallbackQuery({ text: 'Эта оценка устарела' })
    } catch {}
    return
  }

  // Prefer the refStore-backfilled messageId (matches the actual outgoing
  // message). Fall back to the message that the keyboard is attached to.
  const messageId =
    refData.messageId ??
    (ctx.callbackQuery?.message?.message_id != null
      ? String(ctx.callbackQuery.message.message_id)
      : undefined)

  if (!messageId) {
    try {
      await ctx.answerCallbackQuery({ text: 'Не удалось сохранить оценку' })
    } catch {}
    return
  }

  if (feedbackService) {
    try {
      await feedbackService.submit({
        workspaceId: refData.workspaceId,
        conversationId: refData.conversationId,
        channel: refData.channel,
        chatId: refData.chatId,
        messageId,
        rating,
        rawText: refData.rawText,
        userMessage: refData.userMessage,
      })
    } catch (e) {
      console.error('[telegram] feedback submit failed:', e)
    }
  }

  // One-shot — drop the ref so stale entries don't accumulate.
  getFeedbackRefStore().delete(refId)

  try {
    await ctx.answerCallbackQuery({
      text: rating === 1 ? 'Спасибо за 👍' : 'Спасибо, учту 👎',
    })
  } catch {}

  // Best-effort: strip the keyboard so the buttons can't be reclicked.
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined })
  } catch {}
}
