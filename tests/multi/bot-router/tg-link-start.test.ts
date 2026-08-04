import { describe, expect, it, vi } from 'vitest'
import { handleStartCommand } from '../../../src/multi/bot-router/tg-link-start.js'

describe('/start <nonce> handler', () => {
  it('completes nonce + creates workspace when nonce is active', async () => {
    const completeFn = vi.fn(async () => ({ jwt: 'jwt-x', workspaceId: 'ws-1' }))
    const getPresetIdFn = vi.fn(async () => 'betsy-default')
    const createFromTgFn = vi.fn(async () => ({
      id: 'ws-1',
      ownerTgId: 12345,
      personaId: 'p-1',
    }))
    const sendMessageFn = vi.fn()

    await handleStartCommand(
      { tgUserId: 12345, payload: 'abc-nonce-123' },
      {
        tgLinkService: { getPresetId: getPresetIdFn, complete: completeFn } as any,
        workspaces: { createFromTelegramLogin: createFromTgFn } as any,
        personas: {} as any,
        sendMessage: sendMessageFn,
      },
    )

    expect(getPresetIdFn).toHaveBeenCalledWith('abc-nonce-123')
    expect(createFromTgFn).toHaveBeenCalledWith(12345, 'betsy-default', expect.anything())
    expect(completeFn).toHaveBeenCalledWith('abc-nonce-123', 'ws-1')
    expect(sendMessageFn).toHaveBeenCalledTimes(1)
    const [tgId, text] = sendMessageFn.mock.calls[0]
    expect(tgId).toBe(12345)
    expect(text).toMatch(/Готово/)
    expect(text).toMatch(/Бетси/)
  })

  it('falls back to plainStart when payload is empty', async () => {
    const sendMessageFn = vi.fn()
    const plainStartFn = vi.fn()
    await handleStartCommand(
      { tgUserId: 12345, payload: '' },
      {
        tgLinkService: { getPresetId: vi.fn(), complete: vi.fn() } as any,
        workspaces: { createFromTelegramLogin: vi.fn() } as any,
        personas: {} as any,
        sendMessage: sendMessageFn,
        plainStart: plainStartFn,
      },
    )
    expect(plainStartFn).toHaveBeenCalledWith(12345)
    expect(sendMessageFn).not.toHaveBeenCalled()
  })

  it('does nothing when payload is empty and no plainStart provided', async () => {
    const sendMessageFn = vi.fn()
    await handleStartCommand(
      { tgUserId: 12345, payload: '' },
      {
        tgLinkService: { getPresetId: vi.fn(), complete: vi.fn() } as any,
        workspaces: { createFromTelegramLogin: vi.fn() } as any,
        personas: {} as any,
        sendMessage: sendMessageFn,
      },
    )
    expect(sendMessageFn).not.toHaveBeenCalled()
  })

  it('sends "ссылка устарела" if nonce is unknown or expired', async () => {
    const sendMessageFn = vi.fn()
    const createFromTgFn = vi.fn()
    await handleStartCommand(
      { tgUserId: 12345, payload: 'expired-nonce' },
      {
        tgLinkService: { getPresetId: vi.fn(async () => null), complete: vi.fn() } as any,
        workspaces: { createFromTelegramLogin: createFromTgFn } as any,
        personas: {} as any,
        sendMessage: sendMessageFn,
      },
    )
    expect(createFromTgFn).not.toHaveBeenCalled()
    const [, text] = sendMessageFn.mock.calls[0]
    expect(text).toMatch(/устарел/i)
  })

  it('trims whitespace from payload before treating as nonce', async () => {
    const getPresetIdFn = vi.fn(async () => 'betsy-default')
    const createFromTgFn = vi.fn(async () => ({ id: 'ws-1', ownerTgId: 1, personaId: 'p' }))
    const completeFn = vi.fn(async () => ({ jwt: 'j', workspaceId: 'ws-1' }))
    await handleStartCommand(
      { tgUserId: 1, payload: '  trimmed-nonce  ' },
      {
        tgLinkService: { getPresetId: getPresetIdFn, complete: completeFn } as any,
        workspaces: { createFromTelegramLogin: createFromTgFn } as any,
        personas: {} as any,
        sendMessage: vi.fn(),
      },
    )
    expect(getPresetIdFn).toHaveBeenCalledWith('trimmed-nonce')
  })
})
