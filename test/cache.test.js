// Cache tests run with caching force-enabled (the handler tests keep it off
// so their assertions stay deterministic).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.CACHE_DISABLED = '0';

const { cacheGet, cacheSet, cacheClear, withCache, cacheStats } = await import('../src/cache.js');

beforeEach(() => cacheClear());

test('cache is enabled outside of test env', () => {
  assert.equal(cacheStats().enabled, true);
});

test('set/get round trip and TTL expiry', async () => {
  cacheSet('k', { ok: true, v: 1 }, 50);
  assert.deepEqual(cacheGet('k'), { ok: true, v: 1 });
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(cacheGet('k'), undefined, 'entry should expire');
});

test('withCache calls the producer once, then serves cached with cached:true', async () => {
  let calls = 0;
  const produce = async () => {
    calls += 1;
    return { ok: true, value: calls };
  };

  const first = await withCache('key', 1000, produce);
  const second = await withCache('key', 1000, produce);

  assert.equal(calls, 1, 'producer should run once');
  assert.equal(first.cached, undefined, 'first call is live');
  assert.equal(second.cached, true, 'second call is served from cache');
  assert.equal(second.value, 1);
});

test('failures are never cached', async () => {
  let calls = 0;
  const produce = async () => {
    calls += 1;
    return { ok: false, error: 'upstream down' };
  };
  await withCache('bad', 1000, produce);
  await withCache('bad', 1000, produce);
  assert.equal(calls, 2, 'a failed answer must not stick in cache');
});

test('__noCache opts an entry out (e.g. a pending tx)', async () => {
  let calls = 0;
  const produce = async () => {
    calls += 1;
    return { ok: true, status: 'pending', __noCache: true };
  };
  const first = await withCache('pending', 1000, produce);
  await withCache('pending', 1000, produce);
  assert.equal(calls, 2, 'pending results must be re-fetched');
  assert.equal(first.__noCache, undefined, 'internal flag is stripped from the response');
});
