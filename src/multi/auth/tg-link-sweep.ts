/**
 * P1.A — pg-boss cron runner that sweeps expired Telegram-link nonces every
 * 15 minutes. Single queue, single periodic schedule. Idempotent.
 *
 * The sweep is best-effort: a failed run logs a warning and the next tick
 * will pick up whatever it missed. Failure does not propagate to other cron
 * tasks (see registerCronWiring's per-runner try/catch).
 */
import type { TgLinkRepo } from './tg-link-repo.js'

const QUEUE_NAME = 'tg-link-sweep'
const SCHEDULE_CRON = '*/15 * * * *' // every 15 minutes

export interface TgLinkSweepRunnerDeps {
  repo: TgLinkRepo
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void
    warn: (msg: string, meta?: Record<string, unknown>) => void
  }
}

export class TgLinkSweepRunner {
  constructor(private deps: TgLinkSweepRunnerDeps) {}

  /** Run the sweep once. Returns number of nonce rows deleted. */
  async runOnce(): Promise<{ deleted: number }> {
    try {
      const deleted = await this.deps.repo.sweepExpired()
      this.deps.logger?.info('tg-link-sweep ran', { deleted })
      return { deleted }
    } catch (e) {
      this.deps.logger?.warn('tg-link-sweep failed', {
        error: e instanceof Error ? e.message : String(e),
      })
      return { deleted: 0 }
    }
  }

  /**
   * Register the queue + worker + 15-minute schedule on a live pg-boss
   * instance. Idempotent — schedule/createQueue/work are upserts on pg-boss
   * versions we run.
   */
  async registerCron(boss: any): Promise<void> {
    if (!boss) throw new Error('boss required')
    if (typeof boss.createQueue === 'function') {
      try {
        await boss.createQueue(QUEUE_NAME)
      } catch {
        // pg-boss v10+: createQueue throws on existing queue, that's fine.
      }
    }
    await boss.work(QUEUE_NAME, async () => {
      await this.runOnce()
    })
    await boss.schedule(QUEUE_NAME, SCHEDULE_CRON)
  }
}
