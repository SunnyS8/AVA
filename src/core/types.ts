export interface IncomingMessage {
  channelName: string
  /** Who sent the message — keys history, profile and access. In a group
   *  chat this must be the sender, not the chat: two people sharing a
   *  chatId would otherwise share one conversation and one access level. */
  userId: string
  /** Where a reply must be delivered. Equal to `userId` in a 1:1 chat;
   *  diverges in a group, where the chat is shared but senders are not.
   *  Falls back to `userId` when a channel has no separate concept of a
   *  chat (Bitrix dialogs, the browser panel). */
  chatId?: string
  text: string
  timestamp: number
  metadata?: Record<string, unknown>
  /** Base64-encoded images attached to the message or quoted reply. */
  images?: string[]
}

export interface OutgoingMessage {
  text: string
  mode?: 'text' | 'voice' | 'video' | 'selfie'
  mediaUrl?: string
  /** Path to a local file to send to the user (video, audio, document). */
  mediaPath?: string
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Progress events emitted by the Engine during agentic loop. */
export type EngineProgressEvent =
  | { type: 'thinking' }
  | { type: 'tool_start'; tool: string; turn: number }
  | { type: 'tool_end'; tool: string; turn: number; success: boolean }
  | { type: 'turn_complete'; turn: number; totalTurns: number }
  | { type: 'text_chunk'; chunk: string }

export type ProgressCallback = (event: EngineProgressEvent) => void
