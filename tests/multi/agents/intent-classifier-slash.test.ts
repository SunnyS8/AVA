/**
 * Deterministic slash-command classifier.
 *
 * Telegram bot menu entries (/tweaks, /candidates etc) arrive as literal
 * slash commands. They should short-circuit the LLM classifier — both for
 * cost and for reliability (deterministic routing can't hallucinate).
 */
import { describe, it, expect, vi } from 'vitest'
import { classifyIntent } from '../../../src/multi/agents/intent-classifier.js'

// Gemini is only used for non-slash paths. Any call to it in these tests
// is a test failure.
const FAILING_GEMINI = {
  models: {
    generateContent: vi.fn().mockImplementation(() => {
      throw new Error('classifier should not call Gemini for slash commands')
    }),
  },
} as any

describe('classifyIntent — slash short-circuit', () => {
  it('/tweaks → force_tool list_persona_tweaks', async () => {
    const r = await classifyIntent(FAILING_GEMINI, '/tweaks')
    expect(r).toEqual({
      action: 'force_tool',
      tool: 'list_persona_tweaks',
      args: {},
    })
  })

  it('/candidates → list_skill_candidates', async () => {
    const r = await classifyIntent(FAILING_GEMINI, '/candidates')
    expect(r).toMatchObject({
      action: 'force_tool',
      tool: 'list_skill_candidates',
    })
  })

  it('/skills → list_skills', async () => {
    const r = await classifyIntent(FAILING_GEMINI, '/skills')
    expect(r).toMatchObject({ action: 'force_tool', tool: 'list_skills' })
  })

  it('/reminders → list_reminders', async () => {
    const r = await classifyIntent(FAILING_GEMINI, '/reminders')
    expect(r).toMatchObject({ action: 'force_tool', tool: 'list_reminders' })
  })

  it('/integrations → list_integrations', async () => {
    const r = await classifyIntent(FAILING_GEMINI, '/integrations')
    expect(r).toMatchObject({ action: 'force_tool', tool: 'list_integrations' })
  })

  it('/selfie without args → generate_selfie with empty scene', async () => {
    const r = await classifyIntent(FAILING_GEMINI, '/selfie')
    expect(r).toMatchObject({
      action: 'force_tool',
      tool: 'generate_selfie',
      args: { scene: '' },
    })
  })

  it('/selfie в кафе → generate_selfie with scene', async () => {
    const r = await classifyIntent(FAILING_GEMINI, '/selfie в кафе')
    expect(r).toMatchObject({
      action: 'force_tool',
      tool: 'generate_selfie',
      args: { scene: 'в кафе' },
    })
  })

  it('/start → normal (main agent handles greeting with persona)', async () => {
    // FIX6: /start no longer hard-codes a greeting — it falls through to
    // the main agent so Бэтси answers in her own voice with full context.
    const r = await classifyIntent(FAILING_GEMINI, '/start')
    expect(r.action).toBe('normal')
  })

  it('/help → normal (main agent handles help)', async () => {
    const r = await classifyIntent(FAILING_GEMINI, '/help')
    expect(r.action).toBe('normal')
  })

  it('/tweaks@BetsyBot → still works (strips bot suffix)', async () => {
    const r = await classifyIntent(FAILING_GEMINI, '/tweaks@BetsyBot')
    expect(r).toMatchObject({ action: 'force_tool', tool: 'list_persona_tweaks' })
  })

  it('/unknown → falls through to LLM (no short-circuit)', async () => {
    const mockGemini = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: '{"action":"normal"}',
        }),
      },
    } as any
    const r = await classifyIntent(mockGemini, '/unknownCommand')
    expect(r.action).toBe('normal')
    expect(mockGemini.models.generateContent).toHaveBeenCalledOnce()
  })

  it('FIX6: clarify from LLM is downgraded to normal', async () => {
    // Regression: classifier has no history, so any clarifying question
    // it invents will be a wrong blind guess. If LLM still emits
    // action:clarify (e.g. prompt drift), downgrade to normal so the main
    // agent (with history) handles the reply. The specific user bug was
    // «Бэтси: Подключить Gmail?» → «Костя: да» → classifier sees only "да"
    // → returns clarify «что именно?» → router skips agent → wrong reply.
    const mockGemini = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: '{"action":"clarify","question":"что именно?"}',
        }),
      },
    } as any
    const r = await classifyIntent(mockGemini, 'да')
    expect(r.action).toBe('normal')
  })

  it('plain text without slash → not short-circuited, hits LLM', async () => {
    const mockGemini = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: '{"action":"normal"}',
        }),
      },
    } as any
    const r = await classifyIntent(mockGemini, 'обычный вопрос')
    expect(r.action).toBe('normal')
    expect(mockGemini.models.generateContent).toHaveBeenCalledOnce()
  })
})
