const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface LimitVerdict {
  allowed: boolean;
  reason?: "per_hour" | "per_day_total";
  /** Minutes to wait before the next attempt makes sense. */
  retryAfterMin?: number;
}

/**
 * Counts requests per user and across the whole portal.
 *
 * The owner is exempt: his calls are neither blocked nor counted towards the
 * portal cap, so a busy day of his cannot lock the staff out.
 */
export class RateLimiter {
  private perUser = new Map<string, number[]>();
  private portal: number[] = [];

  constructor(
    private perHour: number,
    private perDayTotal: number,
    private now: () => number = () => Date.now(),
  ) {}

  check(userId: string, unlimited: boolean): LimitVerdict {
    if (unlimited) return { allowed: true };

    const t = this.now();

    this.portal = this.portal.filter((ts) => t - ts < DAY_MS);
    if (this.portal.length >= this.perDayTotal) {
      return { allowed: false, reason: "per_day_total", retryAfterMin: 60 };
    }

    const mine = (this.perUser.get(userId) ?? []).filter((ts) => t - ts < HOUR_MS);
    if (mine.length >= this.perHour) {
      const oldest = mine[0];
      const waitMs = HOUR_MS - (t - oldest);
      this.perUser.set(userId, mine);
      return {
        allowed: false,
        reason: "per_hour",
        retryAfterMin: Math.max(1, Math.ceil(waitMs / 60000)),
      };
    }

    mine.push(t);
    this.perUser.set(userId, mine);
    this.portal.push(t);
    return { allowed: true };
  }
}
