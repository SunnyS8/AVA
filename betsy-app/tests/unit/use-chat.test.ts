import { describe, expect, it } from 'vitest'
import {
  chatReducer,
  initialChatState,
  type ChatState,
} from '../../src/renderer/chat/chat-reducer'
import type { Message } from '../../src/shared/chat-protocol'

function mkMsg(overrides: Partial<Message> & { id: string; createdAt: string }): Message {
  return {
    role: 'user',
    text: '',
    channel: 'desktop',
    ...overrides,
  } as Message
}

describe('chatReducer', () => {
  it('history-loaded sets messages ascending by createdAt', () => {
    const s = chatReducer(initialChatState, {
      kind: 'history-loaded',
      messages: [
        mkMsg({ id: 'b', text: 'B', createdAt: '2026-05-24T10:01:00Z' }),
        mkMsg({ id: 'a', text: 'A', createdAt: '2026-05-24T10:00:00Z' }),
      ],
      hasMore: false,
    })
    expect(s.messages.map((m) => m.id)).toEqual(['a', 'b'])
    expect(s.hasMore).toBe(false)
  })

  it('history-loaded respects hasMore flag', () => {
    const s = chatReducer(initialChatState, {
      kind: 'history-loaded',
      messages: [],
      hasMore: true,
    })
    expect(s.hasMore).toBe(true)
  })

  it('message-delta tracks streaming text per id', () => {
    let s: ChatState = chatReducer(initialChatState, {
      kind: 'message-delta',
      messageId: 'm1',
      text: 'He',
    })
    s = chatReducer(s, { kind: 'message-delta', messageId: 'm1', text: 'Hello' })
    expect(s.streaming['m1']).toBe('Hello')
  })

  it('message-final clears streaming and inserts final message', () => {
    let s: ChatState = chatReducer(initialChatState, {
      kind: 'message-delta',
      messageId: 'm1',
      text: 'partial',
    })
    s = chatReducer(s, { kind: 'message-final', messageId: 'm1', text: 'final text' })
    expect(s.streaming['m1']).toBeUndefined()
    expect(s.messages.find((m) => m.id === 'm1')?.text).toBe('final text')
  })

  it('history-loaded prepend keeps order: older first', () => {
    let s: ChatState = chatReducer(initialChatState, {
      kind: 'history-loaded',
      messages: [mkMsg({ id: 'b', text: 'B', createdAt: '2026-05-24T10:01:00Z' })],
      hasMore: true,
    })
    s = chatReducer(s, {
      kind: 'history-loaded',
      messages: [mkMsg({ id: 'a', text: 'A', createdAt: '2026-05-24T10:00:00Z' })],
      hasMore: false,
      prepend: true,
    })
    expect(s.messages.map((m) => m.id)).toEqual(['a', 'b'])
    expect(s.hasMore).toBe(false)
  })

  it('deduplicates message-arrived by id', () => {
    const msg = mkMsg({
      id: 'x',
      role: 'assistant',
      text: 'hi',
      createdAt: '2026-05-24T10:00:00Z',
    })
    let s: ChatState = chatReducer(initialChatState, { kind: 'message-arrived', message: msg })
    s = chatReducer(s, { kind: 'message-arrived', message: msg })
    expect(s.messages).toHaveLength(1)
  })

  it('deduplicates message-from-other-channel by id', () => {
    const msg = mkMsg({
      id: 'y',
      role: 'assistant',
      text: 'tg-mirror',
      channel: 'telegram',
      createdAt: 'z',
    })
    let s: ChatState = chatReducer(initialChatState, {
      kind: 'message-from-other-channel',
      message: msg,
    })
    s = chatReducer(s, { kind: 'message-from-other-channel', message: msg })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0].channel).toBe('telegram')
  })

  it('connection action updates status', () => {
    const s = chatReducer(initialChatState, { kind: 'connection', status: 'open' })
    expect(s.status).toBe('open')
  })

  it('typing action updates typing flag', () => {
    let s: ChatState = chatReducer(initialChatState, { kind: 'typing', on: true })
    expect(s.typing).toBe(true)
    s = chatReducer(s, { kind: 'typing', on: false })
    expect(s.typing).toBe(false)
  })

  it('optimistic-user appends a user message', () => {
    const opt = mkMsg({ id: 'tmp-1', role: 'user', text: 'я', createdAt: 'z' })
    const s = chatReducer(initialChatState, { kind: 'optimistic-user', message: opt })
    expect(s.messages).toEqual([opt])
  })

  it('message-final updates an existing message in place (e.g. optimistic streaming)', () => {
    // Seed an assistant message with the same id as what message-final will produce.
    const seed = mkMsg({
      id: 'mF',
      role: 'assistant',
      text: 'partial',
      createdAt: '2026-05-24T10:00:00Z',
    })
    let s: ChatState = chatReducer(initialChatState, {
      kind: 'message-arrived',
      message: seed,
    })
    s = chatReducer(s, { kind: 'message-final', messageId: 'mF', text: 'final!' })
    const found = s.messages.filter((m) => m.id === 'mF')
    expect(found).toHaveLength(1)
    expect(found[0].text).toBe('final!')
  })
})
