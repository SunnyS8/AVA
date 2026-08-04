import { describe, it, expect, vi } from 'vitest'
import { runBetsy } from '../../../src/multi/agents/runner.js'
import type { InboundAttachment } from '../../../src/multi/channels/base.js'

function mockDeps(agentRunner: any) {
  const workspace = {
    id: 'ws1',
    ownerTgId: 123,
    ownerMaxId: null,
    displayName: 'K',
    businessContext: null,
    addressForm: 'ty',
    personaId: 'betsy',
    plan: 'personal',
    status: 'active',
    tokensUsedPeriod: 0,
    tokensLimitPeriod: 1_000_000,
    periodResetAt: null,
    balanceKopecks: 0,
    lastActiveChannel: 'telegram',
    notifyChannelPref: 'auto',
    tz: 'Europe/Moscow',
    createdAt: new Date(),
  }
  const persona = {
    id: 'p1',
    workspaceId: 'ws1',
    presetId: 'betsy',
    name: 'Betsy',
    gender: 'female',
    voiceId: 'Aoede',
    personalityPrompt: null,
    biography: null,
    avatarS3Key: null,
    referenceFrontS3Key: null,
    referenceThreeQS3Key: null,
    referenceProfileS3Key: null,
    behaviorConfig: { voice: 'text_only', selfie: 'on_request', video: 'on_request' },
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  return {
    wsRepo: { findById: vi.fn().mockResolvedValue(workspace) },
    personaRepo: { findByWorkspace: vi.fn().mockResolvedValue(persona) },
    factsRepo: {
      list: vi.fn().mockResolvedValue([]),
      listByKind: vi.fn().mockResolvedValue([]),
      listMissingEmbeddings: vi.fn().mockResolvedValue([]),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
    },
    convRepo: {
      recent: vi.fn().mockResolvedValue([]),
      append: vi.fn().mockResolvedValue({ id: 'row-1' }),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
    },
    remindersRepo: {},
    s3: {},
    gemini: {},
    agentRunner,
    ttsSpeak: vi.fn(),
  }
}

function attMock(id: string, base64: string, fetchSpy?: any): InboundAttachment {
  const fetch =
    fetchSpy ??
    vi.fn(async () => ({ base64, mimeType: 'image/jpeg' }))
  return {
    kind: 'image',
    fileId: id,
    mimeType: 'image/jpeg',
    fetch,
    summary: `photo ${id}`,
  }
}

describe('runBetsy — Fix5 attachments', () => {
  it('downloads attachments and forwards them as inlineParts', async () => {
    const agentRunner = vi.fn().mockResolvedValue({
      text: 'I see a photo',
      toolCalls: [],
      tokensUsed: 10,
    })
    const deps = mockDeps(agentRunner)
    const f1 = vi.fn(async () => ({ base64: 'AAA', mimeType: 'image/jpeg' }))
    const f2 = vi.fn(async () => ({ base64: 'BBB', mimeType: 'image/png' }))
    const a1 = { ...attMock('f1', 'AAA'), fetch: f1 }
    const a2 = { ...attMock('f2', 'BBB'), fetch: f2, mimeType: 'image/png' }
    a2.mimeType = 'image/png'

    await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'check',
      channel: 'telegram',
      currentChatId: 'chat1',
      deps: deps as any,
      attachments: [a1, a2],
    })
    expect(f1).toHaveBeenCalled()
    expect(f2).toHaveBeenCalled()
    // agentRunner(agent, userMessage, history, inlineParts)
    const args = agentRunner.mock.calls[0]
    const inlineParts = args[3]
    expect(inlineParts).toHaveLength(2)
    expect(inlineParts[0].inlineData.data).toBe('AAA')
    expect(inlineParts[1].inlineData.data).toBe('BBB')
    expect(inlineParts[0].inlineData.mimeType).toBe('image/jpeg')
    expect(inlineParts[1].inlineData.mimeType).toBe('image/png')
    // FIX7: marker now uses "прикреплено N изображение" + explicit vision instruction
    expect(args[1]).toContain('check')
    expect(args[1]).toContain('прикреплено 2 изображение')
    expect(args[1]).toContain('мультимодальное зрение')
  })

  it('empty text + 1 attachment → placeholder userMessage', async () => {
    const agentRunner = vi.fn().mockResolvedValue({
      text: 'nice pic',
      toolCalls: [],
      tokensUsed: 1,
    })
    const deps = mockDeps(agentRunner)
    await runBetsy({
      workspaceId: 'ws1',
      userMessage: '',
      channel: 'telegram',
      currentChatId: 'chat1',
      deps: deps as any,
      attachments: [attMock('f', 'DATA')],
    })
    const userMessage = agentRunner.mock.calls[0][1]
    // FIX7: marker now explicitly tells the model it has multimodal vision
    expect(userMessage).toContain('прикреплено 1 изображение')
    expect(userMessage).toContain('мультимодальное зрение')
  })

  it('replyToText is prepended to the userMessage', async () => {
    const agentRunner = vi.fn().mockResolvedValue({
      text: 'ok',
      toolCalls: [],
      tokensUsed: 1,
    })
    const deps = mockDeps(agentRunner)
    await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'да',
      channel: 'telegram',
      currentChatId: 'chat1',
      deps: deps as any,
      replyToText: 'подтверди пожалуйста',
    })
    const userMessage = agentRunner.mock.calls[0][1]
    expect(userMessage.startsWith('[В ответ на: подтверди пожалуйста]')).toBe(true)
    expect(userMessage).toContain('да')
  })

  it('failed attachment fetch is skipped, other attachments still forwarded', async () => {
    const agentRunner = vi.fn().mockResolvedValue({
      text: 'ok',
      toolCalls: [],
      tokensUsed: 1,
    })
    const deps = mockDeps(agentRunner)
    const bad = {
      ...attMock('bad', ''),
      fetch: vi.fn(async () => {
        throw new Error('expired')
      }),
    }
    const good = attMock('good', 'GOOD')
    await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'ok',
      channel: 'telegram',
      currentChatId: 'chat1',
      deps: deps as any,
      attachments: [bad, good],
    })
    const inlineParts = agentRunner.mock.calls[0][3]
    expect(inlineParts).toHaveLength(1)
    expect(inlineParts[0].inlineData.data).toBe('GOOD')
  })

  it('FIX7: vision-denial assistant turns are scrubbed from history when attachments present', async () => {
    const agentRunner = vi.fn().mockResolvedValue({
      text: 'ok',
      toolCalls: [],
      tokensUsed: 1,
    })
    // Mock convRepo.recent to return poisoned history
    const deps = mockDeps(agentRunner)
    deps.convRepo.recent = vi.fn().mockResolvedValue([
      { role: 'user', content: '[прислано 1 фото без подписи]', timestamp: new Date() },
      { role: 'assistant', content: 'Ой, я не могу видеть картинки! 🙈', timestamp: new Date() },
      { role: 'user', content: 'ну посмотри!', timestamp: new Date() },
      { role: 'assistant', content: 'я не умею смотреть, только читать и писать', timestamp: new Date() },
    ])
    await runBetsy({
      workspaceId: 'ws1',
      userMessage: '',
      channel: 'telegram',
      currentChatId: 'chat1',
      deps: deps as any,
      attachments: [attMock('p', 'PNG')],
    })
    const passedHistory = agentRunner.mock.calls[0][2]
    // Both denial assistant turns must be replaced with the neutral marker
    const denialTurns = passedHistory.filter((t: any) =>
      /не могу видеть|не умею смотреть/i.test(t.content),
    )
    expect(denialTurns).toHaveLength(0)
    const scrubbedTurns = passedHistory.filter((t: any) =>
      /прошлый ответ удалён.*ошибочное/i.test(t.content),
    )
    expect(scrubbedTurns.length).toBeGreaterThanOrEqual(2)
  })

  it('FIX7: history is NOT scrubbed when no attachments (preserve normal flow)', async () => {
    const agentRunner = vi.fn().mockResolvedValue({
      text: 'ok',
      toolCalls: [],
      tokensUsed: 1,
    })
    const deps = mockDeps(agentRunner)
    deps.convRepo.recent = vi.fn().mockResolvedValue([
      { role: 'assistant', content: 'я не могу видеть картинки', timestamp: new Date() },
    ])
    await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'привет',
      channel: 'telegram',
      currentChatId: 'chat1',
      deps: deps as any,
      // no attachments
    })
    const passedHistory = agentRunner.mock.calls[0][2]
    // Without attachments, scrubbing is skipped — original content remains
    expect(passedHistory.some((t: any) => /не могу видеть/i.test(t.content))).toBe(true)
  })
})
