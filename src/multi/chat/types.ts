/**
 * Shared protocol types for the desktop chat channel.
 *
 * The frontend (betsy-app/src/shared/chat-protocol.ts) MUST keep a byte-identical
 * copy of these types — they form the WS protocol contract between the
 * Electron main process and the multi server.
 *
 * P1.5 keeps duplication on purpose; a follow-up may extract to a workspace
 * package.
 */

export type MessageRole = 'user' | 'assistant'
export type MessageChannel = 'telegram' | 'max' | 'desktop'

export interface Attachment {
  kind: 'image' | 'voice' | 'video'
  url: string // CDN/temporary URL
  mimeType: string
}

export interface Message {
  id: string
  role: MessageRole
  text: string
  channel: MessageChannel
  createdAt: string // ISO 8601
  attachments?: Attachment[]
}

// Client -> Server (over WSS)
export type ClientMessage =
  | { type: 'user-message'; text: string; clientMessageId: string }
  | { type: 'ping' }

// Server -> Client (over WSS)
export type ServerMessage =
  | { type: 'history-batch'; messages: Message[]; hasMore: boolean }
  | { type: 'message'; message: Message }
  | { type: 'message-delta'; messageId: string; text: string }
  | { type: 'message-final'; messageId: string; text: string }
  | { type: 'message-from-other-channel'; message: Message }
  | { type: 'typing'; on: boolean }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
