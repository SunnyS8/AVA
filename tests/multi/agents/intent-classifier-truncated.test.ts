import { describe, expect, it, vi } from 'vitest'
import { classifyIntent } from '../../../src/multi/agents/intent-classifier.js'

function geminiReturning(rawText: string): any {
  return {
    models: {
      generateContent: vi.fn(async () => ({
        text: rawText,
        candidates: [{ content: { parts: [{ text: rawText }] } }],
      })),
    },
  }
}

describe('intent-classifier truncated JSON recovery', () => {
  it('recovers force_tool from JSON cut off mid-args', async () => {
    // Reproduces prod observation 2026-05-25: Gemini returned the JSON
    // truncated at the args opening brace because thinking tokens consumed
    // the output budget.
    const truncated = `{
  "action": "force_tool",
  "tool": "generate_selfie",
  "args": {
    "scene": ""
  `
    const result = await classifyIntent(
      geminiReturning(truncated) as any,
      'пришли селфи',
    )
    expect(result.action).toBe('force_tool')
    if (result.action === 'force_tool') {
      expect(result.tool).toBe('generate_selfie')
    }
  })

  it('recovers force_tool when only opening JSON received', async () => {
    const veryTruncated = `{"action":"force_tool","tool":"google_search","args":{"query":"`
    const result = await classifyIntent(
      geminiReturning(veryTruncated) as any,
      'погода завтра',
    )
    expect(result.action).toBe('force_tool')
    if (result.action === 'force_tool') {
      expect(result.tool).toBe('google_search')
    }
  })

  it('recovers args.scene when present in truncated payload', async () => {
    const truncatedWithScene = `{"action":"force_tool","tool":"generate_selfie","args":{"scene":"в кафе","aspect`
    const result = await classifyIntent(
      geminiReturning(truncatedWithScene) as any,
      'фотку в кафе',
    )
    expect(result.action).toBe('force_tool')
    if (result.action === 'force_tool') {
      expect(result.tool).toBe('generate_selfie')
      expect(result.args).toMatchObject({ scene: 'в кафе' })
    }
  })

  it('still works with well-formed JSON (regression)', async () => {
    const wellFormed = JSON.stringify({
      action: 'force_tool',
      tool: 'generate_selfie',
      args: { scene: 'улыбается' },
    })
    const result = await classifyIntent(geminiReturning(wellFormed) as any, 'фото')
    expect(result.action).toBe('force_tool')
  })

  it('falls back to normal on completely unrecoverable text', async () => {
    const garbage = 'lorem ipsum dolor'
    const result = await classifyIntent(geminiReturning(garbage) as any, 'привет')
    expect(result.action).toBe('normal')
  })
})
