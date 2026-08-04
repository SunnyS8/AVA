import { describe, it, expect, vi } from 'vitest'
import { TelegramAdapter } from '../../../src/multi/channels/telegram.js'

async function* makeTextStream(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) {
    yield c
  }
}

function buildAdapter() {
  const adapter = new TelegramAdapter('fake-token')
  const sendMessageDraft = vi.fn().mockResolvedValue(true)
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 7 })
  ;(adapter as any).bot = {
    api: {
      raw: { sendMessageDraft },
      sendMessage,
    },
  }
  return { adapter, sendMessageDraft, sendMessage }
}

describe('TelegramAdapter.streamMessage finalTextOverride (Fix1)', () => {
  it('without finalTextOverride — final send uses lastText', async () => {
    const { adapter, sendMessage } = buildAdapter()
    await adapter.streamMessage({
      chatId: '1',
      textStream: makeTextStream(['Hi', 'Hi there!']),
    })
    expect(sendMessage).toHaveBeenCalledWith(1, 'Hi there!', { parse_mode: 'HTML' })
  })

  it('finalTextOverride resolves with a string — final send uses override', async () => {
    const { adapter, sendMessage } = buildAdapter()
    await adapter.streamMessage({
      chatId: '1',
      textStream: makeTextStream(['Hi', 'Hi there!']),
      finalTextOverride: Promise.resolve('CRITIC REWRITTEN reply'),
    })
    expect(sendMessage).toHaveBeenCalledWith(1, 'CRITIC REWRITTEN reply', {
      parse_mode: 'HTML',
    })
  })

  it('finalTextOverride rejects — final send falls back to lastText', async () => {
    const { adapter, sendMessage } = buildAdapter()
    await adapter.streamMessage({
      chatId: '1',
      textStream: makeTextStream(['Hi', 'Hi there!']),
      finalTextOverride: Promise.reject(new Error('critic boom')),
    })
    expect(sendMessage).toHaveBeenCalledWith(1, 'Hi there!', { parse_mode: 'HTML' })
  })

  it('finalTextOverride resolves with empty string — falls back to lastText', async () => {
    const { adapter, sendMessage } = buildAdapter()
    await adapter.streamMessage({
      chatId: '1',
      textStream: makeTextStream(['Hi', 'Hi there!']),
      finalTextOverride: Promise.resolve('   '),
    })
    expect(sendMessage).toHaveBeenCalledWith(1, 'Hi there!', { parse_mode: 'HTML' })
  })

  it('finalTextOverride times out — falls back to lastText', async () => {
    // Use BC_FINAL_TEXT_OVERRIDE_TIMEOUT_MS via re-import? Constant is captured
    // at module load. Instead, use a never-resolving promise + fake timers.
    vi.useFakeTimers()
    try {
      const { adapter, sendMessage } = buildAdapter()
      const neverResolves = new Promise<string>(() => {})
      const p = adapter.streamMessage({
        chatId: '1',
        textStream: makeTextStream(['Hi', 'Hi there!']),
        finalTextOverride: neverResolves,
      })
      // Fast-forward past the 12s default timeout.
      await vi.advanceTimersByTimeAsync(13_000)
      await p
      expect(sendMessage).toHaveBeenCalledWith(1, 'Hi there!', { parse_mode: 'HTML' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('finalTextOverride longer than 4096 chars — truncated', async () => {
    const { adapter, sendMessage } = buildAdapter()
    const huge = 'X'.repeat(5000)
    await adapter.streamMessage({
      chatId: '1',
      textStream: makeTextStream(['Hi', 'Hi there!']),
      finalTextOverride: Promise.resolve(huge),
    })
    const call = sendMessage.mock.calls[0]
    expect(call[1].length).toBe(4096)
  })
})
