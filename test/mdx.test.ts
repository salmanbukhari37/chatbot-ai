import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMdx, stripMdx } from '../src/ingestion/parsers/mdx';
import { slugFromPath } from '../src/ingestion/utils';

const input = (raw: string, relativePath = 'guides/example.mdx') => ({
  raw,
  relativePath,
  absolutePath: `/docs/${relativePath}`,
  baseUrl: 'https://docs.example.com/docs',
  mtime: new Date('2026-01-01T00:00:00Z'),
});

describe('slugFromPath', () => {
  it('drops extensions, index segments and route groups', () => {
    assert.equal(slugFromPath('guides/auth.mdx'), 'guides/auth');
    assert.equal(slugFromPath('getting-started/index.mdx'), 'getting-started');
    assert.equal(slugFromPath('(api)/errors.mdx'), 'errors');
    assert.equal(slugFromPath('index.mdx'), '');
  });
});

describe('stripMdx', () => {
  it('removes imports, exports and JSX comments', () => {
    const out = stripMdx(
      "import { Callout } from 'fumadocs-ui/components/callout';\nexport const meta = { a: 1 };\n\n{/* hidden */}\nVisible text",
    );
    assert.equal(out.trim(), 'Visible text');
  });

  it('keeps prose that merely starts with the word import', () => {
    assert.match(stripMdx('import the SDK before calling it.'), /import the SDK/);
  });

  it('unwraps components and surfaces title attributes', () => {
    const out = stripMdx('<Callout type="warn" title="Careful">\n  Body text\n</Callout>');
    assert.match(out, /\*\*Careful\*\*/);
    assert.match(out, /Body text/);
    assert.doesNotMatch(out, /Callout/);
  });

  it('never touches code fences or inline code', () => {
    const src = 'Use `<Callout>` here.\n\n```tsx\n<Callout title="x" />\nimport a from "b";\n```';
    const out = stripMdx(src);
    assert.match(out, /`<Callout>`/);
    assert.match(out, /<Callout title="x" \/>/);
    assert.match(out, /import a from "b";/);
  });

  it('dedents fences nested inside JSX', () => {
    const out = stripMdx('<Tab value="npm">\n    ```bash\n    npm i x\n    ```\n</Tab>');
    assert.match(out, /^```bash\nnpm i x\n```$/m);
  });
});

describe('parseMdx', () => {
  it('reads frontmatter and builds url + hash', () => {
    const doc = parseMdx(input('---\ntitle: Auth\ndescription: Keys\n---\n\n# Auth\n\nBody'));
    assert.equal(doc.title, 'Auth');
    assert.equal(doc.description, 'Keys');
    assert.equal(doc.slug, 'guides/example');
    assert.equal(doc.url, 'https://docs.example.com/docs/guides/example');
    assert.equal(doc.content, 'Body', 'duplicate H1 is removed');
    assert.match(doc.contentHash, /^[a-f0-9]{64}$/);
  });

  it('honours a frontmatter slug and maps the docs root to "index"', () => {
    assert.equal(parseMdx(input('---\nslug: /custom/path/\n---\nx')).slug, 'custom/path');
    const root = parseMdx(input('---\ntitle: Home\n---\nx', 'index.mdx'));
    assert.equal(root.slug, 'index');
    assert.equal(root.url, 'https://docs.example.com/docs');
  });

  it('produces a stable hash for identical content', () => {
    const raw = '---\ntitle: A\n---\nSame';
    assert.equal(parseMdx(input(raw)).contentHash, parseMdx(input(raw)).contentHash);
  });
});
