import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildInboundFromTelegramCtx } from '../../../src/multi/channels/telegram.js'
import { ATTACHMENT_MAX_BYTES } from '../../../src/multi/channels/base.js'

/**
 * Fix5: verify Telegram inbound now recognises photos (single/album),
 * documents, captions, and reply context. These are regression tests for
 * the bug where only `msg.text` was mapped to InboundEvent.text, dropping
 * any photo/caption/reply info on the floor.
 */

function makeCtx(message: any): any {
  return {
    chat: { id: 100 },
    from: { id: 7, first_name: 'K' },
    message: { date: 1, message_id: 1, ...message },
    api: {
      token: 'TOKEN',
      getFile: vi.fn(async (_fileId: string) => ({
        file_path: 'photos/file_1.jpg',
      })),
    },
  }
}

describe('buildInboundFromTelegramCtx — media (Fix5)', () => {
  const origFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (_url: any) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    })) as any
  })
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('text-only message has no attachments', () => {
    const ev = buildInboundFromTelegramCtx(makeCtx({ text: 'hi' }), 'TEST_TOKEN')
    expect(ev.text).toBe('hi')
    expect(ev.attachments).toBeUndefined()
    expect(ev.replyToText).toBeUndefined()
    expect(ev.mediaGroupId).toBeUndefined()
  })

  it('photo without caption → text empty, one image attachment', () => {
    const ev = buildInboundFromTelegramCtx(
      makeCtx({
        photo: [
          { file_id: 'A', width: 90, height: 90 },
          { file_id: 'B', width: 1024, height: 768 },
        ],
      }),
      "TEST_TOKEN",
    )
    expect(ev.text).toBe('')
    expect(ev.attachments).toHaveLength(1)
    expect(ev.attachments![0]).toMatchObject({
      kind: 'image',
      fileId: 'B',
      mimeType: 'image/jpeg',
    })
    expect(ev.attachments![0].summary).toContain('1024')
  })

  it('photo with caption → text = caption, attachment present', () => {
    const ev = buildInboundFromTelegramCtx(
      makeCtx({
        caption: 'look at this',
        photo: [{ file_id: 'X', width: 10, height: 10 }],
      }),
      "TEST_TOKEN",
    )
    expect(ev.text).toBe('look at this')
    expect(ev.attachments).toHaveLength(1)
  })

  it('message with both text and caption keeps text priority', () => {
    // Edge case, not normally possible, but defensive.
    const ev = buildInboundFromTelegramCtx(
      makeCtx({
        text: 'explicit text',
        caption: 'caption',
        photo: [{ file_id: 'X', width: 10, height: 10 }],
      }),
      "TEST_TOKEN",
    )
    expect(ev.text).toBe('explicit text')
    expect(ev.attachments).toHaveLength(1)
  })

  it('document image/png → one image attachment', () => {
    const ev = buildInboundFromTelegramCtx(
      makeCtx({
        document: { file_id: 'D', mime_type: 'image/png', file_name: 'a.png' },
      }),
      "TEST_TOKEN",
    )
    expect(ev.attachments).toHaveLength(1)
    expect(ev.attachments![0].kind).toBe('image')
    expect(ev.attachments![0].mimeType).toBe('image/png')
  })

  it('document application/pdf → one document attachment', () => {
    const ev = buildInboundFromTelegramCtx(
      makeCtx({
        document: { file_id: 'D', mime_type: 'application/pdf', file_name: 'a.pdf' },
      }),
      "TEST_TOKEN",
    )
    expect(ev.attachments).toHaveLength(1)
    expect(ev.attachments![0].kind).toBe('document')
  })

  it('document application/zip is filtered out', () => {
    const ev = buildInboundFromTelegramCtx(
      makeCtx({
        document: { file_id: 'D', mime_type: 'application/zip', file_name: 'a.zip' },
      }),
      "TEST_TOKEN",
    )
    expect(ev.attachments).toBeUndefined()
  })

  it('document with null mime_type is filtered out', () => {
    const ev = buildInboundFromTelegramCtx(
      makeCtx({ document: { file_id: 'D', mime_type: null, file_name: 'x' } }),
      "TEST_TOKEN",
    )
    expect(ev.attachments).toBeUndefined()
  })

  it('reply to text message → replyToText', () => {
    const ev = buildInboundFromTelegramCtx(
      makeCtx({
        text: 'ok',
        reply_to_message: { text: 'the original' },
      }),
      "TEST_TOKEN",
    )
    expect(ev.replyToText).toBe('the original')
  })

  it('reply to a photo with caption → replyToText = caption', () => {
    const ev = buildInboundFromTelegramCtx(
      makeCtx({
        text: 'ok',
        reply_to_message: { caption: 'photo caption' },
      }),
      "TEST_TOKEN",
    )
    expect(ev.replyToText).toBe('photo caption')
  })

  it('media_group_id is captured', () => {
    const ev = buildInboundFromTelegramCtx(
      makeCtx({
        media_group_id: '1234',
        caption: 'album',
        photo: [{ file_id: 'X', width: 10, height: 10 }],
      }),
      "TEST_TOKEN",
    )
    expect(ev.mediaGroupId).toBe('1234')
  })

  it('voice message → voice flag set, no attachments', () => {
    const ev = buildInboundFromTelegramCtx(
      makeCtx({ voice: { file_id: 'V', duration: 3 } }),
      "TEST_TOKEN",
    )
    expect(ev.isVoiceMessage).toBe(true)
    expect(ev.attachments).toBeUndefined()
  })

  it('attachment.fetch() calls getFile and returns base64', async () => {
    const ctx = makeCtx({
      photo: [{ file_id: 'PHOTOID', width: 10, height: 10 }],
    })
    const ev = buildInboundFromTelegramCtx(ctx, 'TEST_TOKEN')
    const result = await ev.attachments![0].fetch()
    expect(ctx.api.getFile).toHaveBeenCalledWith('PHOTOID')
    expect(result.mimeType).toBe('image/jpeg')
    expect(typeof result.base64).toBe('string')
    expect(Buffer.from(result.base64, 'base64').toString('hex')).toBe('01020304')
  })

  it('attachment.fetch() throws when file exceeds 10 MB cap', async () => {
    const bigBuf = new Uint8Array(ATTACHMENT_MAX_BYTES + 10).buffer
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bigBuf,
    })) as any
    const ctx = makeCtx({ photo: [{ file_id: 'BIG', width: 1, height: 1 }] })
    const ev = buildInboundFromTelegramCtx(ctx, 'TEST_TOKEN')
    await expect(ev.attachments![0].fetch()).rejects.toThrow(/too large/i)
  })
})
