import type { Context, MiddlewareHandler } from 'hono';
import { pool } from '../db/postgres';
import { logger } from '../logger';
import type { AppEnv } from '../types';

/** Records one hit for `key` in the window ending at `resetAt` and returns the window's hit count. */
export type HitCounter = (key: string, resetAt: Date) => Promise<number>;

export interface RateLimitOptions {
  /** Namespaces the counter, e.g. "ip" or "portal" */
  name: string;
  windowMs: number;
  limit: (c: Context<AppEnv>) => number;
  /** Bucket identity; return undefined to skip limiting this request */
  key: (c: Context<AppEnv>) => string | undefined;
  /** Defaults to the shared Postgres counter */
  counter?: HitCounter;
}

/**
 * One row per limiter + identity, reset in place when a newer window arrives, so the table holds one row per
 * active client rather than one per client per minute. GREATEST keeps a lagging instance clock from reopening
 * an older window; its hits simply count towards the current one.
 */
export const countHit: HitCounter = async (key, resetAt) => {
  const { rows } = await pool.query<{ count: number }>(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET
       count    = CASE WHEN rate_limits.reset_at < EXCLUDED.reset_at THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = GREATEST(rate_limits.reset_at, EXCLUDED.reset_at)
     RETURNING count`,
    [key, resetAt],
  );
  const [row] = rows;
  if (!row) throw new Error('rate limit upsert returned no row');
  return row.count;
};

/**
 * Delete counters whose window ended a while ago. The margin absorbs clock skew between instances and the
 * database; a stale row is harmless anyway, because the next hit resets it. Safe to run from every instance.
 */
export async function pruneRateLimits(): Promise<number> {
  const { rowCount } = await pool.query("DELETE FROM rate_limits WHERE reset_at < now() - interval '10 minutes'");
  return rowCount ?? 0;
}

/**
 * Fixed-window rate limiter backed by Postgres, so limits hold across all API instances.
 * Fails open: if the counter can't be updated the request is allowed and the failure is logged, because
 * turning a counter error into a 500 for every caller is worse than briefly unlimited traffic.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const counter = options.counter ?? countHit;
  return async (c, next) => {
    const key = options.key(c);
    if (key === undefined) {
      await next();
      return;
    }
    const limit = options.limit(c);
    const window = Math.floor(Date.now() / options.windowMs);
    const resetAt = new Date((window + 1) * options.windowMs);

    let count: number;
    try {
      count = await counter(`${options.name}:${key}`, resetAt);
    } catch (err) {
      logger.warn({ err, limiter: options.name }, 'rate limiter unavailable, allowing request');
      await next();
      return;
    }

    const resetSeconds = Math.ceil((resetAt.getTime() - Date.now()) / 1000);
    c.header('RateLimit-Policy', `${limit};w=${Math.round(options.windowMs / 1000)}`);
    c.header('RateLimit', `limit=${limit}, remaining=${Math.max(0, limit - count)}, reset=${resetSeconds}`);
    if (count > limit) {
      c.header('Retry-After', String(resetSeconds));
      return c.json({ error: 'rate_limited', message: 'Too many requests, please slow down.' }, 429);
    }
    await next();
  };
}
