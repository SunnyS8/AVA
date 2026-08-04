import { describe, it, expect, vi } from 'vitest'
import {
  analyzeFeedback,
  type CoachLLM,
  type NegativeSample,
} from '../../../src/multi/coach/analyzer.js'

const PERSONA =
  'Бэтси всегда отвечает формально и использует канцелярский язык. Она обращается на вы.'

function mkNegatives(n: number): NegativeSample[] {
  return Array.from({ length: n }, (_, i) => ({
    feedbackId: `fb-${i}`,
    userMessage: `вопрос ${i}`,
    assistantReply: `сухой формальный ответ ${i}`,
  }))
}

function mkLLM(response: string | (() => string | Promise<string>)): CoachLLM {
  return {
    generateJson: vi.fn(async () => {
      if (typeof response === 'function') return response()
      return response
    }),
  }
}

describe('analyzeFeedback', () => {
  it('returns empty result and does not call LLM when < 3 negatives', async () => {
    const llm = mkLLM('{"patterns":["x"],"proposals":[]}')
    const r = await analyzeFeedback({
      currentPersonaPrompt: PERSONA,
      negatives: mkNegatives(2),
      llm,
    })
    expect(r.patterns).toEqual([])
    expect(r.proposals).toEqual([])
    expect(llm.generateJson).not.toHaveBeenCalled()
  })

  it('happy path: 5 negatives, 2 proposals both pass sanity filters', async () => {
    const llm = mkLLM(
      JSON.stringify({
        patterns: ['слишком формально', 'канцелярит'],
        proposals: [
          {
            rationale: 'юзеры жалуются на холодность',
            diff: {
              before: 'формально и использует канцелярский язык',
              after: 'тёпло и на ты',
            },
          },
          {
            rationale: 'обращение на вы отталкивает',
            diff: {
              before: 'Она обращается на вы.',
              after: 'Она обращается на ты.',
            },
          },
        ],
      }),
    )
    const r = await analyzeFeedback({
      currentPersonaPrompt: PERSONA,
      negatives: mkNegatives(5),
      llm,
    })
    expect(r.proposals).toHaveLength(2)
    expect(r.proposals[0].evidenceFeedbackIds).toHaveLength(5)
    expect(r.patterns).toHaveLength(2)
  })

  it('drops proposal whose before text is not in the current prompt', async () => {
    const llm = mkLLM(
      JSON.stringify({
        patterns: [],
        proposals: [
          {
            rationale: 'stale',
            diff: { before: 'какой-то другой текст', after: 'новое' },
          },
        ],
      }),
    )
    const r = await analyzeFeedback({
      currentPersonaPrompt: PERSONA,
      negatives: mkNegatives(4),
      llm,
    })
    expect(r.proposals).toHaveLength(0)
  })

  it('drops proposal whose after exceeds 500 chars', async () => {
    const longAfter = 'x'.repeat(501)
    const llm = mkLLM(
      JSON.stringify({
        patterns: [],
        proposals: [
          {
            rationale: 'too long',
            diff: { before: 'формально', after: longAfter },
          },
        ],
      }),
    )
    const r = await analyzeFeedback({
      currentPersonaPrompt: PERSONA,
      negatives: mkNegatives(3),
      llm,
    })
    expect(r.proposals).toHaveLength(0)
  })

  it('drops proposal where before === after (noop)', async () => {
    const llm = mkLLM(
      JSON.stringify({
        patterns: [],
        proposals: [
          {
            rationale: 'noop',
            diff: { before: 'формально', after: 'формально' },
          },
        ],
      }),
    )
    const r = await analyzeFeedback({
      currentPersonaPrompt: PERSONA,
      negatives: mkNegatives(3),
      llm,
    })
    expect(r.proposals).toHaveLength(0)
  })

  it('gracefully returns empty result when LLM throws', async () => {
    const llm: CoachLLM = {
      async generateJson() {
        throw new Error('gemini down')
      },
    }
    const r = await analyzeFeedback({
      currentPersonaPrompt: PERSONA,
      negatives: mkNegatives(3),
      llm,
    })
    expect(r.patterns).toEqual([])
    expect(r.proposals).toEqual([])
  })

  it('gracefully handles invalid JSON from LLM', async () => {
    const llm = mkLLM('not json at all {{{')
    const r = await analyzeFeedback({
      currentPersonaPrompt: PERSONA,
      negatives: mkNegatives(3),
      llm,
    })
    expect(r.proposals).toEqual([])
  })
})
