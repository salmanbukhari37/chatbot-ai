import type { PoolClient } from 'pg';
import { config } from '../config';
import { logger } from '../logger';
import { pool } from './postgres';

interface Migration {
  version: number;
  name: string;
  up: (client: PoolClient) => Promise<void>;
}

const DIMS = config.EMBEDDING_DIMENSIONS;

/**
 * Append-only list of schema migrations. Never edit a migration that has shipped;
 * add a new one instead. Each runs in its own transaction.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'multi_tenant_schema',
    up: async (client) => {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`
        CREATE TABLE portals (
          id                   TEXT PRIMARY KEY,
          name                 TEXT NOT NULL,
          tenant_id            TEXT NOT NULL,
          base_url             TEXT NOT NULL,
          allowed_origins      TEXT[] NOT NULL DEFAULT '{}',
          public_key_hash      TEXT NOT NULL UNIQUE,
          ingest_key_hash      TEXT NOT NULL UNIQUE,
          status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
          rate_limit_per_minute INTEGER CHECK (rate_limit_per_minute > 0),
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query('CREATE INDEX portals_tenant_idx ON portals (tenant_id)');

      await client.query(`
        CREATE TABLE documents (
          portal_id     TEXT NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
          slug          TEXT NOT NULL,
          section       TEXT NOT NULL,
          title         TEXT NOT NULL,
          description   TEXT NOT NULL DEFAULT '',
          url           TEXT NOT NULL,
          content       TEXT NOT NULL,
          content_hash  TEXT NOT NULL,
          source_path   TEXT NOT NULL,
          last_modified TIMESTAMPTZ NOT NULL,
          indexed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (portal_id, slug)
        )
      `);

      await client.query(`
        CREATE TABLE chunks (
          id            TEXT PRIMARY KEY,
          portal_id     TEXT NOT NULL,
          slug          TEXT NOT NULL,
          section       TEXT NOT NULL,
          chunk_index   INTEGER NOT NULL,
          title         TEXT NOT NULL,
          heading       TEXT NOT NULL,
          url           TEXT NOT NULL,
          content       TEXT NOT NULL,
          content_hash  TEXT NOT NULL,
          token_count   INTEGER NOT NULL,
          has_code      BOOLEAN NOT NULL DEFAULT false,
          last_modified TIMESTAMPTZ NOT NULL,
          embedding     vector(${DIMS}) NOT NULL,
          FOREIGN KEY (portal_id, slug) REFERENCES documents(portal_id, slug) ON DELETE CASCADE
        )
      `);
      await client.query('CREATE INDEX chunks_portal_slug_idx ON chunks (portal_id, slug)');
      // halfvec expression index: HNSW supports up to 4000 dims for halfvec (2000 for vector)
      await client.query(
        `CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw ((embedding::halfvec(${DIMS})) halfvec_cosine_ops)`,
      );

      await client.query(`
        CREATE TABLE ingest_jobs (
          id           TEXT PRIMARY KEY,
          portal_id    TEXT NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
          status       TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
          stats        JSONB,
          error        TEXT,
          started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at  TIMESTAMPTZ
        )
      `);
      // At most one running job per portal, enforced by the database (safe across instances)
      await client.query(
        "CREATE UNIQUE INDEX ingest_jobs_one_running_idx ON ingest_jobs (portal_id) WHERE status = 'running'",
      );
      await client.query('CREATE INDEX ingest_jobs_portal_started_idx ON ingest_jobs (portal_id, started_at DESC)');
    },
  },
  {
    version: 2,
    name: 'rate_limits',
    up: async (client) => {
      // Rate limit counters (previously in Redis). UNLOGGED skips the WAL: cheaper writes, and a crash only
      // resets the counters. No index on reset_at, so counter updates stay HOT; pruning scans a small table.
      await client.query(`
        CREATE UNLOGGED TABLE rate_limits (
          key      TEXT PRIMARY KEY,
          count    INTEGER NOT NULL,
          reset_at TIMESTAMPTZ NOT NULL
        )
      `);
    },
  },
];

const MIGRATION_LOCK_ID = 727274;

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    // Session-level lock: serialises concurrent boots (several replicas, server + CLI)
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ version: number }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          migration.version,
          migration.name,
        ]);
        await client.query('COMMIT');
        logger.info({ version: migration.version, name: migration.name }, 'applied migration');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
