import matter from 'gray-matter';
import type { ParsedDocument } from '../../types';
import type { ParserInput } from '../utils';
import { buildDocument, transformProse } from './markdown';

/** JSX attribute values: "..." | '...' | {expr, one level of nested braces} | bare chars */
const ATTRS = String.raw`(?:"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\}|[^<>"'{}])*`;

/** HTML tags that are safe to strip from prose (lower-case names are otherwise left alone). */
const HTML_TAGS = new Set([
  'div',
  'span',
  'p',
  'br',
  'hr',
  'img',
  'a',
  'b',
  'i',
  'em',
  'strong',
  'u',
  'small',
  'sup',
  'sub',
  'section',
  'article',
  'aside',
  'figure',
  'figcaption',
  'picture',
  'source',
  'video',
  'iframe',
  'details',
  'summary',
  'kbd',
  'mark',
  'center',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'ul',
  'ol',
  'li',
  'svg',
  'path',
]);

const TAG_RE = new RegExp(String.raw`<(\/?)([A-Za-z][\w.:-]*)(\s${ATTRS})?\s*(\/?)>`, 'g');
const FRAGMENT_RE = /<\/?>/g;

function readAttr(attrs: string, name: string): string | undefined {
  const match = new RegExp(String.raw`(?:^|\s)${name}=(?:"([^"]*)"|'([^']*)'|\{\s*["'\`]([^"'\`]*)["'\`]\s*\})`).exec(
    attrs,
  );
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/**
 * Turn a JSX/HTML tag into the markdown text worth keeping. Components are unwrapped
 * (children are kept); a title/label attribute is surfaced so cards, tabs and callouts
 * keep their visible text.
 */
function replaceTag(full: string, closing: string, name: string, rawAttrs: string | undefined): string {
  const isComponent = /^[A-Z]/.test(name) || name.includes('.');
  const lower = name.toLowerCase();
  if (!isComponent && !HTML_TAGS.has(lower)) return full;
  if (closing) return lower === 'li' || lower === 'p' || lower === 'div' || isComponent ? '\n' : '';

  const attrs = rawAttrs ?? '';
  if (lower === 'br') return '\n';
  if (lower === 'li') return '\n- ';
  if (lower === 'img') {
    const alt = readAttr(attrs, 'alt');
    return alt ? `(image: ${alt})` : '';
  }

  const label =
    readAttr(attrs, 'title') ?? readAttr(attrs, 'label') ?? (name === 'Tab' ? readAttr(attrs, 'value') : undefined);
  const description = readAttr(attrs, 'description');
  const href = readAttr(attrs, 'href');
  const parts: string[] = [];
  if (label) parts.push(href ? `**[${label}](${href})**` : `**${label}**`);
  if (description) parts.push(description);
  return parts.length > 0 ? `\n${parts.join(' — ')}\n` : isComponent ? '\n' : '';
}

/** Strip MDX syntax (ESM, JSX, expressions/comments) from prose, keeping readable markdown. */
export function stripMdx(markdown: string): string {
  return transformProse(markdown, (prose) =>
    prose
      // ESM import/export statements (possibly multi-line)
      .replace(
        /^(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]|export\s+(?:const|let|var|function|default|async|\{))[\s\S]*?(?:;[ \t]*$|(?=\n[ \t]*\n)|$(?![\s\S]))/gm,
        '',
      )
      // JSX + HTML comments
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(TAG_RE, (full, closing: string, name: string, attrs: string | undefined) =>
        replaceTag(full, closing, name, attrs),
      )
      .replace(FRAGMENT_RE, '')
      // Leading indentation left over from JSX nesting would turn prose into code blocks
      .replace(/^[ \t]+(?=\S)/gm, (indent) => (indent.length >= 4 ? '' : indent)),
  );
}

export function parseMdx(input: ParserInput): ParsedDocument {
  const { data, content } = matter(input.raw);
  return buildDocument(input, data, stripMdx(content));
}
