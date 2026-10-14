import { serve } from '@hono/node-server';
import { createApp } from './app';
import { config } from './config';
import { migrate } from './db/migrations';
import { closePostgres } from './db/postgres';
import { ensureCollection } from './db/typesense';
import { logger } from './logger';
import { pruneRateLimits } from './middleware/rate-limit';
import { flushTracing } from './services/tracing';

const RATE_LIMIT_PRUNE_INTERVAL_MS = 5 * 60_000;

async function main(): Promise<void> {
  // Postgres is the source of truth: refuse to start without an up-to-date schema.
  await migrate();
  // Typesense is a derived index: start degraded (vector-only search) if it is unavailable
  await ensureCollection().catch((err: unknown) => {
    logger.error({ err }, 'typesense collection setup failed; keyword search will be unavailable');
  });

  const server = serve({ fetch: createApp().fetch, port: config.PORT }, (info) => {
    logger.info({ port: info.port, env: config.NODE_ENV }, 'chatbot-ai listening');
  });

  const pruneTimer = setInterval(() => {
    pruneRateLimits().catch((err: unknown) => {
      logger.warn({ err }, 'rate limit prune failed');
    });
  }, RATE_LIMIT_PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(pruneTimer);
    // Force-exit if open SSE streams don't drain in time
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => {
      void Promise.allSettled([closePostgres(), flushTracing()]).then(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
