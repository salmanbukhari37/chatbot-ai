import { parse, type HTMLElement, type Node, NodeType } from 'node-html-parser';
import type { ParsedDocument } from '../../types';
import type { ParserInput } from '../utils';
import { buildDocument } from './markdown';

const DROP_SELECTORS = ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'svg', 'form', 'button'];

function inlineText(node: Node): string {
  return node.childNodes.map((child) => nodeToMarkdown(child)).join('');
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) {
    return node.text.replace(/\s+/g, ' ');
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return '';

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `\n\n${'#'.repeat(Number(tag[1]))} ${inlineText(el).trim()}\n\n`;
    case 'p':
      return `\n\n${inlineText(el).trim()}\n\n`;
    case 'br':
      return '\n';
    case 'pre': {
      const code = el.querySelector('code');
      const lang = /language-([\w-]+)/.exec(code?.getAttribute('class') ?? '')?.[1] ?? '';
      return `\n\n\`\`\`${lang}\n${(code ?? el).text.replace(/\n+$/, '')}\n\`\`\`\n\n`;
    }
    case 'code':
      return `\`${el.text}\``;
    case 'li':
      return `\n- ${inlineText(el).trim()}`;
    case 'ul':
    case 'ol':
      return `\n${inlineText(el)}\n\n`;
    case 'a': {
      const text = inlineText(el).trim();
      const href = el.getAttribute('href');
      return href && text && !href.startsWith('#') ? `[${text}](${href})` : text;
    }
    case 'strong':
    case 'b':
      return `**${inlineText(el).trim()}**`;
    case 'em':
    case 'i':
      return `*${inlineText(el).trim()}*`;
    case 'tr':
      return `\n| ${el.childNodes
        .filter((c) => c.nodeType === NodeType.ELEMENT_NODE)
        .map((c) => inlineText(c).trim())
        .join(' | ')} |`;
    case 'table':
      return `\n\n${inlineText(el)}\n\n`;
    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'blockquote':
      return `\n${inlineText(el)}\n`;
    default:
      return inlineText(el);
  }
}

export function parseHtml(input: ParserInput): ParsedDocument {
  const root = parse(input.raw, { comment: false, blockTextElements: { pre: true, script: false, style: false } });
  const metaTitle = root.querySelector('title')?.text.trim();
  const description = root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim();

  const main = root.querySelector('main') ?? root.querySelector('article') ?? root.querySelector('body') ?? root;
  for (const selector of DROP_SELECTORS) {
    for (const el of main.querySelectorAll(selector)) el.remove();
  }

  const markdown = nodeToMarkdown(main);
  return buildDocument(
    input,
    {
      // Prefer the page's H1 (extracted by buildDocument) over a "Page | Site" <title>
      title: main.querySelector('h1') ? undefined : metaTitle,
      description,
    },
    markdown,
  );
}
