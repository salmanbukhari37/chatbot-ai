import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import { rateLimit, type HitCounter } from '../src/middleware/rate-limit';
import type { AppEnv } from '../src/types';

const MINUTE = 60_000;

/** In-memory stand-in for the Postgres counter, with the same reset-on-newer-window semantics. */
function memoryCounter(): HitCounter {
  const rows = new Map<string, { count: number; resetAt: number }>();
  return (key, resetAt) => {
    const row = rows.get(key);
    const next =
      !row || row.resetAt < resetAt.getTime()
        ? { count: 1, resetAt: resetAt.getTime() }
        : { count: row.count + 1, resetAt: row.resetAt };
    rows.set(key, next);
    return Promise.resolve(next.count);
  };
}

function appWith(counter: HitCounter, limit = 2) {
  const app = new Hono<AppEnv>();
  app.use(
    '*',
    rateLimit({
      name: 'test',
      windowMs: MINUTE,
      limit: () => limit,
      key: (c) => c.req.header('X-Client') ?? undefined,
      counter,
    }),
  );
  app.get('/', (c) => c.text('ok'));
  return app;
}

const get = (app: Hono<AppEnv>, client?: string) => app.request('/', { headers: client ? { 'X-Client': client } : {} });

describe('rateLimit', () => {
  it('allows up to the limit, then answers 429 with Retry-After', async () => {
    const app = appWith(memoryCounter());
    const first = await get(app, 'a');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('RateLimit-Policy'), '2;w=60');
    assert.match(first.headers.get('RateLimit') ?? '', /^limit=2, remaining=1, reset=\d+$/);
    assert.equal((await get(app, 'a')).status, 200);

    const blocked = await get(app, 'a');
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), {
      error: 'rate_limited',
      message: 'Too many requests, please slow down.',
    });
    assert.match(blocked.headers.get('RateLimit') ?? '', /remaining=0/);
    const retryAfter = Number(blocked.headers.get('Retry-After'));
    assert.ok(retryAfter >= 1 && retryAfter <= 60);
  });

  it('counts each identity separately and namespaces keys by limiter name', async () => {
    const keys: string[] = [];
    const counter = memoryCounter();
    const app = appWith(async (key, resetAt) => {
      keys.push(key);
      return counter(key, resetAt);
    }, 1);
    assert.equal((await get(app, 'a')).status, 200);
    assert.equal((await get(app, 'b')).status, 200);
    assert.equal((await get(app, 'a')).status, 429);
    assert.deepEqual(keys, ['test:a', 'test:b', 'test:a']);
  });

  it('passes the end of the current window as the reset time', async () => {
    let seen: Date | undefined;
    const app = appWith((_key, resetAt) => {
      seen = resetAt;
      return Promise.resolve(1);
    });
    const before = Date.now();
    await get(app, 'a');
    assert.ok(seen);
    assert.equal(seen.getTime() % MINUTE, 0);
    assert.ok(seen.getTime() > before && seen.getTime() <= before + MINUTE);
  });

  it('skips limiting when the key is undefined', async () => {
    let calls = 0;
    const app = appWith(() => {
      calls += 1;
      return Promise.resolve(99);
    });
    const res = await get(app);
    assert.equal(res.status, 200);
    assert.equal(calls, 0);
    assert.equal(res.headers.get('RateLimit'), null);
  });

  it('fails open when the counter throws', async () => {
    const app = appWith(() => Promise.reject(new Error('connection refused')));
    const res = await get(app, 'a');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(res.headers.get('RateLimit'), null);
  });
});
