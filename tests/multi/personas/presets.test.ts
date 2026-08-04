import { describe, expect, it } from 'vitest'
import { BUILTIN_PRESETS, getPreset, listPresets } from '../../../src/multi/personas/presets.js'
import { personaPresetsArraySchema } from '../../../src/multi/personas/presets-schema.js'

describe('persona presets', () => {
  it('exposes at least 2 built-in presets', () => {
    expect(BUILTIN_PRESETS.length).toBeGreaterThanOrEqual(2)
  })

  it('all presets pass zod schema', () => {
    expect(() => personaPresetsArraySchema.parse(BUILTIN_PRESETS)).not.toThrow()
  })

  it('preset ids are unique', () => {
    const ids = BUILTIN_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('includes betsy-default and betsy-pro', () => {
    expect(getPreset('betsy-default')).not.toBeNull()
    expect(getPreset('betsy-pro')).not.toBeNull()
  })

  it('getPreset returns null for unknown id', () => {
    expect(getPreset('nonexistent')).toBeNull()
  })

  it('listPresets returns a snapshot, not a reference', () => {
    const list = listPresets()
    expect(list.length).toBe(BUILTIN_PRESETS.length)
    list.length = 0
    expect(BUILTIN_PRESETS.length).toBeGreaterThan(0)
  })
})
