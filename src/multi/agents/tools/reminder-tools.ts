import { z } from 'zod'
import type { RemindersRepo } from '../../reminders/repo.js'
import type { MemoryTool } from './memory-tools.js'

export interface ReminderToolsDeps {
  remindersRepo: RemindersRepo
  workspaceId: string
  currentChannel: 'telegram' | 'max' | 'desktop'
}

/**
 * Parse a fire_at value that could be:
 *  - ISO 8601 timestamp ("2026-04-07T12:30:00Z")
 *  - relative offset ("+1m", "+30s", "+2h", "+3d")
 *  - relative offset with words ("in 1 minute", "через 5 минут")
 *  - shorthand seconds ("60s") / minutes ("5m") / hours ("2h") / days ("3d")
 *
 * Returns Date or null if unparseable.
 */
export function parseFireAt(input: string, now: Date = new Date()): Date | null {
  if (!input) return null
  const trimmed = input.trim()

  // Try ISO first
  const iso = new Date(trimmed)
  if (!isNaN(iso.getTime()) && /\d{4}-\d{2}-\d{2}/.test(trimmed)) return iso

  // Pure shorthand: "60s" "5m" "2h" "3d"
  const shorthand = trimmed.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?|секунд?|сек|минут?|мин|час[аов]?|дн[ейя]?|сут[оки]?)$/i)
  if (shorthand) {
    const n = parseInt(shorthand[1], 10)
    const unit = shorthand[2].toLowerCase()
    const ms = unitToMs(unit, n)
    if (ms !== null) return new Date(now.getTime() + ms)
  }

  // Plus offset: "+1m" "+30s"
  const plus = trimmed.match(/^\+\s*(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)?$/i)
  if (plus) {
    const n = parseInt(plus[1], 10)
    const unit = (plus[2] ?? 'm').toLowerCase()
    const ms = unitToMs(unit, n)
    if (ms !== null) return new Date(now.getTime() + ms)
  }

  // "in 5 minutes" / "через 5 минут"
  const phrase = trimmed.match(/^(?:in|через)\s+(\d+)\s+(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?|секунд?|сек|минут?|мин|час[аов]?|дн[ейя]?|сут[оки]?)/i)
  if (phrase) {
    const n = parseInt(phrase[1], 10)
    const unit = phrase[2].toLowerCase()
    const ms = unitToMs(unit, n)
    if (ms !== null) return new Date(now.getTime() + ms)
  }

  // "сегодня в HH:MM" / "завтра в HH:MM" / "today at HH:MM" / "tomorrow at HH:MM"
  // Interprets HH:MM in the user's local timezone (default Europe/Moscow = UTC+3
  // unless BC_USER_TZ_OFFSET_HOURS overrides). Returns a UTC Date.
  const dayPhrase = trimmed.match(
    /^(сегодня|завтра|послезавтра|today|tomorrow)\s+(?:в|at)\s+(\d{1,2})[:.](\d{2})/i,
  )
  if (dayPhrase) {
    const dayWord = dayPhrase[1].toLowerCase()
    const hh = parseInt(dayPhrase[2], 10)
    const mm = parseInt(dayPhrase[3], 10)
    if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) {
      const tzOffsetHours = Number(process.env.BC_USER_TZ_OFFSET_HOURS ?? '3')
      const dayDelta =
        dayWord === 'сегодня' || dayWord === 'today'
          ? 0
          : dayWord === 'послезавтра'
            ? 2
            : 1
      // Shift `now` into user wall clock, advance day, then back to UTC.
      const userNow = new Date(now.getTime() + tzOffsetHours * 60 * 60 * 1000)
      const target = new Date(
        Date.UTC(
          userNow.getUTCFullYear(),
          userNow.getUTCMonth(),
          userNow.getUTCDate() + dayDelta,
          hh,
          mm,
          0,
          0,
        ),
      )
      return new Date(target.getTime() - tzOffsetHours * 60 * 60 * 1000)
    }
  }

  return null
}

function unitToMs(unit: string, n: number): number | null {
  if (/^(s|sec|seconds?|секунд?|сек)$/i.test(unit)) return n * 1000
  if (/^(m|min|minutes?|минут?|мин)$/i.test(unit)) return n * 60 * 1000
  if (/^(h|hr|hours?|час[аов]?)$/i.test(unit)) return n * 60 * 60 * 1000
  if (/^(d|days?|дн[ейя]?|сут[оки]?)$/i.test(unit)) return n * 24 * 60 * 60 * 1000
  return null
}

export function createReminderTools(deps: ReminderToolsDeps): MemoryTool[] {
  const { remindersRepo, workspaceId, currentChannel } = deps

  const setParams = z.object({
    fire_at: z.string().describe(
      'When to fire. Accepted formats: ISO 8601 ("2026-04-07T15:30:00Z"), ' +
        'relative shorthand ("60s", "5m", "2h", "3d"), ' +
        'plus offset ("+1m", "+30s"), or phrase ("in 5 minutes", "через 5 минут"). ' +
        'Always prefer the simplest format ("60s" for one minute, "1h" for one hour).',
    ),
    text: z.string().min(1).max(500).describe('Reminder text the user will see'),
  })
  const setReminder: MemoryTool = {
    name: 'set_reminder',
    description:
      'Поставить напоминание. Параметр fire_at принимает: ISO 8601 timestamp; относительное смещение "1m"/"60s"/"2h"/"3d"/"+5m"; "in 10 minutes" / "через 10 минут"; "завтра в 10:30" / "сегодня в 18:00" / "послезавтра в 9:00" (часовой пояс пользователя — Europe/Moscow по умолчанию). Напоминание придёт в текущий канал.',
    parameters: setParams,
    async execute(params) {
      const parsed = setParams.parse(params)
      const fireAt = parseFireAt(parsed.fire_at)
      if (!fireAt || isNaN(fireAt.getTime())) {
        return {
          success: false,
          error: `Invalid fire_at format: "${parsed.fire_at}". Use ISO 8601 or relative like "60s", "5m", "1h", "2d".`,
        }
      }
      if (fireAt.getTime() <= Date.now()) {
        return {
          success: false,
          error: 'fire_at is in the past — reminders must be in the future',
        }
      }
      try {
        const r = await remindersRepo.create(workspaceId, {
          fireAt,
          text: parsed.text,
          preferredChannel: currentChannel,
        })
        return {
          success: true,
          id: r.id,
          fire_at: fireAt.toISOString(),
          text: parsed.text,
        }
      } catch (e) {
        return {
          success: false,
          error: `Failed to create reminder: ${(e as Error).message}`,
        }
      }
    },
  }

  const listParams = z.object({})
  const listReminders: MemoryTool = {
    name: 'list_reminders',
    description: 'Показать все ожидающие напоминания юзера.',
    parameters: listParams,
    async execute() {
      const list = await remindersRepo.listPending(workspaceId)
      return {
        reminders: list.map((r) => ({
          id: r.id,
          fire_at: r.fireAt.toISOString(),
          text: r.text,
          channel: r.preferredChannel,
        })),
      }
    },
  }

  const cancelParams = z.object({
    id: z.string().uuid(),
  })
  const cancelReminder: MemoryTool = {
    name: 'cancel_reminder',
    description: 'Отменить напоминание по id.',
    parameters: cancelParams,
    async execute(params) {
      const parsed = cancelParams.parse(params)
      await remindersRepo.cancel(workspaceId, parsed.id)
      return { success: true }
    },
  }

  return [setReminder, listReminders, cancelReminder]
}
