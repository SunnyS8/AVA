import { describe, expect, it, vi } from 'vitest'
import { OutboundDispatcher } from '../../../src/multi/channels/outbound-dispatcher.js'

function fakeDesktop() {
  const calls: any[] = []
  return {
    name: 'desktop' as const,
    mirror: vi.fn(async (workspaceId: string, message: any) => {
      calls.push({ workspaceId, message })
    }),
    calls,
  }
}

function fakePlain(name: 'telegram' | 'max') {
  const calls: any[] = []
  return {
    name,
    sendMessage: vi.fn(async (msg: any) => {
      calls.push(msg)
      return {}
    }),
    calls,
  }
}

const noChatIds = { telegram: null, max: null }

describe('OutboundDispatcher', () => {
  it('mirrors to desktop when primary != desktop', async () => {
    const d = fakeDesktop()
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerDesktop(d as any)
    await dispatcher.afterPrimarySend({
      workspaceId: 'ws-A',
      primaryChannel: 'telegram',
      role: 'assistant',
      text: 'hi from TG',
      recipientChatIds: noChatIds,
    })
    expect(d.mirror).toHaveBeenCalledOnce()
    expect(d.calls[0].message.text).toBe('hi from TG')
    expect(d.calls[0].message.channel).toBe('telegram')
  })

  it('does not mirror to desktop when primary == desktop', async () => {
    const d = fakeDesktop()
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerDesktop(d as any)
    await dispatcher.afterPrimarySend({
      workspaceId: 'ws-A',
      primaryChannel: 'desktop',
      role: 'assistant',
      text: 'already in desktop',
      recipientChatIds: noChatIds,
    })
    expect(d.mirror).not.toHaveBeenCalled()
  })

  it('broadcasts to plain channels when primary == desktop', async () => {
    const tg = fakePlain('telegram')
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerPlain(tg as any)
    await dispatcher.afterPrimarySend({
      workspaceId: 'ws-A',
      primaryChannel: 'desktop',
      role: 'assistant',
      text: 'hello from desktop',
      recipientChatIds: { telegram: '123456789', max: null },
    })
    expect(tg.sendMessage).toHaveBeenCalledOnce()
    expect(tg.calls[0]).toEqual({ chatId: '123456789', text: 'hello from desktop' })
  })

  it('user-role messages get [ты]: prefix on plain channels', async () => {
    const tg = fakePlain('telegram')
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerPlain(tg as any)
    await dispatcher.afterPrimarySend({
      workspaceId: 'ws-A',
      primaryChannel: 'desktop',
      role: 'user',
      text: 'привет',
      recipientChatIds: { telegram: '123', max: null },
    })
    expect(tg.calls[0].text).toBe('[ты]: привет')
  })

  it('does NOT prefix assistant-role text on plain channels', async () => {
    const tg = fakePlain('telegram')
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerPlain(tg as any)
    await dispatcher.afterPrimarySend({
      workspaceId: 'ws-A',
      primaryChannel: 'desktop',
      role: 'assistant',
      text: 'привет',
      recipientChatIds: { telegram: '123', max: null },
    })
    expect(tg.calls[0].text).toBe('привет')
  })

  it('does not broadcast to the primary channel itself (no echo)', async () => {
    const tg = fakePlain('telegram')
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerPlain(tg as any)
    await dispatcher.afterPrimarySend({
      workspaceId: 'ws-A',
      primaryChannel: 'telegram',
      role: 'assistant',
      text: 'reply in tg',
      recipientChatIds: { telegram: '123', max: null },
    })
    expect(tg.sendMessage).not.toHaveBeenCalled()
  })

  it('skips channels where the user is not connected (chatId null)', async () => {
    const tg = fakePlain('telegram')
    const max = fakePlain('max')
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerPlain(tg as any)
    dispatcher.registerPlain(max as any)
    await dispatcher.afterPrimarySend({
      workspaceId: 'ws-A',
      primaryChannel: 'desktop',
      role: 'assistant',
      text: 'hi',
      recipientChatIds: { telegram: '123', max: null },
    })
    expect(tg.sendMessage).toHaveBeenCalledOnce()
    expect(max.sendMessage).not.toHaveBeenCalled()
  })

  it('three-way broadcast: desktop primary delivers to tg + max + (mirror to other desktops)', async () => {
    const d1 = fakeDesktop()
    const d2 = fakeDesktop()
    const tg = fakePlain('telegram')
    const max = fakePlain('max')
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerDesktop(d1 as any)
    dispatcher.registerDesktop(d2 as any)
    dispatcher.registerPlain(tg as any)
    dispatcher.registerPlain(max as any)
    await dispatcher.afterPrimarySend({
      workspaceId: 'ws-A',
      primaryChannel: 'desktop',
      role: 'assistant',
      text: 'broadcast',
      recipientChatIds: { telegram: '111', max: '222' },
    })
    // Desktop side: primary == desktop → no desktop mirror
    expect(d1.mirror).not.toHaveBeenCalled()
    expect(d2.mirror).not.toHaveBeenCalled()
    // Plain side: both fire because primary != telegram/max
    expect(tg.sendMessage).toHaveBeenCalledOnce()
    expect(max.sendMessage).toHaveBeenCalledOnce()
  })

  it('plain channel sendMessage error does not throw — best-effort', async () => {
    const tg = {
      name: 'telegram' as const,
      sendMessage: vi.fn(async () => { throw new Error('TG rate limit') }),
    }
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerPlain(tg as any)
    await expect(
      dispatcher.afterPrimarySend({
        workspaceId: 'ws-A',
        primaryChannel: 'desktop',
        role: 'assistant',
        text: 'x',
        recipientChatIds: { telegram: '123', max: null },
      }),
    ).resolves.toBeUndefined()
  })

  it('registerPlain ignores adapter with name=desktop', async () => {
    const fakeDesktopAsPlain = {
      name: 'desktop' as const,
      sendMessage: vi.fn(async () => ({})),
    }
    const dispatcher = new OutboundDispatcher()
    dispatcher.registerPlain(fakeDesktopAsPlain as any)
    await dispatcher.afterPrimarySend({
      workspaceId: 'ws-A',
      primaryChannel: 'telegram',
      role: 'assistant',
      text: 'x',
      recipientChatIds: { telegram: '123', max: null },
    })
    expect(fakeDesktopAsPlain.sendMessage).not.toHaveBeenCalled()
  })
})
