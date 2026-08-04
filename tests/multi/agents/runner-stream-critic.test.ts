import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CriticResult } from '../../../src/multi/critic/types.js'

// Mock the gemini stream runner so we can drive runBetsyStream deterministically
// without standing up real Gemini wiring. The mock yields a few accumulating
// chunks and resolves finalize() with a stable text.
const streamControl: {
  chunks: string[]
  finalText: string
  finalizeError?: Error
} = {
  chunks: [],
  finalText: '',
  finalizeError: undefined,
}

vi.mock('../../../src/multi/agents/gemini-runner.js', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    runWithGeminiToolsStream: vi.fn(async () => {
      async function* gen() {
        for (const c of streamControl.chunks) yield c
      }
      return {
        textStream: gen(),
        finalize: async () => {
          if (streamControl.finalizeError) throw streamControl.finalizeError
          return {
            text: streamControl.finalText,
            toolCalls: [],
            tokensUsed: 1,
          }
        },
      }
    }),
  }
})

import { runBetsyStream } from '../../../src/multi/agents/runner.js'

function mockDeps(overrides: any = {}) {
  const workspace = {
    id: 'ws1',
    displayName: 'K',
    addressForm: 'ty',
    plan: 'personal',
    behaviorConfig: {},
  }
  const persona = {
    id: 'p1',
    workspaceId: 'ws1',
    name: 'Betsy',
    gender: 'female',
    voiceId: 'Aoede',
    personalityPrompt: 'warm friend',
    behaviorConfig: { voice: 'text_only', selfie: 'on_request', video: 'on_request' },
  }
  return {
    persona,
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
      append: vi.fn().mockResolvedValue({ id: 'row1' }),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
    },
    remindersRepo: {},
    s3: {},
    gemini: {},
    agentRunner: vi.fn(),
    ...overrides,
  }
}

function fakeCritic(result: Partial<CriticResult> | Error) {
  const review = vi.fn(async () => {
    if (result instanceof Error) throw result
    return {
      ok: false,
      issues: [],
      durationMs: 1,
      ...result,
    } as CriticResult
  })
  return { review } as any
}

async function drainStream(stream: any): Promise<void> {
  for await (const _ of stream.textStream) {
    // noop
  }
}

describe('runBetsyStream + post-stream Critic (Fix1)', () => {
  const ORIGINAL_FLAG = process.env.BC_CRITIC_ENABLED
  beforeEach(() => {
    delete process.env.BC_CRITIC_ENABLED
    streamControl.chunks = ['Hel', 'Hello', 'Hello world']
    streamControl.finalText = 'Hello world'
    streamControl.finalizeError = undefined
  })
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.BC_CRITIC_ENABLED
    else process.env.BC_CRITIC_ENABLED = ORIGINAL_FLAG
  })

  it('without BC_CRITIC_ENABLED — finalTextPromise resolves with original, critic NOT invoked', async () => {
    const critic = fakeCritic({ ok: false, suggested: 'rewritten longer text here' })
    const deps = mockDeps({ critic })
    const stream = await runBetsyStream({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    await drainStream(stream)
    await stream.done
    expect(critic.review).not.toHaveBeenCalled()
    await expect(stream.finalTextPromise).resolves.toBe('Hello world')
  })

  it('with flag but without deps.critic — finalText is original', async () => {
    process.env.BC_CRITIC_ENABLED = '1'
    const deps = mockDeps({}) // no critic
    const stream = await runBetsyStream({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    await drainStream(stream)
    await stream.done
    await expect(stream.finalTextPromise).resolves.toBe('Hello world')
  })

  it('with flag + ok=true — original is used, append gets original', async () => {
    process.env.BC_CRITIC_ENABLED = '1'
    const critic = fakeCritic({ ok: true })
    const deps = mockDeps({ critic })
    const stream = await runBetsyStream({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    await drainStream(stream)
    await stream.done
    expect(critic.review).toHaveBeenCalledTimes(1)
    await expect(stream.finalTextPromise).resolves.toBe('Hello world')
    const assistantCall = deps.convRepo.append.mock.calls.find(
      (c: any[]) => c[1]?.role === 'assistant',
    )
    expect(assistantCall?.[1]?.content).toBe('Hello world')
  })

  it('with flag + ok=false + valid suggested — finalText is suggested, append gets suggested', async () => {
    process.env.BC_CRITIC_ENABLED = '1'
    const critic = fakeCritic({
      ok: false,
      issues: [{ kind: 'tone', detail: 'cold' }],
      suggested: 'a much warmer rewritten reply for the user',
    })
    const deps = mockDeps({ critic })
    const stream = await runBetsyStream({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    await drainStream(stream)
    await stream.done
    await expect(stream.finalTextPromise).resolves.toBe(
      'a much warmer rewritten reply for the user',
    )
    const assistantCall = deps.convRepo.append.mock.calls.find(
      (c: any[]) => c[1]?.role === 'assistant',
    )
    expect(assistantCall?.[1]?.content).toBe('a much warmer rewritten reply for the user')
  })

  it('with flag + critic throws — finalText falls back to original (fail-open)', async () => {
    process.env.BC_CRITIC_ENABLED = '1'
    const critic = fakeCritic(new Error('boom'))
    const deps = mockDeps({ critic })
    const stream = await runBetsyStream({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    await drainStream(stream)
    await stream.done
    await expect(stream.finalTextPromise).resolves.toBe('Hello world')
  })

  it('with flag + suggested identical to original — NOT applied', async () => {
    process.env.BC_CRITIC_ENABLED = '1'
    const critic = fakeCritic({
      ok: false,
      issues: [{ kind: 'tone', detail: 'x' }],
      suggested: 'Hello world',
    })
    const deps = mockDeps({ critic })
    const stream = await runBetsyStream({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    await drainStream(stream)
    await stream.done
    await expect(stream.finalTextPromise).resolves.toBe('Hello world')
  })

  it('finalize() throws — finalTextPromise resolves with empty string', async () => {
    process.env.BC_CRITIC_ENABLED = '1'
    streamControl.finalizeError = new Error('finalize boom')
    const critic = fakeCritic({ ok: true })
    const deps = mockDeps({ critic })
    const stream = await runBetsyStream({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    await drainStream(stream)
    // done rejects
    await expect(stream.done).rejects.toThrow('finalize boom')
    await expect(stream.finalTextPromise).resolves.toBe('')
    expect(critic.review).not.toHaveBeenCalled()
  })
})
