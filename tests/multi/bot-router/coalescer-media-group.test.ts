import { describe, it, expect, vi } from 'vitest'
import { mergeInboundBatch } from '../../../src/multi/bot-router/router.js'
import { InboundCoalescer } from '../../../src/multi/bot-router/inbound-coalescer.js'
import type { InboundEvent, InboundAttachment } from '../../../src/multi/channels/base.js'

function att(id: string): InboundAttachment {
  return {
    kind: 'image',
    fileId: id,
    mimeType: 'image/jpeg',
    fetch: async () => ({ base64: 'x', mimeType: 'image/jpeg' }),
    summary: `photo ${id}`,
  }
}

function ev(opts: Partial<InboundEvent>): InboundEvent {
  return {
    channel: 'telegram',
    chatId: '1',
    userId: '1',
    userDisplay: 'K',
    text: '',
    messageId: '1',
    timestamp: new Date(0),
    isVoiceMessage: false,
    raw: {},
    ...opts,
  }
}

describe('mergeInboundBatch — Fix5 media group', () => {
  it('two events with same mediaGroupId → one with 2 attachments', () => {
    const merged = mergeInboundBatch([
      ev({
        mediaGroupId: 'G1',
        caption: undefined,
        text: 'album caption',
        attachments: [att('A')],
      } as any),
      ev({ mediaGroupId: 'G1', attachments: [att('B')] }),
    ])
    expect(merged.attachments).toHaveLength(2)
    expect(merged.mediaGroupId).toBe('G1')
    expect(merged.text).toBe('album caption')
  })

  it('four events in same group → 4 attachments', () => {
    const merged = mergeInboundBatch([
      ev({ mediaGroupId: 'G2', attachments: [att('1')] }),
      ev({ mediaGroupId: 'G2', attachments: [att('2')] }),
      ev({ mediaGroupId: 'G2', attachments: [att('3')] }),
      ev({ mediaGroupId: 'G2', attachments: [att('4')] }),
    ])
    expect(merged.attachments).toHaveLength(4)
  })

  it('first event carries caption → merged.text = caption', () => {
    const merged = mergeInboundBatch([
      ev({ mediaGroupId: 'G3', text: 'hello', attachments: [att('A')] }),
      ev({ mediaGroupId: 'G3', text: '', attachments: [att('B')] }),
    ])
    expect(merged.text).toBe('hello')
  })

  it('mergeInboundBatch preserves last event messageId', () => {
    const merged = mergeInboundBatch([
      ev({ messageId: '10', mediaGroupId: 'G', attachments: [att('a')] }),
      ev({ messageId: '11', mediaGroupId: 'G', attachments: [att('b')] }),
    ])
    expect(merged.messageId).toBe('11')
  })

  it('replyToText from first non-empty event wins', () => {
    const merged = mergeInboundBatch([
      ev({ mediaGroupId: 'G', attachments: [att('a')] }),
      ev({ mediaGroupId: 'G', replyToText: 'quoted', attachments: [att('b')] }),
    ])
    expect(merged.replyToText).toBe('quoted')
  })

  it('different userIds never share a bucket (coalescer level)', async () => {
    // The coalescer keys by channel:userId, so messages from different users
    // go to separate buckets and mergeInboundBatch is only ever called per
    // bucket. Verify the keying behaviour end-to-end.
    const processed: InboundEvent[][] = []
    const coal = new InboundCoalescer(
      {
        debounceMs: 10,
        minDebounceMs: 0,
        maxDebounceMs: 50,
        maxWaitMs: 1000,
        maxBatchSize: 10,
      },
      async (batch) => {
        processed.push(batch)
      },
    )
    coal.push(
      ev({ userId: '1', mediaGroupId: 'G', attachments: [att('u1a')] }),
    )
    coal.push(
      ev({ userId: '2', mediaGroupId: 'G', attachments: [att('u2a')] }),
    )
    await new Promise((r) => setTimeout(r, 150))
    expect(processed).toHaveLength(2)
    // Each bucket flushed its own single event — no cross-user merging.
    expect(processed[0]).toHaveLength(1)
    expect(processed[1]).toHaveLength(1)
  })
})
