import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkDocument, DEFAULT_CHUNKER_OPTIONS } from '../src/ingestion/chunker';
import { parseMarkdown } from '../src/ingestion/parsers/markdown';
import { buildUrl, sectionFromSlug } from '../src/ingestion/utils';
import { IngestRequestSchema } from '../src/routes/ingest';
import { portalFilter } from '../src/db/typesense';
import { normaliseOrigin } from '../src/services/portals';
import { selectSources } from '../src/services/rag';

const upload = (path: string) => ({ files: [{ path, content: '# Hi' }] });

describe('ingest upload validation', () => {
  it('accepts relative md/mdx/html paths and defaults prune to true', () => {
    const parsed = IngestRequestSchema.safeParse({
      files: [
        { path: 'guides/intro.md', content: '# Intro' },
        { path: 'content/quickstart.mdx', content: '# Q' },
        { path: 'api/payments/users/get-user.md', content: '# Get user' },
      ],
    });
    assert.ok(parsed.success);
    assert.equal(parsed.data.prune, true);
    assert.equal(parsed.data.force, false);
  });

  for (const bad of [
    '../secrets.md',
    'guides/../../x.md',
    '/etc/passwd.md',
    'C:/x.md',
    'guides\\x.md',
    'guides//x.md',
    './x.md',
    'x.txt',
    'x.md\u0000.png',
  ]) {
    it(`rejects path ${JSON.stringify(bad)}`, () => {
      assert.equal(IngestRequestSchema.safeParse(upload(bad)).success, false);
    });
  }

  it('rejects duplicate paths and unknown fields', () => {
    assert.equal(
      IngestRequestSchema.safeParse({
        files: [
          { path: 'a.md', content: '' },
          { path: 'a.md', content: '' },
        ],
      }).success,
      false,
    );
    assert.equal(IngestRequestSchema.safeParse({ ...upload('a.md'), portalId: 'prt_other' }).success, false);
  });
});

describe('portal scoping helpers', () => {
  it('every Typesense filter starts with the portal clause', () => {
    assert.equal(portalFilter('prt_a'), 'portal_id:=`prt_a`');
    assert.equal(portalFilter('prt_a', 'has_code:=true'), 'portal_id:=`prt_a` && has_code:=true');
    assert.equal(portalFilter('prt_a` || portal_id:=`prt_b'), 'portal_id:=`prt_a || portal_id:=prt_b`');
  });

  it('identical content in two portals yields different chunk ids', () => {
    const doc = parseMarkdown({
      raw: '# Shared\n\n## Auth\n\nSame text.',
      relativePath: 'guides/auth.md',
      absolutePath: 'guides/auth.md',
      baseUrl: '',
      mtime: new Date(0),
    });
    const a = chunkDocument(doc, DEFAULT_CHUNKER_OPTIONS, 'prt_a').map((c) => c.id);
    const b = chunkDocument(doc, DEFAULT_CHUNKER_OPTIONS, 'prt_b').map((c) => c.id);
    assert.equal(a.length, b.length);
    assert.ok(a.every((id) => !b.includes(id)));
  });

  it('normalises origins and rejects non-http schemes', () => {
    assert.equal(normaliseOrigin('https://Docs.Example.com/path?q=1'), 'https://docs.example.com');
    assert.equal(normaliseOrigin('http://127.0.0.1:23513/'), 'http://127.0.0.1:23513');
    assert.throws(() => normaliseOrigin('javascript:alert(1)'));
    assert.throws(() => normaliseOrigin('not a url'));
  });
});

describe('portal content layout', () => {
  it('derives sections from the generated portal structure', () => {
    assert.equal(sectionFromSlug('index'), 'home');
    assert.equal(sectionFromSlug('guides/intro'), 'guides');
    assert.equal(sectionFromSlug('api/payments/users/get-user'), 'api/payments');
    assert.equal(sectionFromSlug('sdks/typescript'), 'sdks');
  });

  it('builds absolute URLs with a base URL and root-relative ones without', () => {
    assert.equal(buildUrl('https://example.com/docs', 'guides/intro'), 'https://example.com/docs/guides/intro');
    assert.equal(buildUrl('https://example.com/docs', ''), 'https://example.com/docs');
    assert.equal(buildUrl('', 'guides/intro'), '/guides/intro');
    assert.equal(buildUrl('', ''), '/');
  });
});

describe('selectSources', () => {
  const results = [
    { url: 'https://x/webhooks', title: 'Webhooks', slug: 'webhooks', content: '', score: 0.9 },
    { url: 'https://x/auth', title: 'Auth', slug: 'auth', content: '', score: 0.8 },
    { url: 'https://x/errors', title: 'Errors', slug: 'errors', content: '', score: 0.2 },
  ];

  it('returns only the pages the answer linked to, in citation order', () => {
    const answer = 'See [Auth](https://x/auth) and then [Webhooks](https://x/webhooks).';
    assert.deepEqual(
      selectSources(results, answer).map((s) => s.title),
      ['Auth', 'Webhooks'],
    );
  });

  it('falls back to clearly relevant results when nothing is cited', () => {
    assert.deepEqual(
      selectSources(results, 'No links here.').map((s) => s.title),
      ['Webhooks', 'Auth'],
    );
  });
});
