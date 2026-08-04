// Pure reducer for useChat. Extracted so tests can import it without
// pulling React or `window.api` at module load.

import type { Message } from '../../shared/chat-protocol'

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'auth-failed'

export interface ChatState {
  messages: Message[] // ascending by createdAt
  streaming: Record<string, string> // messageId -> current text (during delta phase)
  hasMore: boolean
  status: ConnectionStatus
  typing: boolean
}

export type ChatAction =
  | { kind: 'history-loaded'; messages: Message[]; hasMore: boolean; prepend?: boolean }
  | { kind: 'message-arrived'; message: Message }
  | { kind: 'message-delta'; messageId: string; text: string }
  | { kind: 'message-final'; messageId: string; text: string }
  | { kind: 'message-from-other-channel'; message: Message }
  | { kind: 'typing'; on: boolean }
  | { kind: 'connection'; status: ConnectionStatus }
  | { kind: 'optimistic-user'; message: Message }

export const initialChatState: ChatState = {
  messages: [],
  streaming: {},
  hasMore: false,
  status: 'connecting',
  typing: false,
}

export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.kind) {
    case 'history-loaded': {
      const incoming = a.messages.slice().sort((x, y) => x.createdAt.localeCompare(y.createdAt))
      return a.prepend
        ? { ...s, messages: [...incoming, ...s.messages], hasMore: a.hasMore }
        : { ...s, messages: incoming, hasMore: a.hasMore }
    }
    case 'message-arrived':
    case 'message-from-other-channel': {
      const exists = s.messages.find((m) => m.id === a.message.id)
      if (exists) return s
      return { ...s, messages: [...s.messages, a.message] }
    }
    case 'message-delta':
      return { ...s, streaming: { ...s.streaming, [a.messageId]: a.text } }
    case 'message-final': {
      const nextStreaming = { ...s.streaming }
      delete nextStreaming[a.messageId]
      const finalMsg: Message = {
        id: a.messageId,
        role: 'assistant',
        text: a.text,
        channel: 'desktop',
        createdAt: new Date().toISOString(),
      }
      const exists = s.messages.find((m) => m.id === a.messageId)
      return {
        ...s,
        streaming: nextStreaming,
        messages: exists
          ? s.messages.map((m) => (m.id === a.messageId ? finalMsg : m))
          : [...s.messages, finalMsg],
      }
    }
    case 'typing':
      return { ...s, typing: a.on }
    case 'connection':
      return { ...s, status: a.status }
    case 'optimistic-user':
      return { ...s, messages: [...s.messages, a.message] }
    default:
      return s
  }
}
