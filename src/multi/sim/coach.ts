/**
 * Fix3 — CoachAgent end-to-end simulation.
 *
 * Exercises the full coach pipeline end-to-end without Postgres or Gemini:
 *   - in-memory FeedbackRepo with 3 👎 + 2 👍
 *   - in-memory PersonaRepo with a deliberately formal prompt
 *   - in-memory ProposalsRepo (Map-backed)
 *   - mock CoachLLM that returns a single proposal swapping the formal line
 *     for a warm one
 *
 * Then instantiates Coach, runs runForWorkspace, asserts a pending proposal
 * appears, invokes the approve_persona_tweak tool, and asserts the persona's
 * personality_prompt now contains the new line.
 *
 * Run: npx tsx src/multi/sim/coach.ts
 * Exit 0 on success, non-zero on assertion failure.
 */

import { Coach } from '../coach/coach.js'
import { createCoachTools } from '../coach/coach-tools.js'
import type { CoachLLM } from '../coach/analyzer.js'
import type { FeedbackEntry } from '../feedback/types.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`ASSERT FAIL: ${msg}`)
    process.exit(1)
  }
}

const WS = '00000000-0000-0000-0000-0000000000ff'
const INITIAL_PROMPT =
  'Бэтси всегда отвечает формально и использует канцелярский язык. Она обращается на вы.'

async function main(): Promise<void> {
  // --- in-memory FeedbackRepo stub ---
  const now = Date.now()
  const feedbacks: FeedbackEntry[] = [
    {
      id: 'f1',
      workspaceId: WS,
      channel: 'telegram',
      chatId: 'c',
      messageId: 'm1',
      rating: -1,
      rawText: 'Здравствуйте. Относительно вашего вопроса сообщаю следующее...',
      userMessage: 'привет, как дела?',
      createdAt: new Date(now - 3600 * 1000),
    },
    {
      id: 'f2',
      workspaceId: WS,
      channel: 'telegram',
      chatId: 'c',
      messageId: 'm2',
      rating: -1,
      rawText: 'Ваш запрос принят к рассмотрению в установленном порядке.',
      userMessage: 'помоги с фоткой',
      createdAt: new Date(now - 3600 * 2000),
    },
    {
      id: 'f3',
      workspaceId: WS,
      channel: 'telegram',
      chatId: 'c',
      messageId: 'm3',
      rating: -1,
      rawText: 'Доводим до сведения, что данная информация не может быть предоставлена.',
      userMessage: 'расскажи анекдот',
      createdAt: new Date(now - 3600 * 3000),
    },
    {
      id: 'f4',
      workspaceId: WS,
      channel: 'telegram',
      chatId: 'c',
      messageId: 'm4',
      rating: 1,
      rawText: 'ок',
      userMessage: 'спасибо',
      createdAt: new Date(now - 3600 * 4000),
    },
    {
      id: 'f5',
      workspaceId: WS,
      channel: 'telegram',
      chatId: 'c',
      messageId: 'm5',
      rating: 1,
      rawText: 'ок2',
      userMessage: 'ага',
      createdAt: new Date(now - 3600 * 5000),
    },
  ]
  const feedbackRepo: any = {
    async listRecent() {
      return feedbacks
    },
  }

  // --- in-memory PersonaRepo stub ---
  const persona = {
    id: 'persona-1',
    workspaceId: WS,
    personalityPrompt: INITIAL_PROMPT,
  }
  const personaRepo: any = {
    async findByWorkspace() {
      return persona
    },
    async updateText(_ws: string, _id: string, fields: any) {
      if (fields.personalityPrompt) {
        persona.personalityPrompt = fields.personalityPrompt
      }
    },
  }

  // --- in-memory ProposalsRepo stub ---
  const store = new Map<string, any>()
  let nextId = 0
  const proposalsRepo: any = {
    async listPending() {
      return [...store.values()].filter((p) => p.status === 'pending')
    },
    async get(_ws: string, id: string) {
      return store.get(id) ?? null
    },
    async insert(_ws: string, input: any) {
      const id = `prop-${++nextId}`
      store.set(id, {
        id,
        workspaceId: WS,
        rationale: input.rationale,
        diff: input.diff,
        evidenceFeedbackIds: input.evidenceFeedbackIds,
        status: 'pending',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 14 * 86400 * 1000),
      })
      return id
    },
    async approve(_ws: string, id: string) {
      const p = store.get(id)
      if (!p || p.status !== 'pending') return null
      p.status = 'approved'
      p.decidedAt = new Date()
      return p
    },
    async reject(_ws: string, id: string, reason?: string) {
      const p = store.get(id)
      if (!p || p.status !== 'pending') return null
      p.status = 'rejected'
      p.decidedAt = new Date()
      p.rejectReason = reason
      return p
    },
    async expireOld() {
      return 0
    },
  }

  // --- mock CoachLLM that returns exactly one proposal ---
  const llm: CoachLLM = {
    async generateJson() {
      return JSON.stringify({
        patterns: ['канцелярский язык отталкивает'],
        proposals: [
          {
            rationale: 'юзеры жалуются на холодность и формальность',
            diff: {
              before: 'формально и использует канцелярский язык',
              after: 'тёпло и на ты',
            },
          },
        ],
      })
    },
  }

  // --- run coach ---
  const coach = new Coach({
    pool: {} as any,
    feedbackRepo,
    convRepo: {} as any,
    personaRepo,
    proposalsRepo,
    llm,
  })
  const analysis = await coach.runForWorkspace(WS, 7)
  console.log('[sim] coach analysis:', analysis)

  assert(analysis.thumbsDown === 3, 'expected 3 thumbs down')
  assert(analysis.thumbsUp === 2, 'expected 2 thumbs up')
  assert(analysis.proposalsCreated === 1, 'expected 1 proposal created')

  const pending = await proposalsRepo.listPending()
  assert(pending.length === 1, `expected 1 pending proposal, got ${pending.length}`)
  const propId = pending[0].id

  // --- approve via tool ---
  const tools = createCoachTools({
    workspaceId: WS,
    proposalsRepo,
    personaRepo,
  })
  const approveTool = tools.find((t) => t.name === 'approve_persona_tweak')
  assert(approveTool !== undefined, 'approve_persona_tweak tool must exist')
  const approveOut: any = await approveTool!.execute({ id: propId })
  console.log('[sim] approve output:', approveOut)
  assert(approveOut.ok === true, 'approve must return ok=true')

  assert(
    persona.personalityPrompt.includes('тёпло и на ты'),
    'persona prompt must now contain new wording',
  )
  assert(
    !persona.personalityPrompt.includes('формально и использует канцелярский язык'),
    'persona prompt must no longer contain old wording',
  )

  const postApproval = store.get(propId)
  assert(postApproval.status === 'approved', 'proposal must be approved')

  const stillPending = await proposalsRepo.listPending()
  assert(stillPending.length === 0, 'no more pending proposals')

  console.log('[sim] coach end-to-end: OK')
}

main().catch((e) => {
  console.error('[sim] failed:', e)
  process.exit(1)
})
