import { describe, it, expect, vi } from 'vitest'
import { createCoachTools } from '../../../src/multi/coach/coach-tools.js'

const PERSONA_PROMPT =
  'Бэтси всегда отвечает формально и использует канцелярский язык. На вы.'

function makeRepos(overrides: {
  proposal?: any
  persona?: any
} = {}) {
  const proposal = overrides.proposal ?? {
    id: 'p1',
    workspaceId: 'ws',
    rationale: 'make warmer',
    diff: {
      before: 'формально и использует канцелярский язык',
      after: 'тёпло и на ты',
    },
    evidenceFeedbackIds: ['f1', 'f2'],
    status: 'pending',
    createdAt: new Date('2026-04-01'),
    expiresAt: new Date('2026-05-01'),
  }
  const persona = overrides.persona ?? {
    id: 'persona-1',
    personalityPrompt: PERSONA_PROMPT,
  }
  const rejectCalls: any[] = []
  const approveCalls: any[] = []
  const updateTextCalls: any[] = []
  const proposalsRepo: any = {
    async listPending() {
      return [proposal]
    },
    async get(_ws: string, id: string) {
      return proposal && proposal.id === id ? proposal : null
    },
    async approve(_ws: string, id: string) {
      approveCalls.push(id)
      return { ...proposal, status: 'approved' }
    },
    async reject(_ws: string, id: string, reason?: string) {
      rejectCalls.push({ id, reason })
      return { ...proposal, status: 'rejected' }
    },
  }
  const personaRepo: any = {
    async findByWorkspace() {
      return persona
    },
    async updateText(_ws: string, id: string, fields: any) {
      updateTextCalls.push({ id, fields })
      if (fields.personalityPrompt) {
        persona.personalityPrompt = fields.personalityPrompt
      }
    },
  }
  return {
    proposalsRepo,
    personaRepo,
    approveCalls,
    rejectCalls,
    updateTextCalls,
    persona,
  }
}

function findTool(tools: any[], name: string) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

describe('createCoachTools', () => {
  it('list_persona_tweaks returns preview not full diff', async () => {
    const { proposalsRepo, personaRepo } = makeRepos()
    const tools = createCoachTools({
      workspaceId: 'ws',
      proposalsRepo,
      personaRepo,
    })
    const out = (await findTool(tools, 'list_persona_tweaks').execute({})) as any[]
    expect(out).toHaveLength(1)
    expect(out[0]).toHaveProperty('previewBefore')
    expect(out[0]).toHaveProperty('previewAfter')
    expect(out[0]).not.toHaveProperty('diff')
  })

  it('show_persona_tweak returns full diff for an existing pending proposal', async () => {
    const { proposalsRepo, personaRepo } = makeRepos()
    const tools = createCoachTools({
      workspaceId: 'ws',
      proposalsRepo,
      personaRepo,
    })
    const out = (await findTool(tools, 'show_persona_tweak').execute({
      id: 'p1',
    })) as any
    expect(out.diff.before).toBe('формально и использует канцелярский язык')
    expect(out.diff.after).toBe('тёпло и на ты')
    expect(out.evidenceFeedbackIds).toEqual(['f1', 'f2'])
  })

  it('show_persona_tweak for missing id returns error', async () => {
    const { proposalsRepo, personaRepo } = makeRepos()
    proposalsRepo.get = async () => null
    const tools = createCoachTools({
      workspaceId: 'ws',
      proposalsRepo,
      personaRepo,
    })
    const out = (await findTool(tools, 'show_persona_tweak').execute({
      id: 'nope',
    })) as any
    expect(out.error).toBeTruthy()
  })

  it('approve happy path: updates persona and approves proposal', async () => {
    const deps = makeRepos()
    const tools = createCoachTools({
      workspaceId: 'ws',
      proposalsRepo: deps.proposalsRepo,
      personaRepo: deps.personaRepo,
    })
    const out = (await findTool(tools, 'approve_persona_tweak').execute({
      id: 'p1',
    })) as any
    expect(out.ok).toBe(true)
    expect(out.applied).toBe(true)
    expect(deps.updateTextCalls).toHaveLength(1)
    expect(deps.approveCalls).toEqual(['p1'])
    // The new prompt must actually contain diff.after after replacement
    expect(
      deps.updateTextCalls[0].fields.personalityPrompt.includes('тёпло и на ты'),
    ).toBe(true)
    expect(
      deps.updateTextCalls[0].fields.personalityPrompt.includes(
        'формально и использует канцелярский язык',
      ),
    ).toBe(false)
  })

  it('approve with stale before text → rejects proposal with stale reason', async () => {
    const deps = makeRepos({
      persona: {
        id: 'persona-1',
        personalityPrompt: 'Совсем другая персона без совпадений.',
      },
    })
    const tools = createCoachTools({
      workspaceId: 'ws',
      proposalsRepo: deps.proposalsRepo,
      personaRepo: deps.personaRepo,
    })
    const out = (await findTool(tools, 'approve_persona_tweak').execute({
      id: 'p1',
    })) as any
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/stale/i)
    expect(deps.rejectCalls).toHaveLength(1)
    expect(deps.rejectCalls[0].reason).toBe('stale base text')
    expect(deps.updateTextCalls).toHaveLength(0)
  })

  it('approve of already-approved proposal returns error', async () => {
    const deps = makeRepos({
      proposal: {
        id: 'p1',
        workspaceId: 'ws',
        rationale: 'r',
        diff: { before: 'x', after: 'y' },
        evidenceFeedbackIds: [],
        status: 'approved',
        createdAt: new Date(),
        expiresAt: new Date(),
      },
    })
    const tools = createCoachTools({
      workspaceId: 'ws',
      proposalsRepo: deps.proposalsRepo,
      personaRepo: deps.personaRepo,
    })
    const out = (await findTool(tools, 'approve_persona_tweak').execute({
      id: 'p1',
    })) as any
    expect(out.ok).toBe(false)
    expect(out.error).toBeTruthy()
    expect(deps.updateTextCalls).toHaveLength(0)
  })

  it('reject calls proposalsRepo.reject', async () => {
    const deps = makeRepos()
    const tools = createCoachTools({
      workspaceId: 'ws',
      proposalsRepo: deps.proposalsRepo,
      personaRepo: deps.personaRepo,
    })
    const out = (await findTool(tools, 'reject_persona_tweak').execute({
      id: 'p1',
      reason: 'не хочу',
    })) as any
    expect(out.ok).toBe(true)
    expect(deps.rejectCalls).toHaveLength(1)
    expect(deps.rejectCalls[0].reason).toBe('не хочу')
  })

  it('approve: new prompt literally contains diff.after after substitution', async () => {
    const deps = makeRepos()
    const tools = createCoachTools({
      workspaceId: 'ws',
      proposalsRepo: deps.proposalsRepo,
      personaRepo: deps.personaRepo,
    })
    await findTool(tools, 'approve_persona_tweak').execute({ id: 'p1' })
    const newPrompt = deps.updateTextCalls[0].fields.personalityPrompt as string
    expect(newPrompt).toContain('тёпло и на ты')
    expect(newPrompt).toContain('Бэтси всегда отвечает')
    expect(newPrompt).toContain('На вы.')
  })
})

// Silence unused
void vi
