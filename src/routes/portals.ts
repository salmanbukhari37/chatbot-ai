import { Hono } from 'hono';
import { z } from 'zod';
import {
  createPortal,
  deletePortal,
  getPortal,
  listPortals,
  normaliseOrigin,
  rotateCredentials,
  updatePortal,
} from '../services/portals';
import type { AppEnv } from '../types';
import { validationError } from './validation';

const Origin = z.string().refine((value) => {
  try {
    normaliseOrigin(value);
    return true;
  } catch {
    return false;
  }
}, 'must be an http(s) origin, e.g. https://docs.example.com');

const BaseUrl = z.url({ protocol: /^https?$/ }).max(2048);

const CreatePortalSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    tenantId: z.string().trim().min(1).max(200),
    /** Public URL the portal is deployed at (apimatic.json portal.site.url); used for citation links */
    baseUrl: BaseUrl,
    allowedOrigins: z.array(Origin).max(50).optional(),
    rateLimitPerMinute: z.number().int().positive().max(100_000).nullish(),
  })
  .strict();

const UpdatePortalSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    baseUrl: BaseUrl.optional(),
    allowedOrigins: z.array(Origin).max(50).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    rateLimitPerMinute: z.number().int().positive().max(100_000).nullable().optional(),
  })
  .strict();

const PortalIdParam = z.string().regex(/^prt_[0-9a-f]{20}$/);

/** Admin-only portal management. Mounted at /v1/admin/portals behind requireAdmin. */
export const portalRoutes = new Hono<AppEnv>();

portalRoutes.post('/', async (c) => {
  const parsed = CreatePortalSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return validationError(c, parsed.error);
  const { portal, credentials } = await createPortal(parsed.data);
  // Raw keys are only ever returned here and on rotation
  return c.json({ portal, credentials }, 201);
});

portalRoutes.get('/', async (c) => {
  const tenantId = c.req.query('tenantId');
  return c.json({ portals: await listPortals(tenantId ? { tenantId } : {}) });
});

portalRoutes.get('/:portalId', async (c) => {
  const id = PortalIdParam.safeParse(c.req.param('portalId'));
  const portal = id.success ? await getPortal(id.data) : null;
  return portal ? c.json({ portal }) : c.json({ error: 'not_found' }, 404);
});

portalRoutes.patch('/:portalId', async (c) => {
  const id = PortalIdParam.safeParse(c.req.param('portalId'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);
  const parsed = UpdatePortalSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return validationError(c, parsed.error);
  const portal = await updatePortal(id.data, parsed.data);
  return portal ? c.json({ portal }) : c.json({ error: 'not_found' }, 404);
});

portalRoutes.post('/:portalId/rotate-keys', async (c) => {
  const id = PortalIdParam.safeParse(c.req.param('portalId'));
  const credentials = id.success ? await rotateCredentials(id.data) : null;
  return credentials ? c.json({ credentials }) : c.json({ error: 'not_found' }, 404);
});

portalRoutes.delete('/:portalId', async (c) => {
  const id = PortalIdParam.safeParse(c.req.param('portalId'));
  const deleted = id.success ? await deletePortal(id.data) : false;
  return deleted ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
});
