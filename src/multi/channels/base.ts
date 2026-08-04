export type ChannelName = 'telegram' | 'max' | 'desktop'

/**
 * An attachment on an inbound message (photo, document). The bytes are NOT
 * eagerly downloaded — the channel adapter closes a lazy `fetch()` function
 * over its platform API so the agent loop can decide whether to actually
 * download. Keeps the classifier cheap for bursts of messages that end up
 * being discarded.
 *
 * Fix5: restores photo/document recognition that was present in single-mode
 * Betsy but lost in the multi-mode migration.
 */
export interface InboundAttachment {
  kind: 'image' | 'document'
  /** Platform-native file id (Telegram file_id). */
  fileId: string
  /** e.g. image/jpeg, image/png, application/pdf. */
  mimeType?: string
  /** Lazy fetcher — downloads and returns base64 bytes. Enforces 10 MB cap. */
  fetch: () => Promise<{ base64: string; mimeType: string }>
  /** Human-readable one-liner for logs/fact extraction, e.g. "photo 1024x768". */
  summary: string
}

/** Cap for a single attachment download — 10 MB. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

export interface InboundEvent {
  channel: ChannelName
  chatId: string
  userId: string
  userDisplay: string
  /** Caption/text of the message. May be empty when there are only attachments. */
  text: string
  messageId: string
  timestamp: Date
  isVoiceMessage: boolean
  /** Fix5: photo(s) / document(s) attached to the message. */
  attachments?: InboundAttachment[]
  /** Fix5: Telegram media_group_id if this event is part of an album —
   *  the coalescer merges events sharing the same id into one logical inbound. */
  mediaGroupId?: string
  /** Fix5: text (or caption) of the message this one replies to, if any. */
  replyToText?: string
  /** Raw platform-specific event, useful for diagnostics; never persist */
  raw: unknown
}

export interface OutboundMessage {
  chatId: string
  text: string
  audio?: { base64: string; mimeType: string }
  image?: { url: string } | { base64: string; mimeType: string }
  replyToMessageId?: string
  /** Optional feedback ref id — when set AND the channel adapter has feedback
   *  enabled, the channel attaches a [👍][👎] inline keyboard whose
   *  callback_data embeds this refId. Wave 2C. */
  feedbackRefId?: string
}

export interface SendResult {
  /** Platform-native outgoing message id (Telegram message_id). Undefined if the
   *  platform does not return one or the adapter could not capture it. */
  externalMessageId?: number
}

export interface StreamableOutbound {
  chatId: string
  /** Async iterable that yields incrementally growing text. Each yield is the
   *  full accumulated text so far (NOT just the delta). */
  textStream: AsyncIterable<string>
  /** Optional explicit final text; if absent the last yielded value is used. */
  finalText?: string
  /** Resolves (just before final send) with an optional Telegram message id
   *  the final outgoing message should quote as a reply. Used by recall_messages
   *  + set_reply_target flow. Returning undefined = no reply-quote. */
  replyToPromise?: Promise<number | undefined>
  /** See OutboundMessage.feedbackRefId. Wave 2C. */
  feedbackRefId?: string
  /** Fix1 (post-stream critic): if set, the channel does NOT use the last
   *  textStream chunk as the final message. Instead it awaits this promise
   *  (with a short timeout) and uses its resolved value as the final text.
   *  Used to inject post-stream critic rewrites without edits or UX loss.
   *  Fail-open: any error / timeout / empty value falls back to the
   *  last yielded stream value. */
  finalTextOverride?: Promise<string>
}

export interface ChannelAdapter {
  readonly name: ChannelName
  start(): Promise<void>
  stop(): Promise<void>
  sendMessage(msg: OutboundMessage): Promise<SendResult>
  onMessage(handler: (ev: InboundEvent) => Promise<void>): void
  sendTyping?(chatId: string, action?: string): Promise<void>
  /** Stream a message via native channel streaming API if supported. */
  streamMessage?(msg: StreamableOutbound): Promise<SendResult>
}
