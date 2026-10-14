import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterValue } from '../src/db/typesense';
import { safeEqual } from '../src/middleware/auth';
import { fuse } from '../src/services/retrieval';

describe('safeEqual', () => {
  it('compares strings of any length without throwing', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', 'x'), false);
  });
});

describe('filterValue', () => {
  it('backtick-quotes values and strips backticks so filters cannot be broken out of', () => {
    assert.equal(filterValue('guides/auth'), '`guides/auth`');
    assert.equal(filterValue('a` || slug:=`b'), '`a || slug:=b`');
  });
});

describe('fuse', () => {
  const hit = (id: string, slug: string, score: number) => ({
    id,
    portal_id: 'prt_test',
    slug,
    score,
    title: slug,
    heading: '',
    url: `https://x/${slug}`,
    content: id,
  });

  it('weights vector 0.6 / keyword 0.4 and dedupes by slug', () => {
    const fused = fuse(
      [hit('a1', 'a', 0.9), hit('b1', 'b', 0.5), hit('a2', 'a', 0.4)],
      [hit('b1', 'b', 20), hit('c1', 'c', 10)],
    );
    assert.deepEqual(
      fused.map((c) => c.slug),
      // a: 0.6 * 1 = 0.6; b: 0.6 * 0.2 + 0.4 * 1 = 0.52; c: lowest keyword hit normalises to 0
      ['a', 'b', 'c'],
    );
    const b = fused.find((c) => c.slug === 'b');
    assert.ok(b);
    // vector: (0.5 - 0.4) / (0.9 - 0.4) = 0.2; keyword: max → 1
    assert.ok(Math.abs(b.score - (0.6 * 0.2 + 0.4 * 1)) < 1e-9);
    assert.equal(new Set(fused.map((c) => c.slug)).size, fused.length);
  });

  it('works when one retriever returned nothing', () => {
    assert.deepEqual(
      fuse([], [hit('x', 'x', 5)]).map((c) => c.slug),
      ['x'],
    );
  });
});
