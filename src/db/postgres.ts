import { Pool, type PoolClient } from 'pg';
import { config } from '../config';
import { logger } from '../logger';

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'postgres idle client error');
});

const DIMS = config.EMBEDDING_DIMENSIONS;

/**
 * pgvector's HNSW index supports up to 2000 dims for `vector` but 4000 for `halfvec`,
 * so the 3072-d text-embedding-3-large vectors are stored at full precision and indexed
 * (and queried) through a halfvec expression. Must match the index in migrations.ts.
 */
export const HALFVEC_EXPR = `(embedding::halfvec(${DIMS}))`;

/** Serialise an embedding to pgvector's text format: "[0.1,0.2,...]" */
export function toVectorParam(embedding: number[]): string {
  if (embedding.length !== DIMS) {
    throw new Error(`Expected a ${DIMS}-d embedding, got ${embedding.length}`);
  }
  return `[${embedding.join(',')}]`;
}

/** Run `fn` inside a transaction, rolling back on any error. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function pingPostgres(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePostgres(): Promise<void> {
  await pool.end();
}
