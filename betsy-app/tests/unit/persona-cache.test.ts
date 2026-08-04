import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonaCache, type CachedPreset } from '../../src/main/persona-cache'

const wizardLines = {
  mode_intro: 'a',
  mode_selfhost_checklist: ['x'],
  mode_selfhost_hint: 'h',
  tg_login_intro: 'a',
  tg_login_waiting: 'a',
  tg_login_success: 'a',
  ssh_prompt: 'a',
  ssh_test_ok: 'a',
  install_progress: 'a',
  install_done: 'a',
  bot_token_prompt: 'a',
  bot_webhook_ok: 'a',
  wizard_complete: 'a',
}

describe('PersonaCache', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pcache-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('fetches from catalog URL and stores presets', async () => {
    const presetsFromServer: CachedPreset[] = [
      {
        id: 'p1',
        name: 'P1',
        gender: 'female',
        voiceId: 'A',
        defaultBehavior: { voice: 'auto', selfie: 'auto', video: 'auto' },
        biography: 'b',
        defaultPersonalityPrompt: 'pp',
        avatar: { static: 'https://x/a.png' },
        wizardLines,
      },
    ]
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/catalog/personas')) {
        return {
          ok: true,
          status: 200,
          json: async () => presetsFromServer,
          headers: { get: () => 'application/json' },
        }
      }
      // avatar download
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }
    })
    const cache = new PersonaCache(dir, 'https://api.test', fetchMock)
    await cache.refresh()
    const list = await cache.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('p1')
    cache.close()
  })

  it('list() works offline after refresh (no fetch call)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => 'application/json' },
    }))
    const cache = new PersonaCache(dir, 'https://api.test', fetchMock)
    await cache.refresh()
    fetchMock.mockClear()
    const list = await cache.list()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(list).toEqual([])
    cache.close()
  })

  it('getAvatarPath returns local file path after refresh', async () => {
    const presets: CachedPreset[] = [
      {
        id: 'p1',
        name: 'P1',
        gender: null,
        voiceId: 'A',
        defaultBehavior: { voice: 'auto', selfie: 'auto', video: 'auto' },
        biography: 'b',
        defaultPersonalityPrompt: 'pp',
        avatar: { static: 'https://x/a.png' },
        wizardLines,
      },
    ]
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('catalog')
        ? {
            ok: true,
            status: 200,
            json: async () => presets,
            headers: { get: () => 'application/json' },
          }
        : {
            ok: true,
            status: 200,
            json: async () => ({}),
            arrayBuffer: async () => new Uint8Array([255, 1, 2, 3]).buffer,
          },
    )
    const cache = new PersonaCache(dir, 'https://api.test', fetchMock)
    await cache.refresh()
    const p = await cache.getAvatarPath('p1')
    expect(p).toBeTruthy()
    expect(p!.endsWith('.bin') || p!.endsWith('.png')).toBe(true)
    cache.close()
  })

  it('hasAny() reflects whether cache has been populated', async () => {
    const cache = new PersonaCache(dir, 'https://api.test', vi.fn())
    expect(cache.hasAny()).toBe(false)
    cache.close()
  })
})
