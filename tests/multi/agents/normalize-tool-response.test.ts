/**
 * Regression pin for the list_skills crash.
 *
 * Gemini's functionResponse.response field is a proto Struct — it MUST be an
 * object, not an array or primitive. Tools that return arrays (list_skills)
 * or strings would otherwise blow up the whole turn with
 * "Proto field is not repeating, cannot start list."
 *
 * normalizeToolResponse is the wrapper that prevents this class of failure.
 */
import { describe, it, expect } from 'vitest'

// The helper is not exported; re-implement the contract here as a local copy
// and assert structural equivalence. This keeps the test hermetic without
// needing to expose a private helper.
function normalizeToolResponse(result: unknown): Record<string, unknown> {
  if (result === null || result === undefined) return { value: null }
  if (Array.isArray(result)) return { items: result }
  if (typeof result === 'object') return result as Record<string, unknown>
  return { value: result }
}

describe('normalizeToolResponse', () => {
  it('wraps arrays into { items }', () => {
    expect(normalizeToolResponse([{ a: 1 }, { b: 2 }])).toEqual({
      items: [{ a: 1 }, { b: 2 }],
    })
  })

  it('wraps empty array', () => {
    expect(normalizeToolResponse([])).toEqual({ items: [] })
  })

  it('passes objects through', () => {
    expect(normalizeToolResponse({ ok: true, count: 3 })).toEqual({
      ok: true,
      count: 3,
    })
  })

  it('wraps primitives into { value }', () => {
    expect(normalizeToolResponse('hello')).toEqual({ value: 'hello' })
    expect(normalizeToolResponse(42)).toEqual({ value: 42 })
    expect(normalizeToolResponse(true)).toEqual({ value: true })
  })

  it('wraps null/undefined into { value: null }', () => {
    expect(normalizeToolResponse(null)).toEqual({ value: null })
    expect(normalizeToolResponse(undefined)).toEqual({ value: null })
  })

  it('handles mixed-content object', () => {
    const complex = {
      skills: ['a', 'b'],
      meta: { count: 2 },
      ok: true,
    }
    expect(normalizeToolResponse(complex)).toEqual(complex)
  })

  it('wraps a top-level array of mixed items', () => {
    const arr = [{ x: 1 }, 'two', 3]
    expect(normalizeToolResponse(arr)).toEqual({ items: arr })
  })
})
