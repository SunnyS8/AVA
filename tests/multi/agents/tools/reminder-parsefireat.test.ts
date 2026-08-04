import { describe, it, expect } from 'vitest'
import { parseFireAt } from '../../../../src/multi/agents/tools/reminder-tools.js'

describe('parseFireAt', () => {
  const now = new Date('2026-04-07T12:00:00.000Z') // 15:00 MSK

  it('parses ISO 8601', () => {
    const d = parseFireAt('2026-04-08T10:30:00Z', now)
    expect(d?.toISOString()).toBe('2026-04-08T10:30:00.000Z')
  })

  it('parses shorthand "5m"', () => {
    const d = parseFireAt('5m', now)
    expect(d?.toISOString()).toBe('2026-04-07T12:05:00.000Z')
  })

  it('parses "+30s"', () => {
    const d = parseFireAt('+30s', now)
    expect(d?.toISOString()).toBe('2026-04-07T12:00:30.000Z')
  })

  it('parses "in 10 minutes"', () => {
    const d = parseFireAt('in 10 minutes', now)
    expect(d?.toISOString()).toBe('2026-04-07T12:10:00.000Z')
  })

  it('parses "через 1 час"', () => {
    const d = parseFireAt('через 1 час', now)
    expect(d?.toISOString()).toBe('2026-04-07T13:00:00.000Z')
  })

  it('parses "сегодня в 18:00" (Moscow tz default = UTC+3 → 15:00 UTC)', () => {
    // now in Moscow = 2026-04-07 15:00. Today 18:00 MSK = 15:00 UTC.
    const d = parseFireAt('сегодня в 18:00', now)
    expect(d?.toISOString()).toBe('2026-04-07T15:00:00.000Z')
  })

  it('parses "завтра в 10:30" (Moscow tz default → 07:30 UTC next day)', () => {
    // 2026-04-08 10:30 MSK = 2026-04-08 07:30 UTC.
    const d = parseFireAt('завтра в 10:30', now)
    expect(d?.toISOString()).toBe('2026-04-08T07:30:00.000Z')
  })

  it('parses "tomorrow at 09:00"', () => {
    const d = parseFireAt('tomorrow at 09:00', now)
    expect(d?.toISOString()).toBe('2026-04-08T06:00:00.000Z')
  })

  it('parses "послезавтра в 14:00"', () => {
    const d = parseFireAt('послезавтра в 14:00', now)
    expect(d?.toISOString()).toBe('2026-04-09T11:00:00.000Z')
  })

  it('returns null for unparseable garbage', () => {
    expect(parseFireAt('asdfgh', now)).toBeNull()
    expect(parseFireAt('', now)).toBeNull()
  })

  it('rejects out-of-range hours/minutes', () => {
    expect(parseFireAt('завтра в 25:00', now)).toBeNull()
    expect(parseFireAt('сегодня в 10:99', now)).toBeNull()
  })
})
