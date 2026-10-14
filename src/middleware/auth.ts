import { createHash, timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { config } from '../config';
import { findActivePortalByPublicKey, verifyIngestKey } from '../services/portals';
import type { AppEnv } from '../types';

/** Constant-time string comparison (hashing first makes lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function bearerToken(c: Context): string | undefined {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  return token || undefined;
}

function isAdminToken(token: string | undefined): boolean {
  return config.ADMIN_API_KEY !== undefined && token !== undefined && safeEqual(token, config.ADMIN_API_KEY);
}

/** Client IP for rate limiting. X-Forwarded-For is only trusted when TRUST_PROXY is on. */
export function clientIp(c: Context): string {
  if (config.TRUST_PROXY) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Requires `Authorization: Bearer <ADMIN_API_KEY>`. The admin API does not exist when no key is configured. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (config.ADMIN_API_KEY === undefined) return c.json({ error: 'not_found' }, 404);
  if (!isAdminToken(bearerToken(c))) return c.json({ error: 'unauthorized' }, 401);
  await next();
};

/** Ingest routes: the admin key, or the target portal's own ingest key (sk_live_…). */
export const requireIngestAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearerToken(c);
  const portalId = c.req.param('portalId');
  if (!token || !portalId) return c.json({ error: 'unauthorized' }, 401);
  if (!isAdminToken(token) && !(await verifyIngestKey(portalId, token))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

/**
 * Chat routes: resolve the tenant from the public portal key (`X-Portal-Key`) and, for browser
 * requests, require the Origin to be one the portal allows. The tenant is never taken from the body.
 */
export const requirePortal: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header('x-portal-key');
  const portal = key ? await findActivePortalByPublicKey(key) : null;
  if (!portal) return c.json({ error: 'unauthorized', message: 'Missing or invalid X-Portal-Key.' }, 401);

  // Browsers always send Origin on cross-origin POSTs. Non-browser clients can omit (or forge) it,
  // so this stops other websites embedding the key; it is not authentication. Rate limits cover abuse.
  const origin = c.req.header('origin');
  if (origin && !portal.allowedOrigins.includes(origin)) {
    return c.json({ error: 'forbidden', message: 'Origin not allowed for this portal.' }, 403);
  }
  c.set('portal', portal);
  await next();
};
