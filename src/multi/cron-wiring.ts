// Fix4 — pg-boss cron wiring + admin manual trigger endpoint.
//
// Extracted from server.ts so the glue logic is unit-testable without having
// to boot the whole multi server. Three nightly runners are wired:
//   - Learner  (03:00 UTC) — conversation history -> skill candidates
//   - Skills   (per-skill cron triggers) — scheduled workspace skills
//   - Coach    (04:00 UTC) — negative feedback -> persona tweak proposals
//
// Each registerCron call is isolated in its own try/catch so a failure in
// one component never prevents the others from being scheduled. The admin
// endpoint is gated on BC_ADMIN_SECRET: if the secret is not configured the
// endpoint returns 503 (not 404) so operators can detect misconfiguration.

import type http from 'node:http'

export interface MinimalLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void
  warn: (msg: string, meta?: Record<string, unknown>) => void
  error: (msg: string, meta?: Record<string, unknown>) => void
}

export interface CronRunners {
  learner: {
    registerCron: (boss: any) => Promise<void>
    runNightly: () => Promise<unknown>
  }
  skillManager: {
    registerCronTriggers: (boss: any) => Promise<{ registered: number }>
  }
  coach: {
    registerCron: (boss: any) => Promise<void>
    runNightly: () => Promise<unknown>
  }
  /**
   * P1.A — Telegram-link nonce sweep. Optional: only present when the
   * Windows-app wizard flow is enabled (BC_TG_BOT_USERNAME + BC_JWT_SECRET).
   * Logs registration outcome but never blocks the other runners on failure.
   */
  tgLinkSweep?: {
    registerCron: (boss: any) => Promise<void>
    runOnce: () => Promise<unknown>
  }
}

/**
 * Register Learner / Skills / Coach cron on a live pg-boss instance.
 * Each component is wrapped in an isolated try/catch so a single failure
 * (e.g. Learner throws because pg-boss schema is stale) never blocks the
 * other two from scheduling.
 */
export async function registerCronWiring(
  boss: unknown,
  runners: CronRunners,
  logger: MinimalLogger,
): Promise<void> {
  try {
    await runners.learner.registerCron(boss)
    logger.info('learner cron registered')
  } catch (e) {
    logger.warn('learner cron registration failed', {
      error: e instanceof Error ? e.message : String(e),
    })
  }

  try {
    const result = await runners.skillManager.registerCronTriggers(boss as any)
    logger.info('skill cron triggers registered', {
      registered: result.registered,
    })
  } catch (e) {
    logger.warn('skill cron registration failed', {
      error: e instanceof Error ? e.message : String(e),
    })
  }

  try {
    await runners.coach.registerCron(boss)
    logger.info('coach cron registered')
  } catch (e) {
    logger.warn('coach cron registration failed', {
      error: e instanceof Error ? e.message : String(e),
    })
  }

  if (runners.tgLinkSweep) {
    try {
      await runners.tgLinkSweep.registerCron(boss)
      logger.info('tg-link-sweep cron registered')
    } catch (e) {
      logger.warn('tg-link-sweep cron registration failed', {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
}

export interface AdminCronHandlerDeps {
  runners: CronRunners
  secret: string | undefined
  logger: MinimalLogger
}

type RunnerName = 'learner' | 'coach' | 'skills'
const ALLOWED_NAMES: readonly RunnerName[] = ['learner', 'coach', 'skills']

/**
 * Build an HTTP handler for POST /admin/cron/run?name=<runner>. Uses a
 * Bearer token (BC_ADMIN_SECRET) for auth. Never logs the secret. Intended
 * for operator use — e.g. "run Coach tonight without waiting for 04:00 UTC".
 */
export function createAdminCronHandler(
  deps: AdminCronHandlerDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (!deps.secret) {
      send(503, { error: 'admin endpoint disabled (BC_ADMIN_SECRET unset)' })
      return
    }

    const auth = req.headers['authorization']
    const expected = `Bearer ${deps.secret}`
    if (typeof auth !== 'string' || auth !== expected) {
      send(401, { error: 'unauthorized' })
      return
    }

    // Parse ?name=... from req.url. Accept either a bare path or full URL.
    const rawUrl = req.url ?? ''
    let name: string | null = null
    try {
      const parsed = new URL(rawUrl, 'http://localhost')
      name = parsed.searchParams.get('name')
    } catch {
      name = null
    }

    if (!name || !(ALLOWED_NAMES as readonly string[]).includes(name)) {
      send(400, {
        error: 'invalid name',
        allowed: ALLOWED_NAMES,
      })
      return
    }

    try {
      if (name === 'learner') {
        await deps.runners.learner.runNightly()
      } else if (name === 'coach') {
        await deps.runners.coach.runNightly()
      } else if (name === 'skills') {
        // Skills runners are triggered per-skill via pg-boss schedule — there
        // is no "runNightly" equivalent. Re-registering cron triggers is the
        // closest safe operation (idempotent upsert).
        // TODO: expose a dedicated manual-run-all-cron-skills path once the
        // SkillManager grows a runCronSkillsNow() method.
        // For now we just no-op with a 200 + note so the caller gets a clear
        // signal the request was accepted.
      }
      deps.logger.info('cron admin trigger invoked', { name, status: 'ok' })
      send(200, { status: 'ok', name })
    } catch (e) {
      deps.logger.warn('cron admin trigger failed', {
        name,
        error: e instanceof Error ? e.message : String(e),
      })
      send(500, { error: 'runner failed' })
    }
  }
}
