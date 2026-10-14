import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { migrate } from '../db/migrations';
import { closePostgres, pool, toVectorParam, withTransaction } from '../db/postgres';
import { chunkCollection, ensureCollection, filterValue, portalFilter, type TypesenseChunk } from '../db/typesense';
import { embedTexts } from '../services/embeddings';
import { getPortal } from '../services/portals';
import type { Chunk, ParsedDocument, Portal } from '../types';
import { chunkDocument, DEFAULT_CHUNKER_OPTIONS } from './chunker';
import { parseHtml } from './parsers/html';
import { parseMarkdown } from './parsers/markdown';
import { parseMdx } from './parsers/mdx';
import type { ParserInput } from './utils';

/** One source file, from an API upload or read from disk. `path` is relative to the portal root. */
export interface SourceFile {
  path: string;
  content: string;
  lastModified?: Date;
}

export interface IngestOptions {
  /** Re-process pages even when their content hash is unchanged (embeddings are still reused) */
  force?: boolean;
  /** Treat `files` as the complete portal: delete indexed pages that are not in it */
  prune?: boolean;
  log?: (message: string) => void;
  /** Called between pages; lets job runners record liveness */
  onProgress?: () => Promise<void>;
}

export interface IngestStats {
  files: number;
  pagesUpdated: number;
  pagesUnchanged: number;
  pagesPruned: number;
  chunksEmbedded: number;
  chunksReused: number;
  chunksDeleted: number;
  errors: { file: string; error: string }[];
  durationMs: number;
}

const PARSERS: Record<string, (input: ParserInput) => ParsedDocument> = {
  '.mdx': parseMdx,
  '.md': parseMarkdown,
  '.html': parseHtml,
  '.htm': parseHtml,
};

export const SUPPORTED_EXTENSIONS = Object.keys(PARSERS);

export function isSupportedFile(filePath: string): boolean {
  return Object.hasOwn(PARSERS, path.extname(filePath).toLowerCase());
}

function parseSource(file: SourceFile, baseUrl: string): ParsedDocument {
  const parser = PARSERS[path.extname(file.path).toLowerCase()];
  if (!parser) throw new Error(`Unsupported file type: ${file.path}`);
  return parser({
    raw: file.content,
    relativePath: file.path,
    absolutePath: file.path,
    baseUrl,
    mtime: file.lastModified ?? new Date(),
  });
}

/** True when the stored page has the same content and URL (a base URL change must refresh citations). */
async function isPageUnchanged(portalId: string, doc: ParsedDocument): Promise<boolean> {
  const { rows } = await pool.query<{ content_hash: string; url: string }>(
    'SELECT content_hash, url FROM documents WHERE portal_id = $1 AND slug = $2',
    [portalId, doc.slug],
  );
  return rows[0]?.content_hash === doc.contentHash && rows[0].url === doc.url;
}

/**
 * Write one page: embed only chunks whose id isn't stored yet, upsert the page, delete chunks
 * that no longer exist, then mirror the page's chunks into Typesense. Every statement is scoped
 * by portal_id.
 */
async function indexDocument(
  portalId: string,
  doc: ParsedDocument,
  chunks: Chunk[],
): Promise<{ embedded: number; reused: number; deleted: number }> {
  const { rows: existing } = await pool.query<{ id: string }>(
    'SELECT id FROM chunks WHERE portal_id = $1 AND slug = $2',
    [portalId, doc.slug],
  );
  const existingIds = new Set(existing.map((row) => row.id));
  const toEmbed = chunks.filter((chunk) => !existingIds.has(chunk.id));
  // Embed before opening the transaction so a slow API call doesn't hold locks
  const embeddings = toEmbed.length > 0 ? await embedTexts(toEmbed.map((c) => c.content)) : [];

  const deleted = await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO documents (portal_id, slug, section, title, description, url, content, content_hash, source_path, last_modified, indexed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (portal_id, slug) DO UPDATE SET
         section = EXCLUDED.section, title = EXCLUDED.title, description = EXCLUDED.description,
         url = EXCLUDED.url, content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
         source_path = EXCLUDED.source_path, last_modified = EXCLUDED.last_modified, indexed_at = now()`,
      [
        portalId,
        doc.slug,
        doc.section,
        doc.title,
        doc.description,
        doc.url,
        doc.content,
        doc.contentHash,
        doc.sourcePath,
        doc.lastModified,
      ],
    );

    for (const [i, chunk] of toEmbed.entries()) {
      const embedding = embeddings[i];
      if (!embedding) throw new Error(`Missing embedding for chunk ${chunk.id}`);
      await client.query(
        `INSERT INTO chunks (id, portal_id, slug, section, chunk_index, title, heading, url, content, content_hash, token_count, has_code, last_modified, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::vector)
         ON CONFLICT (id) DO NOTHING`,
        [
          chunk.id,
          portalId,
          chunk.slug,
          chunk.section,
          chunk.chunkIndex,
          chunk.title,
          chunk.heading,
          chunk.url,
          chunk.content,
          chunk.contentHash,
          chunk.tokenCount,
          chunk.hasCode,
          chunk.lastModified,
          toVectorParam(embedding),
        ],
      );
    }

    // Unchanged chunks keep their embedding but may have moved or had page metadata change
    for (const chunk of chunks.filter((c) => existingIds.has(c.id))) {
      await client.query(
        `UPDATE chunks SET chunk_index = $3, title = $4, heading = $5, url = $6, section = $7, last_modified = $8
          WHERE portal_id = $1 AND id = $2`,
        [
          portalId,
          chunk.id,
          chunk.chunkIndex,
          chunk.title,
          chunk.heading,
          chunk.url,
          chunk.section,
          chunk.lastModified,
        ],
      );
    }

    const result = await client.query(
      'DELETE FROM chunks WHERE portal_id = $1 AND slug = $2 AND NOT (id = ANY($3::text[]))',
      [portalId, doc.slug, chunks.map((c) => c.id)],
    );
    return result.rowCount ?? 0;
  });

  // Typesense is a derived index: replace this page's chunks
  const collection = chunkCollection();
  await collection.documents().delete({ filter_by: portalFilter(portalId, `slug:=${filterValue(doc.slug)}`) });
  if (chunks.length > 0) {
    const docs: TypesenseChunk[] = chunks.map((chunk) => ({
      id: chunk.id,
      portal_id: portalId,
      slug: chunk.slug,
      section: chunk.section,
      chunk_index: chunk.chunkIndex,
      title: chunk.title,
      heading: chunk.heading,
      url: chunk.url,
      content: chunk.content,
      has_code: chunk.hasCode,
    }));
    const results = await collection.documents().import(docs, { action: 'upsert' });
    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      throw new Error(`Typesense import failed for ${failed.length} chunk(s): ${failed[0]?.error ?? 'unknown error'}`);
    }
  }

  return { embedded: toEmbed.length, reused: chunks.length - toEmbed.length, deleted };
}

async function pruneMissing(portalId: string, keep: Set<string>, log: (m: string) => void): Promise<number> {
  const { rows } = await pool.query<{ slug: string }>('SELECT slug FROM documents WHERE portal_id = $1', [portalId]);
  const stale = rows.map((r) => r.slug).filter((slug) => !keep.has(slug));
  for (const slug of stale) {
    await pool.query('DELETE FROM documents WHERE portal_id = $1 AND slug = $2', [portalId, slug]); // chunks cascade
    await chunkCollection()
      .documents()
      .delete({ filter_by: portalFilter(portalId, `slug:=${filterValue(slug)}`) });
    log(`  pruned  /${slug}`);
  }
  return stale.length;
}

/** Index a set of files into one portal. Callers must have run migrations and ensureCollection(). */
export async function ingestPortal(
  portal: Portal,
  files: SourceFile[],
  options: IngestOptions = {},
): Promise<IngestStats> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  const sorted = [...files].filter((f) => isSupportedFile(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  log(`Ingesting ${sorted.length} file(s) into portal ${portal.id} (${portal.name})`);

  const stats: IngestStats = {
    files: sorted.length,
    pagesUpdated: 0,
    pagesUnchanged: 0,
    pagesPruned: 0,
    chunksEmbedded: 0,
    chunksReused: 0,
    chunksDeleted: 0,
    errors: [],
    durationMs: 0,
  };
  const seenSlugs = new Set<string>();

  for (const file of sorted) {
    await options.onProgress?.();
    try {
      const doc = parseSource(file, portal.baseUrl);
      if (seenSlugs.has(doc.slug)) {
        log(`  skip    ${file.path} (duplicate of an earlier file for /${doc.slug})`);
        continue;
      }
      seenSlugs.add(doc.slug);

      if (!options.force && (await isPageUnchanged(portal.id, doc))) {
        stats.pagesUnchanged += 1;
        continue;
      }

      const chunks = chunkDocument(doc, DEFAULT_CHUNKER_OPTIONS, portal.id);
      const result = await indexDocument(portal.id, doc, chunks);
      stats.pagesUpdated += 1;
      stats.chunksEmbedded += result.embedded;
      stats.chunksReused += result.reused;
      stats.chunksDeleted += result.deleted;
      log(`  indexed /${doc.slug} — ${chunks.length} chunk(s), ${result.embedded} embedded, ${result.deleted} removed`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stats.errors.push({ file: file.path, error: message });
      log(`  ERROR   ${file.path}: ${message}`);
    }
  }

  // Never prune after a run with errors: pages that failed to parse would be deleted wrongly
  if (options.prune && stats.errors.length === 0) {
    stats.pagesPruned = await pruneMissing(portal.id, seenSlugs, log);
  }

  stats.durationMs = Date.now() - started;
  log(
    `Done in ${(stats.durationMs / 1000).toFixed(1)}s: ${stats.pagesUpdated} updated, ${stats.pagesUnchanged} unchanged, ` +
      `${stats.pagesPruned} pruned; ${stats.chunksEmbedded} chunk(s) embedded, ${stats.chunksReused} reused, ` +
      `${stats.chunksDeleted} deleted; ${stats.errors.length} error(s)`,
  );
  return stats;
}

/** Read every supported file under `root`, skipping dot-directories and node_modules. */
export async function readSourceDirectory(root: string): Promise<SourceFile[]> {
  const absoluteRoot = path.resolve(root);
  const rootStat = await fs.stat(absoluteRoot).catch(() => undefined);
  if (!rootStat?.isDirectory()) throw new Error(`Source directory not found: ${absoluteRoot}`);

  const entries = await fs.readdir(absoluteRoot, { recursive: true, withFileTypes: true });
  const relativePaths = entries
    .filter((entry) => entry.isFile() && isSupportedFile(entry.name))
    .map((entry) => path.relative(absoluteRoot, path.join(entry.parentPath, entry.name)))
    .filter((relative) => !relative.split(path.sep).some((part) => part === 'node_modules' || part.startsWith('.')));

  return Promise.all(
    relativePaths.map(async (relative) => {
      const absolute = path.join(absoluteRoot, relative);
      const [content, stat] = await Promise.all([fs.readFile(absolute, 'utf8'), fs.stat(absolute)]);
      // Use "/" so slugs and stored paths are identical on every OS
      return { path: relative.split(path.sep).join('/'), content, lastModified: stat.mtime };
    }),
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      portal: { type: 'string', short: 'p' },
      source: { type: 'string', short: 's' },
      force: { type: 'boolean', default: false },
      prune: { type: 'boolean', default: false },
    },
  });
  if (!values.portal || !values.source) {
    console.error('Usage: ingest --portal <portalId> --source <dir> [--force] [--prune]');
    process.exitCode = 2;
    return;
  }

  await migrate();
  await ensureCollection();
  const portal = await getPortal(values.portal);
  if (!portal) throw new Error(`Portal not found: ${values.portal}`);

  const files = await readSourceDirectory(values.source);
  const stats = await ingestPortal(portal, files, {
    force: values.force,
    prune: values.prune,
    log: (message) => {
      console.log(message);
    },
  });
  process.exitCode = stats.errors.length > 0 ? 1 : 0;
}

if (require.main === module) {
  main()
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => {
      void closePostgres().catch(() => undefined);
    });
}
