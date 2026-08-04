// Fix3 — CoachAgent: LLM-backed analyzer for negative feedback.
//
// Given the current personality_prompt and a batch of thumbs-down samples,
// asks Gemini Flash (JSON mode) for 1-3 minimal search-and-replace edits.
// Each edit is validated client-side AFTER the LLM returns:
//   - diff.before is non-empty
//   - diff.after is <= 500 chars
//   - diff.before !== diff.after
//   - currentPersonaPrompt.includes(diff.before) (stale edits dropped)
//
// The function never throws — LLM errors / JSON parse errors / schema
// mismatches collapse to an empty result so the Coach just wastes a night.
import { log } from '../observability/logger.js'

const MODEL = 'gemini-2.5-flash'
const MIN_NEGATIVES = 3
const MAX_AFTER_LEN = 500

export interface NegativeSample {
  feedbackId: string
  userMessage: string
  assistantReply: string
}

/** Minimal LLM shim. Same shape as learner's PatternDetectorLLM so tests can
 *  inject any JSON-emitting stub. */
export interface CoachLLM {
  generateJson(systemPrompt: string, userPrompt: string): Promise<string>
}

export interface AnalyzerProposal {
  rationale: string
  diff: { before: string; after: string }
  evidenceFeedbackIds: string[]
}

export interface AnalyzerResult {
  patterns: string[]
  proposals: AnalyzerProposal[]
}

const SYSTEM_PROMPT = `Ты — коуч персоны AI-ассистентки. Пользователь поставил 👎 на несколько ответов.
Тебе дан текущий personality_prompt ассистентки и список плохих ответов.

Твоя задача:
1. Найди 1-3 СИСТЕМНЫХ паттерна того, что не так с персоной (не с конкретным ответом).
2. Для каждого паттерна предложи МИНИМАЛЬНУЮ правку: ровно один substring из
   текущего personality_prompt заменить на новый.

ЖЁСТКИЕ ПРАВИЛА:
- diff.before должен ДОСЛОВНО совпадать с куском текущего persona prompt
  (не перефраз, не частичное совпадение — проверяется .includes()).
- diff.after не длиннее 500 символов.
- diff.before !== diff.after.
- НЕ переписывай всю персону. НЕ придумывай новые свойства.
- НЕ выходи за рамки поиск-и-замена.
- Если не находишь что улучшить — верни пустые patterns и proposals.

Верни СТРОГО JSON без markdown:
{
  "patterns": ["краткое описание паттерна 1", "..."],
  "proposals": [
    {
      "rationale": "почему эта правка помогает",
      "diff": { "before": "кусок из текущего prompt", "after": "новый кусок" }
    }
  ]
}`

function buildUserPrompt(
  currentPersonaPrompt: string,
  negatives: NegativeSample[],
): string {
  const samples = negatives
    .map((n, i) => {
      const u = (n.userMessage ?? '').slice(0, 400)
      const a = (n.assistantReply ?? '').slice(0, 600)
      return `#${i + 1}\n  user: ${u}\n  assistant: ${a}`
    })
    .join('\n')
  return `ТЕКУЩИЙ personality_prompt:
"""
${currentPersonaPrompt}
"""

ПЛОХИЕ ОТВЕТЫ (помечены 👎):
${samples}

Верни JSON с patterns и proposals.`
}

function parseAnalyzerJson(raw: string): {
  patterns: string[]
  proposals: Array<{ rationale: string; diff: { before: string; after: string } }>
} {
  if (!raw) return { patterns: [], proposals: [] }
  let obj: any
  try {
    obj = JSON.parse(raw)
  } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return { patterns: [], proposals: [] }
    try {
      obj = JSON.parse(m[0])
    } catch {
      return { patterns: [], proposals: [] }
    }
  }
  const patterns = Array.isArray(obj?.patterns)
    ? obj.patterns.filter((x: unknown) => typeof x === 'string')
    : []
  const rawProposals = Array.isArray(obj?.proposals) ? obj.proposals : []
  const proposals: Array<{
    rationale: string
    diff: { before: string; after: string }
  }> = []
  for (const p of rawProposals) {
    if (!p || typeof p !== 'object') continue
    const rationale = typeof p.rationale === 'string' ? p.rationale : ''
    const before =
      typeof p.diff?.before === 'string' ? p.diff.before : ''
    const after = typeof p.diff?.after === 'string' ? p.diff.after : ''
    if (!rationale || !before || !after) continue
    proposals.push({ rationale, diff: { before, after } })
  }
  return { patterns, proposals }
}

export async function analyzeFeedback(params: {
  currentPersonaPrompt: string
  negatives: NegativeSample[]
  llm: CoachLLM
}): Promise<AnalyzerResult> {
  const { currentPersonaPrompt, negatives, llm } = params

  if (negatives.length < MIN_NEGATIVES) {
    return { patterns: [], proposals: [] }
  }
  if (!currentPersonaPrompt || currentPersonaPrompt.trim().length === 0) {
    return { patterns: [], proposals: [] }
  }

  let raw: string
  try {
    raw = await llm.generateJson(
      SYSTEM_PROMPT,
      buildUserPrompt(currentPersonaPrompt, negatives),
    )
  } catch (e) {
    log().warn('coach.analyze: llm failed', {
      error: e instanceof Error ? e.message : String(e),
    })
    return { patterns: [], proposals: [] }
  }

  const parsed = parseAnalyzerJson(raw)
  const evidence = negatives.map((n) => n.feedbackId)
  const proposals: AnalyzerProposal[] = []
  for (const p of parsed.proposals) {
    // Sanity filters — any failure drops this proposal, not the whole batch.
    if (p.diff.before.length === 0) continue
    if (p.diff.after.length > MAX_AFTER_LEN) continue
    if (p.diff.before === p.diff.after) continue
    if (!currentPersonaPrompt.includes(p.diff.before)) continue
    proposals.push({
      rationale: p.rationale,
      diff: p.diff,
      evidenceFeedbackIds: evidence,
    })
  }
  log().info('coach.analyze: done', {
    rawProposals: parsed.proposals.length,
    kept: proposals.length,
    patterns: parsed.patterns.length,
  })
  return { patterns: parsed.patterns, proposals }
}

/** Thin shim from @google/genai to CoachLLM. Kept tiny so the Coach main path
 *  is not tangled with the SDK surface; tests never use this path. */
export function createGeminiCoachLLM(gemini: {
  models: { generateContent: (req: any) => Promise<any> }
}): CoachLLM {
  return {
    async generateJson(systemPrompt, userPrompt) {
      const resp: any = await gemini.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          maxOutputTokens: 2000,
          temperature: 0.2,
        } as any,
      })
      return (
        resp.text ??
        resp.candidates?.[0]?.content?.parts?.[0]?.text ??
        ''
      )
    },
  }
}
