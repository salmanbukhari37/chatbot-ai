import { createHash } from 'node:crypto';
import path from 'node:path';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Derive a Fumadocs-style slug from a file path relative to the content root:
 *   "getting-started/index.mdx" -> "getting-started"
 *   "guides/auth.mdx"           -> "guides/auth"
 *   "index.mdx"                 -> ""  (docs root)
 */
export function slugFromPath(relativePath: string): string {
  const normalised = relativePath.split(path.sep).join('/');
  const withoutExt = normalised.replace(/\.(mdx|md|html?)$/i, '');
  const segments = withoutExt
    .split('/')
    // Fumadocs route groups "(group)" do not appear in URLs
    .filter((segment) => segment.length > 0 && !/^\(.*\)$/.test(segment));
  if (segments[segments.length - 1] === 'index') segments.pop();
  return segments.join('/');
}

export function normaliseSlug(slug: string): string {
  return slug.trim().replace(/^\/+|\/+$/g, '');
}

/** Absolute URL when the portal's base URL is known, otherwise a root-relative path. */
export function buildUrl(baseUrl: string, slug: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (!base) return `/${slug}`;
  return slug ? `${base}/${slug}` : base;
}

/**
 * Top-level portal area a page belongs to, used for metadata and filtering:
 * "api/payments/users/get-user" -> "api/payments", "guides/intro" -> "guides", "index" -> "home".
 */
export function sectionFromSlug(slug: string): string {
  if (slug === 'index' || slug === '') return 'home';
  const [first = 'home', second] = slug.split('/');
  return first === 'api' && second ? `api/${second}` : first;
}

export function titleFromFilename(relativePath: string): string {
  const base = path.basename(relativePath).replace(/\.(mdx|md|html?)$/i, '');
  const name = base === 'index' ? path.basename(path.dirname(relativePath)) || 'Home' : base;
  return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function collapseBlankLines(text: string): string {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return undefined;
}

export interface ParserInput {
  /** Raw file contents */
  raw: string;
  /** Path relative to the content root */
  relativePath: string;
  /** Absolute path, stored for debugging */
  absolutePath: string;
  /** Public base URL that slugs are appended to */
  baseUrl: string;
  /** File mtime, used when frontmatter has no date */
  mtime: Date;
}
