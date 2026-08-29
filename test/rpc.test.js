// Latency behaviour of the RPC quorum.
//
// Regression test for the bug that made every gas-price call take ~5s: the old
// implementation used Promise.allSettled, so one hanging public node delayed a
// response that Alchemy had already answered in ~300ms.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as rpc from '../src/rpc.js';

const realFetch = globalThis.fetch;
afterEach(() => rpc.setFetch(realFetch));

/** fake transport: per-host latency, or `null` to hang forever */
function transport(latencyByHost) {
  return (url, opts) => {
    const host = new URL(url).host;
    const spec = latencyByHost[host];
    if (spec === undefined || spec === null) {
      // hangs until the AbortSignal fires, like a dead endpoint
      return new Promise((_, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      });
    }
    const { ms, value } = spec;
    return new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: value }) }), ms);
    });
  };
}

const RPCS = [
  'https://fast.example',   // stands in for Alchemy
  'https://slow.example',
  'https://dead.example'
];

test('one fast RPC is not held back by two hanging ones', async () => {
  rpc.setFetch(transport({
    'fast.example': { ms: 20, value: '0x3b9aca00' } // 1 gwei
    // slow + dead hang until abort
  }));

  const started = Date.now();
  const { median, samples } = await rpc.rpcMedianBigInt(RPCS, 'eth_gasPrice', [], {
    softDeadlineMs: 100,
    lastResortMs: 300
  });
  const elapsed = Date.now() - started;

  assert.equal(median, 1_000_000_000n);
  assert.equal(samples.length, 1);
  // The old allSettled version waited out the full RPC timeout here.
  assert.ok(elapsed < 900, `should return by the last-resort deadline, took ${elapsed}ms`);
});

test('a lone answer waits for the last-resort deadline, not the soft one', async () => {
  // Only one endpoint responds, so there is nothing to corroborate against.
  // We prefer to keep waiting a little rather than publish an uncorroborated
  // number the instant the soft deadline passes.
  rpc.setFetch(transport({ 'fast.example': { ms: 10, value: '0x3b9aca00' } }));

  const started = Date.now();
  const { samples } = await rpc.rpcMedianBigInt(RPCS, 'eth_gasPrice', [], {
    softDeadlineMs: 100,
    lastResortMs: 400
  });
  const elapsed = Date.now() - started;

  assert.equal(samples.length, 1);
  assert.ok(elapsed >= 350, `should not return at the soft deadline with one sample, took ${elapsed}ms`);
});

test('two answers are enough to return at the soft deadline', async () => {
  rpc.setFetch(transport({
    'fast.example': { ms: 10, value: '0x3b9aca00' }, // 1 gwei
    'slow.example': { ms: 20, value: '0x77359400' }  // 2 gwei
    // dead.example hangs
  }));

  const started = Date.now();
  const { samples } = await rpc.rpcMedianBigInt(RPCS, 'eth_gasPrice', [], {
    softDeadlineMs: 120,
    lastResortMs: 5000
  });
  const elapsed = Date.now() - started;

  assert.equal(samples.length, 2);
  assert.ok(elapsed < 400, `two samples should release at the soft deadline, took ${elapsed}ms`);
});

test('a full quorum returns immediately, without waiting for the soft deadline', async () => {
  rpc.setFetch(transport({
    'fast.example': { ms: 5, value: '0x3b9aca00' },  // 1 gwei
    'slow.example': { ms: 10, value: '0x77359400' }, // 2 gwei
    'dead.example': { ms: 15, value: '0x59682f00' }  // 1.5 gwei
  }));

  const started = Date.now();
  const { median, samples } = await rpc.rpcMedianBigInt(RPCS, 'eth_gasPrice', [], {
    softDeadlineMs: 5000 // deliberately long: a full quorum must not wait for it
  });
  const elapsed = Date.now() - started;

  assert.equal(samples.length, 3);
  assert.equal(median, 1_500_000_000n, 'median of 1, 1.5 and 2 gwei');
  assert.ok(elapsed < 500, `full quorum should short-circuit, took ${elapsed}ms`);
});

test('median ignores a single lying endpoint', async () => {
  rpc.setFetch(transport({
    'fast.example': { ms: 5, value: '0x3b9aca00' },   // 1 gwei
    'slow.example': { ms: 5, value: '0x3b9aca00' },   // 1 gwei
    'dead.example': { ms: 5, value: '0x174876e800' }  // 100 gwei — the liar
  }));

  const { median } = await rpc.rpcMedianBigInt(RPCS, 'eth_gasPrice', []);
  assert.equal(median, 1_000_000_000n, 'the outlier must not move the answer');
});

test('rejects only when every endpoint fails', async () => {
  rpc.setFetch(transport({})); // all hang
  await assert.rejects(
    () => rpc.rpcMedianBigInt(RPCS, 'eth_gasPrice', [], { softDeadlineMs: 50 }),
    /All RPCs failed for eth_gasPrice/
  );
});

test('rpcFirst returns the first success and reports which endpoint answered', async () => {
  rpc.setFetch(transport({
    'slow.example': { ms: 5, value: '0xde0b6b3a7640000' }
  }));
  // fast.example hangs, so it should fall through to slow.example
  const { result, source } = await rpc.rpcFirst(
    ['https://fast.example', 'https://slow.example'],
    'eth_getBalance',
    []
  );
  assert.equal(result, '0xde0b6b3a7640000');
  assert.equal(source, 'https://slow.example');
});

test('rpcFirst hedges: a slow first endpoint does not delay a fast second', async () => {
  rpc.setFetch(transport({
    // fast.example hangs entirely
    'slow.example': { ms: 30, value: '0xde0b6b3a7640000' }
  }));

  const started = Date.now();
  const { source } = await rpc.rpcFirst(
    ['https://fast.example', 'https://slow.example'],
    'eth_getBalance',
    [],
    { hedgeDelayMs: 80 }
  );
  const elapsed = Date.now() - started;

  assert.equal(source, 'https://slow.example');
  // Sequential fallback would have waited out fast.example's full timeout.
  assert.ok(elapsed < 700, `hedge should fire quickly, took ${elapsed}ms`);
});

test('rpcFirst respects a per-call timeout override', async () => {
  rpc.setFetch(transport({})); // everything hangs
  const started = Date.now();
  await assert.rejects(
    () => rpc.rpcFirst(['https://fast.example'], 'eth_gasPrice', [], { timeoutMs: 120 }),
    /All RPCs failed/
  );
  assert.ok(Date.now() - started < 900, 'should give up at the override, not the default timeout');
});

// --- credential redaction ---
// SECURITY regression: sources and error text are returned in HTTP responses,
// so an unredacted RPC URL publishes the API key to every caller.

test('redactUrl masks credentials but keeps public provenance', () => {
  const { redactUrl } = rpc;
  const secret = 'alch_TESTKEYNOTREAL0000000';

  assert.equal(
    redactUrl(`https://eth-mainnet.g.alchemy.com/v2/${secret}`),
    'https://eth-mainnet.g.alchemy.com/v2/***'
  );
  assert.ok(!redactUrl(`https://x.g.alchemy.com/v2/${secret}`).includes(secret));
  assert.ok(redactUrl('https://api.etherscan.io/v2/api?apikey=ABCDEF1234567890').includes('apikey=***'));

  // public identifiers must survive — sources are useful provenance
  const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  assert.ok(redactUrl(`https://eth.blockscout.com/api/v2/tokens/${token}`).includes(token));
  assert.ok(redactUrl('https://coins.llama.fi/prices/current/coingecko:ethereum').includes('coingecko:ethereum'));
  assert.ok(redactUrl('https://api.llama.fi/tvl/aave').includes('aave'));

  assert.equal(redactUrl('not a url'), '[redacted]');
});

test('no API key reaches samples or error text', async () => {
  const secret = 'alch_TESTKEYNOTREAL0000000';
  const keyed = `https://eth-mainnet.g.alchemy.com/v2/${secret}`;

  // success path: the answering endpoint appears in `samples`
  rpc.setFetch(transport({ 'eth-mainnet.g.alchemy.com': { ms: 5, value: '0x3b9aca00' } }));
  const { samples } = await rpc.rpcMedianBigInt([keyed], 'eth_gasPrice', [], {
    softDeadlineMs: 50,
    lastResortMs: 100
  });
  assert.ok(samples.length > 0);
  assert.ok(
    !JSON.stringify(samples).includes(secret),
    'the API key must never appear in a successful response'
  );

  // failure path: the endpoint appears in the error message
  rpc.setFetch(transport({}));
  await assert.rejects(
    () => rpc.rpcFirst([keyed], 'eth_gasPrice', [], { timeoutMs: 60 }),
    (e) => {
      assert.ok(!e.message.includes(secret), 'the API key must never appear in an error');
      return true;
    }
  );
});
