import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { config } from './config';
import { pingPostgres } from './db/postgres';
import { pingTypesense } from './db/typesense';
import { logger } from './logger';
import { clientIp, requireAdmin, requireIngestAccess, requirePortal } from './middleware/auth';
import { rateLimit } from './middleware/rate-limit';
import { chatRoutes } from './routes/chat';
import { ingestRoutes } from './routes/ingest';
import { portalRoutes } from './routes/portals';
import { allAllowedOrigins } from './services/portals';
import type { AppEnv } from './types';

const KB = 1024;
const MINUTE = 60_000;

const limitBody = (maxSize: number) =>
  bodyLimit({ maxSize, onError: (c) => c.json({ error: 'payload_too_large' }, 413) });

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requestId());
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    logger.info(
      {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round(performance.now() - started),
      },
      'request',
    );
  });
  app.use(
    '*',
    secureHeaders({
      // API-only service: nothing should ever be rendered or framed
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      crossOriginResourcePolicy: 'cross-origin',
    }),
  );

  app.get('/health', async (c) => {
    const [postgres, typesense] = await Promise.all([pingPostgres(), pingTypesense()]);
    const ok = postgres && typesense;
    return c.json({ status: ok ? 'ok' : 'degraded', postgres, typesense }, ok ? 200 : 503);
  });

  // ---- Public chat API (browser, portal public key) ----------------------------------------
  // Preflights carry no X-Portal-Key, so CORS allows any origin registered by an active portal;
  // requirePortal then checks the origin against the specific portal on the real request.
  app.use(
    '/v1/chat/*',
    cors({
      origin: async (origin) => ((await allAllowedOrigins()).has(origin) ? origin : null),
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-Portal-Key'],
      exposeHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use('/v1/chat/*', limitBody(32 * KB), requirePortal);
  app.use(
    '/v1/chat/*',
    rateLimit({
      name: 'portal-ip',
      windowMs: MINUTE,
      limit: () => config.RATE_LIMIT_PER_IP_PER_MINUTE,
      key: (c) => `${c.get('portal').id}:${clientIp(c)}`,
    }),
    rateLimit({
      name: 'portal',
      windowMs: MINUTE,
      limit: (c) => c.get('portal').rateLimitPerMinute ?? config.DEFAULT_PORTAL_RATE_LIMIT_PER_MINUTE,
      key: (c) => c.get('portal').id,
    }),
  );
  app.route('/v1/chat', chatRoutes);

  // ---- Ingest API (CI / CLI, portal ingest key or admin key) -------------------------------
  app.use(
    '/v1/portals/:portalId/ingest/*',
    limitBody(config.INGEST_MAX_BODY_MB * KB * KB),
    rateLimit({ name: 'ingest', windowMs: MINUTE, limit: () => 30, key: (c) => c.req.param('portalId') }),
    requireIngestAccess,
  );
  app.route('/v1/portals/:portalId/ingest', ingestRoutes);

  // ---- Admin API (server-to-server only; no CORS) ------------------------------------------
  app.use(
    '/v1/admin/*',
    limitBody(64 * KB),
    rateLimit({ name: 'admin', windowMs: MINUTE, limit: () => 120, key: (c) => clientIp(c) }),
    requireAdmin,
  );
  app.route('/v1/admin/portals', portalRoutes);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  // Never leak internals: log the error (safely serialized), return a generic message with the request id
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message || 'http_error' }, err.status);
    }
    logger.error({ err, requestId: c.get('requestId'), path: c.req.path }, 'unhandled error');
    return c.json({ error: 'internal_error', requestId: c.get('requestId') }, 500);
  });

  return app;
}
