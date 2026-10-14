import { Hono } from 'hono';
import { z } from 'zod';
import { isSupportedFile, SUPPORTED_EXTENSIONS } from '../ingestion/pipeline';
import { getJob, JobConflictError, latestJob, startIngestJob } from '../services/ingest-jobs';
import { getPortal } from '../services/portals';
import type { AppEnv } from '../types';
import { validationError } from './validation';

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Upload paths are only used to derive slugs (nothing is written to disk), but they are still held
 * to a strict shape: relative, forward slashes, no traversal segments, no control characters.
 */
const SourcePath = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && !/^[a-zA-Z]:/.test(p), 'path must be relative and use "/"')
  .refine((p) => p.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'invalid path segment')
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  .refine((p) => !/[\u0000-\u001f\u007f]/.test(p), 'path contains control characters')
  .refine(isSupportedFile, `unsupported file type (allowed: ${SUPPORTED_EXTENSIONS.join(', ')})`);

export const IngestRequestSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: SourcePath,
            content: z.string().max(MAX_FILE_BYTES, `file content exceeds ${MAX_FILE_BYTES} bytes`),
            lastModified: z.iso.datetime({ offset: true }).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_FILES),
    /** Re-chunk pages even if unchanged (embeddings for identical chunks are still reused) */
    force: z.boolean().default(false),
    /** The upload is the complete portal: pages missing from it are removed. Default for CI sync. */
    prune: z.boolean().default(true),
  })
  .strict()
  .refine((body) => new Set(body.files.map((f) => f.path)).size === body.files.length, {
    message: 'duplicate file paths',
    path: ['files'],
  });

const JobIdParam = z.string().regex(/^job_[0-9a-f-]{36}$/);

/** Mounted at /v1/portals/:portalId/ingest behind requireIngestAccess. */
export const ingestRoutes = new Hono<AppEnv>();

ingestRoutes.post('/', async (c) => {
  const portalId = c.req.param('portalId') ?? '';
  const portal = await getPortal(portalId);
  if (!portal) return c.json({ error: 'not_found' }, 404);
  if (portal.status !== 'active') return c.json({ error: 'portal_disabled' }, 409);

  const body: unknown = await c.req.json().catch(() => undefined);
  const parsed = IngestRequestSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error);

  const files = parsed.data.files.map((f) => ({
    path: f.path,
    content: f.content,
    lastModified: f.lastModified ? new Date(f.lastModified) : undefined,
  }));

  try {
    const job = await startIngestJob(portal, files, { force: parsed.data.force, prune: parsed.data.prune });
    c.header('Location', `/v1/portals/${portal.id}/ingest/jobs/${job.id}`);
    return c.json({ job }, 202);
  } catch (err) {
    if (err instanceof JobConflictError) return c.json({ error: 'ingestion_in_progress', job: err.running }, 409);
    throw err;
  }
});

ingestRoutes.get('/jobs/latest', async (c) => {
  const job = await latestJob(c.req.param('portalId') ?? '');
  return job ? c.json({ job }) : c.json({ error: 'not_found' }, 404);
});

ingestRoutes.get('/jobs/:jobId', async (c) => {
  const jobId = JobIdParam.safeParse(c.req.param('jobId'));
  if (!jobId.success) return c.json({ error: 'not_found' }, 404);
  const job = await getJob(c.req.param('portalId') ?? '', jobId.data);
  return job ? c.json({ job }) : c.json({ error: 'not_found' }, 404);
});
