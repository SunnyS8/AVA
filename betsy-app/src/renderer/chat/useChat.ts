import { useEffect, useReducer, useRef } from 'react'
import { api } from '../ipc'
import type { Message, ServerMessage } from '../../shared/chat-protocol'
import {
  chatReducer,
  initialChatState,
  type ChatState,
  type ConnectionStatus,
} from './chat-reducer'

export type { ChatState, ConnectionStatus }

export function useChat(): {
  state: ChatState
  send: (text: string) => Promise<void>
  loadOlder: () => Promise<void>
} {
  const [state, dispatch] = useReducer(chatReducer, initialChatState)
  // Cursor for "load older" — id of the oldest message we already hold.
  const cursorRef = useRef<string | null>(null)

  useEffect(() => {
    const offEvent = api.on('chat:event', (rawMsg: unknown) => {
      const msg = rawMsg as ServerMessage
      switch (msg.type) {
        case 'history-batch':
          dispatch({
            kind: 'history-loaded',
            messages: msg.messages,
            hasMore: msg.hasMore,
          })
          cursorRef.current = msg.messages.at(0)?.id ?? cursorRef.current
          break
        case 'message':
          dispatch({ kind: 'message-arrived', message: msg.message })
          break
        case 'message-delta':
          dispatch({ kind: 'message-delta', messageId: msg.messageId, text: msg.text })
          break
        case 'message-final':
          dispatch({ kind: 'message-final', messageId: msg.messageId, text: msg.text })
          break
        case 'message-from-other-channel':
          dispatch({ kind: 'message-from-other-channel', message: msg.message })
          break
        case 'typing':
          dispatch({ kind: 'typing', on: msg.on })
          break
        case 'pong':
          break
        case 'error':
          // eslint-disable-next-line no-console
          console.warn('chat error', msg)
          break
      }
    })
    const offConn = api.on('chat:connection', (data: unknown) => {
      const payload = data as { status: ConnectionStatus }
      dispatch({ kind: 'connection', status: payload.status })
    })

    void (async () => {
      // Tell main process to open the WS now that we're mounted.
      try {
        await api.invoke('chat:start')
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('chat:start failed', e)
      }
      // Initial history fetch (REST). The first 50 newest messages.
      try {
        const r = await api.invoke('chat:history', { limit: 50 })
        dispatch({
          kind: 'history-loaded',
          messages: r.messages,
          hasMore: r.hasMore,
        })
        // Backend returns newest-first; we want the oldest id as our cursor
        // for "load older" — that's the first element of the ascending sort.
        const sorted = r.messages
          .slice()
          .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
        cursorRef.current = sorted.at(0)?.id ?? null
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('initial history failed', e)
      }
    })()

    return () => {
      offEvent()
      offConn()
    }
  }, [])

  async function send(text: string): Promise<void> {
    const optimistic: Message = {
      id: `tmp-${Date.now()}`,
      role: 'user',
      text,
      channel: 'desktop',
      createdAt: new Date().toISOString(),
    }
    dispatch({ kind: 'optimistic-user', message: optimistic })
    await api.invoke('chat:send', text)
  }

  async function loadOlder(): Promise<void> {
    if (!state.hasMore || !cursorRef.current) return
    const r = await api.invoke('chat:history', {
      before: cursorRef.current,
      limit: 50,
    })
    dispatch({
      kind: 'history-loaded',
      messages: r.messages,
      hasMore: r.hasMore,
      prepend: true,
    })
    const sorted = r.messages.slice().sort((x, y) => x.createdAt.localeCompare(y.createdAt))
    cursorRef.current = sorted.at(0)?.id ?? cursorRef.current
  }

  return { state, send, loadOlder }
}
