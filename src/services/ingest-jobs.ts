import { randomUUID } from 'node:crypto';
import type { DatabaseError } from 'pg';
import { pool } from '../db/postgres';
import { ingestPortal, type IngestStats, type SourceFile } from '../ingestion/pipeline';
import { logger } from '../logger';
import type { Portal } from '../types';

export type JobStatus = 'running' | 'succeeded' | 'failed';

export interface IngestJob {
  id: string;
  portalId: string;
  status: JobStatus;
  stats: IngestStats | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

interface JobRow {
  id: string;
  portal_id: string;
  status: JobStatus;
  stats: IngestStats | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

const COLUMNS = 'id, portal_id, status, stats, error, started_at, finished_at';
/** A running job whose heartbeat is older than this is assumed dead (instance crashed or restarted). */
const STALE_AFTER_SECONDS = 120;
const HEARTBEAT_INTERVAL_MS = 15_000;

function toJob(row: JobRow): IngestJob {
  return {
    id: row.id,
    portalId: row.portal_id,
    status: row.status,
    stats: row.stats,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class JobConflictError extends Error {
  constructor(readonly running: IngestJob) {
    super('An ingest job is already running for this portal');
  }
}

/**
 * Start an ingest job in the background and return it immediately.
 * The database's partial unique index guarantees a single running job per portal,
 * even with several API instances.
 */
export async function startIngestJob(
  portal: Portal,
  files: SourceFile[],
  options: { force: boolean; prune: boolean },
): Promise<IngestJob> {
  // Reap jobs abandoned by a crashed instance so they don't block the portal forever
  await pool.query(
    `UPDATE ingest_jobs SET status = 'failed', error = 'Interrupted (no heartbeat)', finished_at = now()
      WHERE portal_id = $1 AND status = 'running' AND heartbeat_at < now() - make_interval(secs => $2)`,
    [portal.id, STALE_AFTER_SECONDS],
  );

  let job: IngestJob;
  try {
    const { rows } = await pool.query<JobRow>(
      `INSERT INTO ingest_jobs (id, portal_id, status) VALUES ($1, $2, 'running') RETURNING ${COLUMNS}`,
      [`job_${randomUUID()}`, portal.id],
    );
    if (!rows[0]) throw new Error('Job insert returned no row');
    job = toJob(rows[0]);
  } catch (err) {
    if ((err as DatabaseError).code === '23505') {
      const running = await latestJob(portal.id);
      if (running) throw new JobConflictError(running);
    }
    throw err;
  }

  const log = logger.child({ jobId: job.id, portalId: portal.id, component: 'ingest' });
  let lastBeat = Date.now();
  const heartbeat = async () => {
    if (Date.now() - lastBeat < HEARTBEAT_INTERVAL_MS) return;
    lastBeat = Date.now();
    await pool.query('UPDATE ingest_jobs SET heartbeat_at = now() WHERE id = $1', [job.id]);
  };

  void ingestPortal(portal, files, {
    ...options,
    log: (message) => {
      log.info(message);
    },
    onProgress: heartbeat,
  })
    .then((stats) =>
      pool.query(`UPDATE ingest_jobs SET status = $2, stats = $3, error = $4, finished_at = now() WHERE id = $1`, [
        job.id,
        stats.errors.length === 0 ? 'succeeded' : 'failed',
        JSON.stringify(stats),
        stats.errors.length === 0 ? null : `${stats.errors.length} file(s) failed to index`,
      ]),
    )
    .catch(async (err: unknown) => {
      log.error({ err }, 'ingest job failed');
      await pool
        .query(`UPDATE ingest_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [
          job.id,
          'Internal error during ingestion',
        ])
        .catch((updateErr: unknown) => {
          log.error({ err: updateErr }, 'could not record job failure');
        });
    });

  return job;
}

export async function getJob(portalId: string, jobId: string): Promise<IngestJob | null> {
  const { rows } = await pool.query<JobRow>(`SELECT ${COLUMNS} FROM ingest_jobs WHERE portal_id = $1 AND id = $2`, [
    portalId,
    jobId,
  ]);
  return rows[0] ? toJob(rows[0]) : null;
}

export async function latestJob(portalId: string): Promise<IngestJob | null> {
  const { rows } = await pool.query<JobRow>(
    `SELECT ${COLUMNS} FROM ingest_jobs WHERE portal_id = $1 ORDER BY started_at DESC LIMIT 1`,
    [portalId],
  );
  return rows[0] ? toJob(rows[0]) : null;
}
