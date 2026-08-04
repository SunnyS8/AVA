// Fix3 — CoachAgent: root-agent tools for inspecting and deciding on persona
// tweak proposals.  The root agent calls these on behalf of the user; nothing
// here applies proposals automatically — approval is the only path from
// proposal to live persona_prompt.
import { z } from 'zod'
import type { MemoryTool } from '../agents/tools/memory-tools.js'
import type { PersonaRepo } from '../personas/repo.js'
import type { ProposalsRepo } from './proposals-repo.js'

export interface CoachToolsDeps {
  workspaceId: string
  proposalsRepo: ProposalsRepo
  personaRepo: PersonaRepo
}

const PREVIEW_LEN = 80

export function createCoachTools(deps: CoachToolsDeps): MemoryTool[] {
  const { workspaceId, proposalsRepo, personaRepo } = deps

  const listParams = z.object({})
  const list: MemoryTool = {
    name: 'list_persona_tweaks',
    description:
      'Вернуть список предлагаемых Coach правок твоей персоны, ждущих решения пользователя. Каждая правка — это минимальная замена куска personality_prompt. Отдаёт превью (не весь diff), чтобы не засорять контекст.',
    parameters: listParams,
    async execute() {
      const rows = await proposalsRepo.listPending(workspaceId)
      return rows.map((r) => ({
        id: r.id,
        rationale: r.rationale,
        previewBefore: r.diff.before.slice(0, PREVIEW_LEN),
        previewAfter: r.diff.after.slice(0, PREVIEW_LEN),
        createdAt: r.createdAt,
      }))
    },
  }

  const showParams = z.object({
    id: z.string().min(1).describe('ID правки (из list_persona_tweaks)'),
  })
  const show: MemoryTool = {
    name: 'show_persona_tweak',
    description:
      'Показать полный diff предложенной правки персоны — поля before/after целиком, rationale и список feedback-ов, на которых она основана.',
    parameters: showParams,
    async execute(params) {
      const { id } = showParams.parse(params)
      const p = await proposalsRepo.get(workspaceId, id)
      if (!p || p.status !== 'pending') {
        return { error: 'proposal not found or not pending' }
      }
      return {
        id: p.id,
        rationale: p.rationale,
        diff: p.diff,
        evidenceFeedbackIds: p.evidenceFeedbackIds,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
      }
    },
  }

  const approveParams = z.object({
    id: z.string().min(1),
  })
  const approve: MemoryTool = {
    name: 'approve_persona_tweak',
    description:
      'Одобрить предложенную правку персоны — она немедленно применяется к personality_prompt (search-and-replace на diff.before -> diff.after). Вызывай ТОЛЬКО после явного согласия пользователя.',
    parameters: approveParams,
    async execute(params) {
      const { id } = approveParams.parse(params)
      const proposal = await proposalsRepo.get(workspaceId, id)
      if (!proposal || proposal.status !== 'pending') {
        return { ok: false, error: 'proposal not found or not pending' }
      }
      const persona = await personaRepo.findByWorkspace(workspaceId)
      if (!persona || !persona.personalityPrompt) {
        return { ok: false, error: 'persona not found' }
      }
      if (!persona.personalityPrompt.includes(proposal.diff.before)) {
        // Stale — base text changed since the proposal was written. Reject it
        // so the user doesn't see it again in list_persona_tweaks.
        await proposalsRepo.reject(workspaceId, id, 'stale base text')
        return {
          ok: false,
          error: 'base text no longer matches current persona (stale)',
        }
      }
      const newPrompt = persona.personalityPrompt.replace(
        proposal.diff.before,
        proposal.diff.after,
      )
      // NOTE: MVP known limitation — if another writer updates personality_prompt
      // between the .get() above and this update, the new write wins and we
      // lose the coach edit. Not worth optimistic locking for v1.
      await personaRepo.updateText(workspaceId, persona.id, {
        personalityPrompt: newPrompt,
      })
      await proposalsRepo.approve(workspaceId, id)
      return { ok: true, applied: true, newLen: newPrompt.length }
    },
  }

  const rejectParams = z.object({
    id: z.string().min(1),
    reason: z.string().optional(),
  })
  const reject: MemoryTool = {
    name: 'reject_persona_tweak',
    description:
      'Отклонить предложенную правку персоны. Используй когда юзер говорит что не хочет такое изменение.',
    parameters: rejectParams,
    async execute(params) {
      const { id, reason } = rejectParams.parse(params)
      const res = await proposalsRepo.reject(workspaceId, id, reason)
      if (!res) {
        return { ok: false, error: 'proposal not found or not pending' }
      }
      return { ok: true, status: res.status }
    },
  }

  return [list, show, approve, reject]
}
