import Typesense from 'typesense';
import type Collection from 'typesense/lib/Typesense/Collection';
import type { CollectionCreateSchema } from 'typesense/lib/Typesense/Collections';
import { config } from '../config';

export interface TypesenseChunk {
  [key: string]: unknown;
  id: string;
  portal_id: string;
  slug: string;
  section: string;
  chunk_index: number;
  title: string;
  heading: string;
  url: string;
  content: string;
  has_code: boolean;
}

export const typesense = new Typesense.Client({
  nodes: [
    {
      host: config.TYPESENSE_HOST,
      port: config.TYPESENSE_PORT,
      protocol: config.TYPESENSE_PROTOCOL,
    },
  ],
  apiKey: config.TYPESENSE_API_KEY,
  connectionTimeoutSeconds: 5,
  numRetries: 2,
  // The SDK logs retries to stdout unstructured; failures surface as errors we log ourselves
  logLevel: 'error',
});

export const COLLECTION = config.TYPESENSE_COLLECTION;

const schema: CollectionCreateSchema = {
  name: COLLECTION,
  fields: [
    { name: 'portal_id', type: 'string', facet: true },
    { name: 'slug', type: 'string', facet: true },
    { name: 'section', type: 'string', facet: true },
    { name: 'chunk_index', type: 'int32' },
    { name: 'title', type: 'string' },
    { name: 'heading', type: 'string' },
    { name: 'url', type: 'string', index: false, optional: true },
    { name: 'content', type: 'string' },
    { name: 'has_code', type: 'bool', facet: true },
  ],
  token_separators: ['-', '_', '.', '/'],
};

export function chunkCollection(): Collection<TypesenseChunk> {
  return typesense.collections<TypesenseChunk>(COLLECTION);
}

export async function ensureCollection(): Promise<void> {
  const collection = typesense.collections(COLLECTION);
  if (!(await collection.exists())) {
    await typesense.collections().create(schema);
    return;
  }
  // Tenant isolation depends on portal_id being filterable: refuse to run against an old collection
  const existing = await collection.retrieve();
  if (!existing.fields.some((field) => field.name === 'portal_id')) {
    throw new Error(
      `Typesense collection "${COLLECTION}" has no portal_id field. Drop it or set TYPESENSE_COLLECTION to a new name, then re-ingest.`,
    );
  }
}

/**
 * Quote a value for a Typesense `filter_by` expression. Backtick-quoting makes commas, spaces and
 * operators literal; backticks themselves can't be escaped, so they are removed (ids and slugs never contain them).
 */
export function filterValue(value: string): string {
  return '`' + value.replace(/`/g, '') + '`';
}

/** Filter expression scoping every Typesense query/delete to one portal (plus optional extra clauses). */
export function portalFilter(portalId: string, ...clauses: string[]): string {
  return [`portal_id:=${filterValue(portalId)}`, ...clauses].join(' && ');
}

export async function pingTypesense(): Promise<boolean> {
  try {
    const health = await typesense.health.retrieve();
    return health.ok;
  } catch {
    return false;
  }
}
