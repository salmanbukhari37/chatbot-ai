import { createHash, randomBytes } from 'node:crypto';
import { chunkCollection, portalFilter } from '../db/typesense';
import { pool } from '../db/postgres';
import type { Portal, PortalStatus } from '../types';

/**
 * Two credentials per portal:
 * - public key (pk_live_…): embedded in the portal's browser bundle; identifies the portal for chat.
 *   It is NOT a secret: origin checks and rate limits are what protect it.
 * - ingest key (sk_live_…): secret, used by CI/CLI to push content for this portal only.
 * Only SHA-256 hashes are stored; raw keys are returned once, at creation or rotation.
 */
const PUBLIC_KEY_PREFIX = 'pk_live_';
const INGEST_KEY_PREFIX = 'sk_live_';

export interface PortalCredentials {
  publicKey: string;
  ingestKey: string;
}

interface PortalRow {
  id: string;
  name: string;
  tenant_id: string;
  base_url: string;
  allowed_origins: string[];
  status: PortalStatus;
  rate_limit_per_minute: number | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, name, tenant_id, base_url, allowed_origins, status, rate_limit_per_minute, created_at, updated_at';

function toPortal(row: PortalRow): Portal {
  return {
    id: row.id,
    name: row.name,
    tenantId: row.tenant_id,
    baseUrl: row.base_url,
    allowedOrigins: row.allowed_origins,
    status: row.status,
    rateLimitPerMinute: row.rate_limit_per_minute,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function newPortalId(): string {
  return `prt_${randomBytes(10).toString('hex')}`;
}

function newCredentials(): PortalCredentials {
  return {
    publicKey: PUBLIC_KEY_PREFIX + randomBytes(24).toString('base64url'),
    ingestKey: INGEST_KEY_PREFIX + randomBytes(32).toString('base64url'),
  };
}

/** Normalise to a bare origin ("https://example.com:8443"); throws on anything else. */
export function normaliseOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Unsupported origin: ${value}`);
  return url.origin;
}

// ---- Cache: public-key lookups happen on every chat request -------------------------------

const CACHE_TTL_MS = 30_000;
const byPublicKeyHash = new Map<string, { portal: Portal | null; expires: number }>();
let originsCache: { origins: Set<string>; expires: number } | undefined;

function invalidateCaches(): void {
  byPublicKeyHash.clear();
  originsCache = undefined;
}

// ---- Queries -------------------------------------------------------------------------------

export interface CreatePortalInput {
  name: string;
  tenantId: string;
  baseUrl: string;
  allowedOrigins?: string[];
  rateLimitPerMinute?: number | null;
}

const trimTrailingSlashes = (url: string): string => url.replace(/\/+$/, '');

export async function createPortal(
  input: CreatePortalInput,
): Promise<{ portal: Portal; credentials: PortalCredentials }> {
  const credentials = newCredentials();
  const baseUrl = trimTrailingSlashes(input.baseUrl);
  // The deployed site's own origin is always allowed
  const origins = new Set((input.allowedOrigins ?? []).map(normaliseOrigin));
  origins.add(normaliseOrigin(baseUrl));

  const { rows } = await pool.query<PortalRow>(
    `INSERT INTO portals (id, name, tenant_id, base_url, allowed_origins, public_key_hash, ingest_key_hash, rate_limit_per_minute)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [
      newPortalId(),
      input.name,
      input.tenantId,
      baseUrl,
      [...origins],
      hashKey(credentials.publicKey),
      hashKey(credentials.ingestKey),
      input.rateLimitPerMinute ?? null,
    ],
  );
  invalidateCaches();
  const row = rows[0];
  if (!row) throw new Error('Portal insert returned no row');
  return { portal: toPortal(row), credentials };
}

export async function getPortal(id: string): Promise<Portal | null> {
  const { rows } = await pool.query<PortalRow>(`SELECT ${COLUMNS} FROM portals WHERE id = $1`, [id]);
  return rows[0] ? toPortal(rows[0]) : null;
}

export async function listPortals(filter: { tenantId?: string } = {}): Promise<Portal[]> {
  const { rows } = filter.tenantId
    ? await pool.query<PortalRow>(`SELECT ${COLUMNS} FROM portals WHERE tenant_id = $1 ORDER BY created_at`, [
        filter.tenantId,
      ])
    : await pool.query<PortalRow>(`SELECT ${COLUMNS} FROM portals ORDER BY created_at`);
  return rows.map(toPortal);
}

export interface UpdatePortalInput {
  name?: string;
  /** Changing it takes effect for citation links on the next ingest */
  baseUrl?: string;
  allowedOrigins?: string[];
  status?: PortalStatus;
  rateLimitPerMinute?: number | null;
}

export async function updatePortal(id: string, input: UpdatePortalInput): Promise<Portal | null> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (input.name !== undefined) set('name', input.name);
  if (input.baseUrl !== undefined) set('base_url', trimTrailingSlashes(input.baseUrl));
  if (input.allowedOrigins !== undefined) set('allowed_origins', input.allowedOrigins.map(normaliseOrigin));
  if (input.status !== undefined) set('status', input.status);
  if (input.rateLimitPerMinute !== undefined) set('rate_limit_per_minute', input.rateLimitPerMinute);
  if (sets.length === 0) return getPortal(id);

  const { rows } = await pool.query<PortalRow>(
    `UPDATE portals SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    values,
  );
  invalidateCaches();
  return rows[0] ? toPortal(rows[0]) : null;
}

export async function rotateCredentials(id: string): Promise<PortalCredentials | null> {
  const credentials = newCredentials();
  const result = await pool.query(
    'UPDATE portals SET public_key_hash = $2, ingest_key_hash = $3, updated_at = now() WHERE id = $1',
    [id, hashKey(credentials.publicKey), hashKey(credentials.ingestKey)],
  );
  invalidateCaches();
  return result.rowCount ? credentials : null;
}

/** Delete a portal and all of its indexed data (Postgres cascades; Typesense is cleared explicitly). */
export async function deletePortal(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM portals WHERE id = $1', [id]);
  invalidateCaches();
  if (!result.rowCount) return false;
  await chunkCollection()
    .documents()
    .delete({ filter_by: portalFilter(id) });
  return true;
}

/** Resolve an active portal from its public key (cached; negative results cached too). */
export async function findActivePortalByPublicKey(publicKey: string): Promise<Portal | null> {
  if (!publicKey.startsWith(PUBLIC_KEY_PREFIX)) return null;
  const keyHash = hashKey(publicKey);
  const cached = byPublicKeyHash.get(keyHash);
  if (cached && cached.expires > Date.now()) return cached.portal;

  const { rows } = await pool.query<PortalRow>(
    `SELECT ${COLUMNS} FROM portals WHERE public_key_hash = $1 AND status = 'active'`,
    [keyHash],
  );
  const portal = rows[0] ? toPortal(rows[0]) : null;
  byPublicKeyHash.set(keyHash, { portal, expires: Date.now() + CACHE_TTL_MS });
  return portal;
}

/** True when `ingestKey` is the ingest key of portal `portalId`. */
export async function verifyIngestKey(portalId: string, ingestKey: string): Promise<boolean> {
  if (!ingestKey.startsWith(INGEST_KEY_PREFIX)) return false;
  const { rowCount } = await pool.query('SELECT 1 FROM portals WHERE id = $1 AND ingest_key_hash = $2', [
    portalId,
    hashKey(ingestKey),
  ]);
  return (rowCount ?? 0) > 0;
}

/** Union of all active portals' allowed origins, used to answer CORS preflights (which carry no key). */
export async function allAllowedOrigins(): Promise<Set<string>> {
  if (originsCache && originsCache.expires > Date.now()) return originsCache.origins;
  const { rows } = await pool.query<{ origin: string }>(
    "SELECT DISTINCT unnest(allowed_origins) AS origin FROM portals WHERE status = 'active'",
  );
  originsCache = { origins: new Set(rows.map((r) => r.origin)), expires: Date.now() + CACHE_TTL_MS };
  return originsCache.origins;
}
