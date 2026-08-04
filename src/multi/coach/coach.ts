// Fix3 — CoachAgent: nightly persona tweak suggestion runner.
//
// Pipeline per workspace:
//   1. Expire old pending proposals (housekeeping).
//   2. Pull recent feedback within `windowDays`.
//   3. Count 👍 / 👎.
//   4. If >= 3 negatives with usable text, call the analyzer (LLM) to propose
//      minimal search-and-replace edits to the persona's personality_prompt.
//   5. Insert surviving proposals into bc_persona_tweak_proposals.
//
// Defensive: per-workspace failures never leak cross-workspace, per-proposal
// insert errors are isolated so one bad row doesn't drop the batch.
import type { Pool } from 'pg'
import { asAdmin } from '../db/rls.js'
import type { FeedbackRepo } from '../feedback/repo.js'
import type { ConversationRepo } from '../memory/conversation-repo.js'
import type { PersonaRepo } from '../personas/repo.js'
import type { ProposalsRepo } from './proposals-repo.js'
import type { CoachLLM, NegativeSample, AnalyzerResult } from './analyzer.js'
import { analyzeFeedback } from './analyzer.js'
import type { CoachAnalysis } from './types.js'
import { log } from '../observability/logger.js'

const FEEDBACK_FETCH_LIMIT = 500

export interface CoachDeps {
  pool: Pool
  feedbackRepo: FeedbackRepo
  convRepo: ConversationRepo
  personaRepo: PersonaRepo
  proposalsRepo: ProposalsRepo
  llm: CoachLLM
  /** DI hook so tests can inject an in-memory analyzer and avoid Gemini. */
  analyzerImpl?: typeof analyzeFeedback
}

export class Coach {
  constructor(private readonly deps: CoachDeps) {}

  async runForWorkspace(
    workspaceId: string,
    windowDays = 7,
  ): Promise<CoachAnalysis> {
    const result: CoachAnalysis = {
      windowDays,
      thumbsUp: 0,
      thumbsDown: 0,
      ratio: 0,
      patternsFound: 0,
      proposalsCreated: 0,
      errors: [],
    }

    // 1. Housekeeping — expire stale pending proposals.
    try {
      await this.deps.proposalsRepo.expireOld(workspaceId)
    } catch (e) {
      log().warn('coach: expireOld failed', {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      })
    }

    // 2. Pull recent feedback. FeedbackRepo.listRecent takes a hard limit, so
    // we filter by createdAt client-side.
    let feedbacks: Awaited<ReturnType<FeedbackRepo['listRecent']>>
    try {
      feedbacks = await this.deps.feedbackRepo.listRecent(
        workspaceId,
        FEEDBACK_FETCH_LIMIT,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      result.errors.push(`listRecent: ${msg}`)
      return result
    }

    const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000
    const inWindow = feedbacks.filter((f) => {
      const t = f.createdAt instanceof Date
        ? f.createdAt.getTime()
        : new Date(f.createdAt as any).getTime()
      return Number.isFinite(t) && t >= cutoffMs
    })

    // 3. Aggregate counts.
    for (const f of inWindow) {
      if (f.rating === 1) result.thumbsUp += 1
      else if (f.rating === -1) result.thumbsDown += 1
    }
    const total = result.thumbsUp + result.thumbsDown
    result.ratio = total > 0 ? result.thumbsUp / total : 0

    if (inWindow.length === 0) {
      log().info('coach: no feedback in window, skip', {
        workspaceId,
        windowDays,
      })
      return result
    }

    // 4. Collect usable negatives (need both user message and assistant reply
    //    text for the LLM to reason about). Silently drop rows that lack them.
    const negatives: NegativeSample[] = []
    for (const f of inWindow) {
      if (f.rating !== -1) continue
      if (!f.rawText || !f.userMessage) continue
      negatives.push({
        feedbackId: f.id,
        userMessage: f.userMessage,
        assistantReply: f.rawText,
      })
    }

    if (negatives.length < 3) {
      log().info('coach: not enough usable negatives, skip', {
        workspaceId,
        negatives: negatives.length,
      })
      return result
    }

    // 5. Load persona.
    let persona: Awaited<ReturnType<PersonaRepo['findByWorkspace']>>
    try {
      persona = await this.deps.personaRepo.findByWorkspace(workspaceId)
    } catch (e) {
      result.errors.push(`persona load: ${e instanceof Error ? e.message : String(e)}`)
      return result
    }
    if (!persona || !persona.personalityPrompt || persona.personalityPrompt.trim().length === 0) {
      result.errors.push('persona not found or personalityPrompt empty')
      return result
    }

    // 6. Analyzer.
    const analyzer = this.deps.analyzerImpl ?? analyzeFeedback
    let analysis: AnalyzerResult
    try {
      analysis = await analyzer({
        currentPersonaPrompt: persona.personalityPrompt,
        negatives,
        llm: this.deps.llm,
      })
    } catch (e) {
      result.errors.push(
        `analyzer: ${e instanceof Error ? e.message : String(e)}`,
      )
      return result
    }
    result.patternsFound = analysis.patterns.length

    // 7. Insert surviving proposals — per-row errors are isolated.
    for (const prop of analysis.proposals) {
      try {
        await this.deps.proposalsRepo.insert(workspaceId, {
          rationale: prop.rationale,
          diff: prop.diff,
          evidenceFeedbackIds: prop.evidenceFeedbackIds,
        })
        result.proposalsCreated += 1
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log().warn('coach: proposal insert failed, skipping', {
          workspaceId,
          error: msg,
        })
        result.errors.push(`insert: ${msg}`)
      }
    }

    log().info('coach: workspace run done', { workspaceId, ...result })
    return result
  }

  /** Enumerate active workspaces and run the coach for each (per-workspace
   *  failures isolated). */
  async runNightly(): Promise<{
    workspacesProcessed: number
    errors: string[]
  }> {
    const errors: string[] = []
    let ids: string[]
    try {
      ids = await asAdmin(this.deps.pool, async (c) => {
        const { rows } = await c.query(
          `select id from workspaces where status = 'active'`,
        )
        return rows.map((r: any) => r.id as string)
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log().error('coach: nightly workspace list failed', { error: msg })
      return { workspacesProcessed: 0, errors: [msg] }
    }

    log().info('coach: nightly start', { workspaceCount: ids.length })
    let processed = 0
    for (const id of ids) {
      try {
        await this.runForWorkspace(id)
        processed += 1
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log().error('coach: workspace run threw', {
          workspaceId: id,
          error: msg,
        })
        errors.push(`${id}: ${msg}`)
      }
    }
    log().info('coach: nightly done', { processed, errors: errors.length })
    return { workspacesProcessed: processed, errors }
  }

  /** Register a nightly pg-boss cron. Fails gracefully when pg-boss isn't
   *  initialised (known gap — see server.ts TODO). */
  async registerCron(boss: unknown): Promise<void> {
    const b: any = boss
    if (!b || typeof b.schedule !== 'function' || typeof b.work !== 'function') {
      log().warn(
        'coach: pg-boss not available, nightly cron not registered (known TODO)',
      )
      return
    }
    // pg-boss v12: queue name can only contain [a-zA-Z0-9_\-./], NOT `:`.
    const queue = 'coach-nightly'
    // pg-boss v10+ requires explicit createQueue before schedule. Idempotent.
    if (typeof b.createQueue === 'function') {
      try {
        await b.createQueue(queue)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!/already exists/i.test(msg)) {
          log().warn('coach: createQueue failed', { queue, error: msg })
        }
      }
    }
    await b.work(queue, async () => {
      await this.runNightly()
    })
    // 04:00 UTC daily — one hour after the learner.
    await b.schedule(queue, '0 4 * * *')
    log().info('coach: cron registered', { queue })
  }
}
