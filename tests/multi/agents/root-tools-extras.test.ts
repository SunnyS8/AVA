/**
 * Audit fix B1 regression test.
 *
 * The code-reviewer found that `learnerTools` and `oauthTools` were built by
 * `buildRootTools` and added to `allRootTools` but the runner only forwarded
 * `leafTools`/`delegationTools`/`skillTools` to `createBetsyAgent`, so the
 * Wave 2A learner approval tools and Wave 3C integration tools were silently
 * dropped at runtime.
 *
 * This test pins the contract: when learner/oauth deps are wired, the
 * `extraTools` bucket of `RootToolBundle` MUST contain the corresponding
 * tool names. Catches future regressions if anyone removes the bucket again.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildRootTools } from '../../../src/multi/agents/root-tools.js'
import { createRunContext } from '../../../src/multi/agents/run-context.js'

function makeBaseDeps() {
  return {
    factsRepo: {
      list: vi.fn().mockResolvedValue([]),
      listByKind: vi.fn().mockResolvedValue([]),
      listMissingEmbeddings: vi.fn().mockResolvedValue([]),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
    } as any,
    convRepo: {
      recent: vi.fn().mockResolvedValue([]),
      append: vi.fn().mockResolvedValue({ id: 'row1' }),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
    } as any,
    remindersRepo: {} as any,
    personaRepo: {} as any,
    s3: {} as any,
    gemini: {
      models: {
        generateContent: vi.fn(),
        generateContentStream: vi.fn(),
      },
    } as any,
  }
}

const baseOpts = {
  workspaceId: 'ws-1',
  channel: 'telegram' as const,
  currentChatId: 'chat-1',
  runContext: createRunContext(),
  mcpLoaded: null,
}

describe('buildRootTools — extras bucket (audit fix B1)', () => {
  it('omits extras when neither learner nor oauth deps are wired', () => {
    const deps = makeBaseDeps()
    const bundle = buildRootTools(deps as any, baseOpts)
    expect(bundle.extraTools).toEqual([])
    // Sanity: allRootTools still includes everything else
    expect(bundle.allRootTools.length).toBeGreaterThanOrEqual(bundle.leafTools.length)
  })

  it('exposes learner candidate tools in extras when learnerCandidatesRepo is wired', () => {
    const deps = makeBaseDeps()
    ;(deps as any).learnerCandidatesRepo = {
      listPending: vi.fn().mockResolvedValue([]),
      approve: vi.fn(),
      reject: vi.fn(),
    }
    const bundle = buildRootTools(deps as any, baseOpts)
    const names = bundle.extraTools.map((t) => t.name)
    expect(names).toContain('list_skill_candidates')
    expect(names).toContain('approve_skill_candidate')
    expect(names).toContain('reject_skill_candidate')
    // And they bubble into allRootTools
    expect(bundle.allRootTools.map((t) => t.name)).toContain('list_skill_candidates')
  })

  it('exposes oauth integration tools in extras when oauthToolsDeps is supplied', () => {
    const deps = makeBaseDeps()
    const bundle = buildRootTools(deps as any, {
      ...baseOpts,
      oauthToolsDeps: {
        workspaceId: 'ws-1',
        oauthRepo: {
          listTokens: vi.fn().mockResolvedValue([]),
          getToken: vi.fn().mockResolvedValue(null),
          deleteToken: vi.fn().mockResolvedValue(false),
        } as any,
        mcpServersRepo: {
          listServers: vi.fn().mockResolvedValue([]),
          upsertServer: vi.fn(),
          deleteServer: vi.fn(),
        } as any,
      },
    })
    const names = bundle.extraTools.map((t) => t.name)
    expect(names).toContain('list_integrations')
    expect(names).toContain('connect_integration')
    expect(names).toContain('disconnect_integration')
    expect(names).toContain('integration_status')
    expect(bundle.allRootTools.map((t) => t.name)).toContain('list_integrations')
  })

  it('combines learner + oauth extras when both wired', () => {
    const deps = makeBaseDeps()
    ;(deps as any).learnerCandidatesRepo = {
      listPending: vi.fn().mockResolvedValue([]),
      approve: vi.fn(),
      reject: vi.fn(),
    }
    const bundle = buildRootTools(deps as any, {
      ...baseOpts,
      oauthToolsDeps: {
        workspaceId: 'ws-1',
        oauthRepo: { listTokens: vi.fn().mockResolvedValue([]) } as any,
        mcpServersRepo: { listServers: vi.fn().mockResolvedValue([]) } as any,
      },
    })
    const names = bundle.extraTools.map((t) => t.name)
    expect(names).toContain('list_skill_candidates')
    expect(names).toContain('list_integrations')
    expect(bundle.extraTools.length).toBeGreaterThanOrEqual(7) // 3 learner + 4 oauth
  })
})
