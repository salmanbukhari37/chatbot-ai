import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkDocument, countTokens, splitSections } from '../src/ingestion/chunker';
import type { ParsedDocument } from '../src/types';

const doc = (content: string): ParsedDocument => ({
  slug: 'guides/test',
  section: 'guides',
  title: 'Test Page',
  description: '',
  url: 'https://docs.example.com/docs/guides/test',
  content,
  contentHash: 'x',
  lastModified: new Date('2026-01-01T00:00:00Z'),
  sourcePath: '/tmp/test.mdx',
});

const sentence = (i: number) => `Sentence number ${i} explains a detail about configuring the client library.`;

describe('splitSections', () => {
  it('splits on H2/H3 and keeps the parent H2 in H3 headings', () => {
    const sections = splitSections('Intro\n\n## Setup\n\nA\n\n### Linux\n\nB\n\n## Usage\n\nC', 'Page');
    assert.deepEqual(
      sections.map((s) => s.heading),
      ['Page', 'Setup', 'Setup > Linux', 'Usage'],
    );
  });

  it('ignores "#" lines inside code fences', () => {
    const sections = splitSections('## Real\n\n```bash\n## not a heading\n```', 'Page');
    assert.equal(sections.length, 1);
    assert.match(sections[0]!.body, /## not a heading/);
  });
});

describe('chunkDocument', () => {
  it('prefixes chunks with title and heading and records metadata', () => {
    const [chunk] = chunkDocument(doc('## Install\n\nRun the installer.'));
    assert.ok(chunk);
    assert.equal(chunk.content, '# Test Page > Install\n\nRun the installer.');
    assert.equal(chunk.heading, 'Install');
    assert.equal(chunk.slug, 'guides/test');
    assert.equal(chunk.url, 'https://docs.example.com/docs/guides/test');
    assert.match(chunk.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(chunk.hasCode, false);
  });

  it('keeps every chunk within the token budget and overlaps consecutive chunks', () => {
    const body = Array.from({ length: 120 }, (_, i) => sentence(i)).join('\n\n');
    const chunks = chunkDocument(doc(`## Long\n\n${body}`), { maxTokens: 512, overlapTokens: 64 });
    assert.ok(chunks.length > 1, 'section is split');
    for (const chunk of chunks) assert.ok(chunk.tokenCount <= 512, `chunk has ${chunk.tokenCount} tokens`);
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1]!.content.slice(-40);
      assert.ok(chunks[i]!.content.includes(prevTail.trim().split(' ').slice(-3).join(' ')), 'overlap carried');
    }
  });

  it('hard-splits a single oversized block', () => {
    const giant = 'word '.repeat(3000);
    const chunks = chunkDocument(doc(giant), { maxTokens: 256, overlapTokens: 32 });
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(countTokens(chunk.content) <= 256 + 2);
  });

  it('keeps fenced code intact and flags it', () => {
    const chunks = chunkDocument(doc('## Code\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```'));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.hasCode, true);
    assert.match(chunks[0]!.content, /const a = 1;\n\nconst b = 2;/);
  });

  it('is deterministic: same input gives same ids', () => {
    const content = '## A\n\nOne\n\n## B\n\nTwo';
    assert.deepEqual(
      chunkDocument(doc(content)).map((c) => c.id),
      chunkDocument(doc(content)).map((c) => c.id),
    );
  });
});
