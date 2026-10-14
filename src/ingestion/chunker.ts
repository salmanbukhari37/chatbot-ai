import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { Chunk, ParsedDocument } from '../types';
import { splitByFences } from './parsers/markdown';
import { sha256 } from './utils';

export interface ChunkerOptions {
  /** Max tokens per chunk, including the "title > heading" prefix */
  maxTokens: number;
  /** Tokens repeated from the end of the previous chunk when a section is split */
  overlapTokens: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = { maxTokens: 512, overlapTokens: 64 };

// text-embedding-3-* models use the cl100k_base tokenizer
let encoder: Tiktoken | undefined;
function enc(): Tiktoken {
  encoder ??= getEncoding('cl100k_base');
  return encoder;
}

export function countTokens(text: string): number {
  return enc().encode(text).length;
}

interface Section {
  heading: string;
  body: string;
}

const HEADING_RE = /^(#{2,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** Split on H2/H3 headings (ignoring "#" lines inside fenced code). */
export function splitSections(markdown: string, pageTitle: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: pageTitle, body: '' };
  let h2 = '';

  for (const segment of splitByFences(markdown)) {
    if (segment.code) {
      current.body += `${segment.text}\n`;
      continue;
    }
    for (const line of segment.text.split('\n')) {
      const match = HEADING_RE.exec(line);
      if (match?.[1] && match[2]) {
        sections.push(current);
        const text = match[2].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
        if (match[1].length === 2) {
          h2 = text;
          current = { heading: text, body: '' };
        } else {
          // Keep the parent H2 so an H3 chunk is self-describing
          current = { heading: h2 ? `${h2} > ${text}` : text, body: '' };
        }
      } else {
        current.body += `${line}\n`;
      }
    }
  }
  sections.push(current);
  return sections
    .map((section) => ({ heading: section.heading, body: section.body.trim() }))
    .filter((section) => section.body.length > 0);
}

/** Split a section body into blocks: fenced code blocks stay intact, prose splits on blank lines. */
function splitBlocks(body: string): string[] {
  const blocks: string[] = [];
  for (const segment of splitByFences(body)) {
    if (segment.code) {
      blocks.push(segment.text.trim());
    } else {
      blocks.push(
        ...segment.text
          .split(/\n[ \t]*\n/)
          .map((b) => b.trim())
          .filter(Boolean),
      );
    }
  }
  return blocks;
}

/** Hard-split an oversized block on token boundaries, with overlap. */
function splitByTokens(text: string, budget: number, overlap: number): string[] {
  const tokens = enc().encode(text);
  const step = Math.max(1, budget - overlap);
  const pieces: string[] = [];
  for (let start = 0; start < tokens.length; start += step) {
    pieces.push(enc().decode(tokens.slice(start, start + budget)));
    if (start + budget >= tokens.length) break;
  }
  return pieces;
}

/** Last `overlap` tokens of a chunk body, trimmed to a word boundary. */
function tailOverlap(text: string, overlap: number): string {
  if (overlap <= 0) return '';
  const tokens = enc().encode(text);
  if (tokens.length <= overlap) return text;
  const tail = enc().decode(tokens.slice(tokens.length - overlap));
  const firstSpace = tail.search(/\s/);
  return (firstSpace > 0 ? tail.slice(firstSpace) : tail).trim();
}

/** Greedily pack blocks into bodies of at most `budget` tokens, carrying overlap between them. */
function packBlocks(blocks: string[], budget: number, overlap: number): string[] {
  const bodies: string[] = [];
  let parts: string[] = [];
  let used = 0;
  // True while `parts` holds only text carried over from the previous chunk
  let onlyCarry = false;

  const startWithCarry = (previous: string) => {
    const carry = tailOverlap(previous, overlap);
    parts = carry ? [carry] : [];
    used = carry ? countTokens(carry) + 2 : 0;
    onlyCarry = parts.length > 0;
  };

  const flush = () => {
    if (parts.length === 0 || onlyCarry) return;
    const body = parts.join('\n\n');
    bodies.push(body);
    startWithCarry(body);
  };

  for (const block of blocks) {
    const size = countTokens(block) + 2; // +2 approximates the "\n\n" separator
    if (size > budget) {
      flush();
      const pieces = splitByTokens(block, budget, overlap);
      bodies.push(...pieces);
      startWithCarry(pieces[pieces.length - 1] ?? '');
      continue;
    }
    if (used + size > budget) {
      flush();
      // The carried overlap plus this block still doesn't fit: drop the overlap
      if (used + size > budget) {
        parts = [];
        used = 0;
      }
    }
    parts.push(block);
    used += size;
    onlyCarry = false;
  }
  flush();
  return bodies;
}

/**
 * Split a page into heading-scoped chunks. `namespace` (the portal id) is mixed into chunk ids so
 * identical text in two tenants never collides.
 */
export function chunkDocument(
  doc: ParsedDocument,
  options: ChunkerOptions = DEFAULT_CHUNKER_OPTIONS,
  namespace = '',
): Chunk[] {
  const chunks: Chunk[] = [];
  const seen = new Set<string>();

  for (const section of splitSections(doc.content, doc.title)) {
    const prefix = section.heading === doc.title ? `# ${doc.title}\n\n` : `# ${doc.title} > ${section.heading}\n\n`;
    const budget = Math.max(64, options.maxTokens - countTokens(prefix));
    const overlap = Math.min(options.overlapTokens, Math.floor(budget / 4));

    for (const body of packBlocks(splitBlocks(section.body), budget, overlap)) {
      const content = prefix + body;
      const contentHash = sha256(content);
      const id = sha256(`${namespace}\n${doc.slug}\n${contentHash}`).slice(0, 32);
      if (seen.has(id)) continue;
      seen.add(id);
      chunks.push({
        id,
        chunkIndex: chunks.length,
        title: doc.title,
        slug: doc.slug,
        section: doc.section,
        heading: section.heading,
        url: doc.url,
        contentHash,
        lastModified: doc.lastModified,
        content,
        tokenCount: countTokens(content),
        hasCode: /^\s*(`{3,}|~{3,})/m.test(body),
      });
    }
  }
  return chunks;
}
