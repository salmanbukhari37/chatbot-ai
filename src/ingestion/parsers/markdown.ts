import matter from 'gray-matter';
import type { ParsedDocument } from '../../types';
import {
  buildUrl,
  collapseBlankLines,
  normaliseSlug,
  parseDate,
  sectionFromSlug,
  sha256,
  slugFromPath,
  titleFromFilename,
  type ParserInput,
} from '../utils';

export interface Frontmatter {
  title?: unknown;
  slug?: unknown;
  description?: unknown;
  lastModified?: unknown;
  updated?: unknown;
  date?: unknown;
}

// MDX has no indented code blocks, so fences nested in JSX may be indented any amount
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** Split markdown into alternating prose / fenced-code segments so transforms can skip code. */
export function splitByFences(markdown: string): { code: boolean; text: string }[] {
  const segments: { code: boolean; text: string }[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = (code: boolean) => {
    if (buffer.length > 0) segments.push({ code, text: buffer.join('\n') });
    buffer = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const match = FENCE_RE.exec(line);
    if (fence === null && match?.[1]) {
      flush(false);
      fence = match[1];
      buffer.push(line);
    } else if (
      fence !== null &&
      match?.[1] &&
      match[1].startsWith(fence.charAt(0)) &&
      match[1].length >= fence.length &&
      line.trim() === match[1]
    ) {
      buffer.push(line);
      flush(true);
      fence = null;
    } else {
      buffer.push(line);
    }
  }
  flush(fence !== null);
  return segments;
}

/** Remove the opening fence's indentation from every line of a fenced block. */
function dedentFence(block: string): string {
  const indent = /^[ \t]*/.exec(block)?.[0].length ?? 0;
  if (indent === 0) return block;
  const leading = new RegExp(`^[ \t]{0,${indent}}`);
  return block
    .split('\n')
    .map((line) => line.replace(leading, ''))
    .join('\n');
}

// Private-use character: never appears in real docs, so it safely marks protected inline code
const PLACEHOLDER = '';
const PLACEHOLDER_RE = /(\d+)/g;

/** Apply `transform` to prose only, leaving fenced code blocks and inline code untouched. */
export function transformProse(markdown: string, transform: (prose: string) => string): string {
  return splitByFences(markdown)
    .map((segment) => {
      if (segment.code) return dedentFence(segment.text);
      const inline: string[] = [];
      const protectedText = segment.text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m) => {
        inline.push(m);
        return `${PLACEHOLDER}${inline.length - 1}${PLACEHOLDER}`;
      });
      return transform(protectedText).replace(PLACEHOLDER_RE, (_, i: string) => inline[Number(i)] ?? '');
    })
    .join('\n');
}

/**
 * Pull the first H1 out of the body: Fumadocs renders the frontmatter title as the H1,
 * so a duplicate in the body only adds noise. Returns the heading text if found.
 */
export function extractLeadingH1(markdown: string): { title?: string; body: string } {
  let title: string | undefined;
  const body = transformProse(markdown, (prose) =>
    title === undefined
      ? prose.replace(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m, (_, heading: string) => {
          title = heading.trim();
          return '';
        })
      : prose,
  );
  return { title, body };
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Shared document assembly for markdown-like sources. */
export function buildDocument(input: ParserInput, data: Frontmatter, cleanBody: string): ParsedDocument {
  const { title: h1, body } = extractLeadingH1(cleanBody);
  const title = stringOrUndefined(data.title) ?? h1 ?? titleFromFilename(input.relativePath);
  const description = stringOrUndefined(data.description) ?? '';
  const urlPath = normaliseSlug(stringOrUndefined(data.slug) ?? slugFromPath(input.relativePath));
  // The docs root has an empty URL path; store it under a real key so it can be looked up and filtered
  const slug = urlPath || 'index';
  const content = collapseBlankLines(body);
  const lastModified = parseDate(data.lastModified) ?? parseDate(data.updated) ?? parseDate(data.date) ?? input.mtime;

  return {
    slug,
    section: sectionFromSlug(slug),
    title,
    description,
    url: buildUrl(input.baseUrl, urlPath),
    content,
    contentHash: sha256([title, description, content].join('\n')),
    lastModified,
    sourcePath: input.absolutePath,
  };
}

export function parseMarkdown(input: ParserInput): ParsedDocument {
  const { data, content } = matter(input.raw);
  const clean = transformProse(content, (prose) => prose.replace(/<!--[\s\S]*?-->/g, ''));
  return buildDocument(input, data, clean);
}
