// Offline unit tests: all upstream HTTP is stubbed, so these run anywhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

import { buildServer, INTENTS } from '../src/server.js';
import * as rpc from '../src/rpc.js';
import * as tokenHolders from '../src/handlers/tokenHolders.js';
import * as tvl from '../src/handlers/tvl.js';
import * as cryptoPrice from '../src/handlers/cryptoPrice.js';
import { SUPPORTED_CHAIN_KEYS } from '../src/chains.js';

// ---- fake upstream ----
const json = (obj) => ({
  ok: true,
  status: 200,
  json: async () => obj
});

function fakeFetch(url, opts = {}) {
  const u = String(url);

  // JSON-RPC
  if (opts.method === 'POST' && opts.body) {
    const req = JSON.parse(opts.body);
    const respond = (result) => Promise.resolve(json({ jsonrpc: '2.0', id: 1, result }));
    switch (req.method) {
      case 'eth_gasPrice':
        // different per-endpoint values to prove median logic
        if (u.includes('publicnode')) return respond('0x3b9aca00'); // 1 gwei
        if (u.includes('llamarpc')) return respond('0x77359400'); // 2 gwei
        return respond('0x59682f00'); // 1.5 gwei
      case 'eth_feeHistory':
        return respond({
          baseFeePerGas: ['0x3b9aca00', '0x3b9aca01'],
          reward: [['0x5f5e100'], ['0x5f5e100']]
        });
      case 'eth_getBalance':
        return respond('0xde0b6b3a7640000'); // 1 ETH
      case 'eth_call': {
        const data = req.params[0].data;
        if (data.startsWith('0x70a08231')) return respond('0x' + (2_500_000n).toString(16).padStart(64, '0'));
        if (data === '0x313ce567') return respond('0x' + (6n).toString(16).padStart(64, '0'));
        if (data === '0x95d89b41') {
          // ABI string "USDC"
          const s = Buffer.from('USDC').toString('hex').padEnd(64, '0');
          return respond('0x' + '20'.padStart(64, '0') + '4'.padStart(64, '0') + s);
        }
        return respond('0x');
      }
      case 'eth_getTransactionByHash':
        return respond({
          hash: req.params[0],
          blockNumber: '0xf4240',
          from: '0x' + 'a'.repeat(40),
          to: '0x' + 'b'.repeat(40),
          value: '0xde0b6b3a7640000',
          nonce: '0x5',
          input: '0xa9059cbb' + '0'.repeat(128)
        });
      case 'eth_getTransactionReceipt': {
        // hash 0xdd...dd simulates a pre-Byzantium receipt (no status field)
        const preByzantium = req.params[0] === '0x' + 'd'.repeat(64);
        return respond({
          ...(preByzantium ? { root: '0x' + 'e'.repeat(64) } : { status: '0x1' }),
          gasUsed: '0x5208',
          effectiveGasPrice: '0x3b9aca00',
          logs: [{}, {}],
          contractAddress: null
        });
      }
      default:
        return Promise.resolve(json({ jsonrpc: '2.0', id: 1, error: { message: 'unsupported' } }));
    }
  }

  // Blockscout
  if (u.includes('blockscout.com/api/v2/tokens/')) {
    return Promise.resolve(
      json({ name: 'USD Coin', symbol: 'USDC', holders_count: '3141592', total_supply: '1000' })
    );
  }
  // DefiLlama TVL
  if (u.includes('/tvl/aave')) return Promise.resolve(json(21_000_000_000));
  if (u.includes('/v2/chains')) {
    return Promise.resolve(json([{ name: 'Base', tvl: 3_500_000_000, tokenSymbol: 'ETH' }]));
  }
  // DefiLlama coins (prices)
  if (u.includes('coins.llama.fi/prices/current/coingecko:ethereum')) {
    return Promise.resolve(
      json({ coins: { 'coingecko:ethereum': { price: 3000, symbol: 'ETH', confidence: 0.99 } } })
    );
  }
  if (u.includes('coins.llama.fi/prices/current/ethereum:0x')) {
    const id = u.split('/current/')[1];
    return Promise.resolve(json({ coins: { [id]: { price: 1.0001, symbol: 'USDC', confidence: 0.98 } } }));
  }
  // Coinbase
  if (u.includes('api.coinbase.com')) {
    return Promise.resolve(json({ data: { amount: '3010.00', base: 'ETH', currency: 'USD' } }));
  }
  // Binance
  if (u.includes('api.binance.com')) {
    return Promise.resolve(json({ symbol: 'ETHUSDT', price: '3020.00' }));
  }

  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
}

let app;
before(async () => {
  rpc.setFetch(fakeFetch);
  tokenHolders.setFetch(fakeFetch);
  tvl.setFetch(fakeFetch);
  cryptoPrice.setFetch(fakeFetch);
  app = buildServer();
  await app.ready();
});
after(async () => app.close());

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

test('gas_price returns the median of the RPC quorum', async () => {
  const res = await app.inject({ url: '/v1/gas-price?chain=ethereum' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.intent, 'GAS_PRICE');
  assert.equal(body.data.gas_price_gwei, 1.5); // median of 1, 1.5, 2
  assert.ok(body.data.quorum_size >= 2);
  assert.ok(body.sources.length >= 2);
});

test('wallet_balance_check native', async () => {
  const res = await app.inject({ url: `/v1/wallet-balance?chain=ethereum&address=${VITALIK}` });
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.balance, 1);
  assert.equal(body.data.asset, 'ETH');
});

test('wallet_balance_check ERC-20 uses token decimals + symbol', async () => {
  const res = await app.inject({
    url: `/v1/wallet-balance?chain=ethereum&address=${VITALIK}&token=${USDC}`
  });
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.decimals, 6);
  assert.equal(body.data.symbol, 'USDC');
  assert.equal(body.data.balance, 2.5); // 2_500_000 raw at 6dp
});

test('token_holder_count via Blockscout', async () => {
  const res = await app.inject({ url: `/v1/token-holders?chain=ethereum&token=${USDC}` });
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.holder_count, 3141592);
  assert.equal(body.data.symbol, 'USDC');
});

test('tvl_lookup protocol + chain', async () => {
  let body = (await app.inject({ url: '/v1/tvl?protocol=aave' })).json();
  assert.equal(body.ok, true);
  assert.equal(body.data.tvl_usd, 21_000_000_000);

  body = (await app.inject({ url: '/v1/tvl?chain=base' })).json();
  assert.equal(body.ok, true);
  assert.equal(body.data.chain, 'Base');
});

test('onchain_tx_lookup computes fee and status', async () => {
  const hash = '0x' + 'c'.repeat(64);
  const body = (await app.inject({ url: `/v1/tx?chain=ethereum&hash=${hash}` })).json();
  assert.equal(body.ok, true);
  assert.equal(body.data.status, 'success');
  assert.equal(body.data.value, 1);
  assert.equal(body.data.gas_used, '21000');
  assert.equal(body.data.tx_fee, 0.000021); // 21000 * 1 gwei
  assert.equal(body.data.method_selector, '0xa9059cbb');
  assert.equal(body.data.logs_count, 2);
});

test('onchain_tx_lookup treats pre-Byzantium receipts (no status field) as success', async () => {
  const hash = '0x' + 'd'.repeat(64);
  const body = (await app.inject({ url: `/v1/tx?chain=ethereum&hash=${hash}` })).json();
  assert.equal(body.ok, true);
  assert.equal(body.data.status, 'success');
});

test('crypto_price medians three venues and reports spread', async () => {
  const body = (await app.inject({ url: '/v1/price?symbol=eth' })).json();
  assert.equal(body.ok, true);
  assert.equal(body.intent, 'CRYPTO_PRICE');
  assert.equal(body.data.source_count, 3);
  assert.equal(body.data.price_usd, 3010); // median of 3000, 3010, 3020
  assert.ok(body.data.spread_pct > 0);
  assert.equal(body.data.quotes.length, 3);
});

test('crypto_price degrades confidence when venues disagree', async () => {
  // 3000 / 3010 / 3020 -> ~0.66% spread, above the 0.5% full-confidence band
  const body = (await app.inject({ url: '/v1/price?symbol=eth' })).json();
  assert.ok(body.confidence < 1, `expected reduced confidence, got ${body.confidence}`);
  assert.ok(body.confidence >= 0.5);
});

test('crypto_price by token address', async () => {
  const body = (await app.inject({ url: `/v1/price?chain=ethereum&token=${USDC}` })).json();
  assert.equal(body.ok, true);
  assert.equal(body.data.symbol, 'USDC');
  assert.equal(body.data.price_usd, 1.0001);
});

test('every intent normalizes a primary_value for on-chain extraction', async () => {
  const urls = [
    '/v1/gas-price?chain=ethereum',
    `/v1/wallet-balance?chain=ethereum&address=${VITALIK}`,
    `/v1/token-holders?chain=ethereum&token=${USDC}`,
    '/v1/tvl?protocol=aave',
    `/v1/tx?chain=ethereum&hash=0x${'c'.repeat(64)}`,
    '/v1/price?symbol=eth'
  ];
  assert.equal(urls.length, INTENTS.length, 'one URL per declared intent');
  for (const url of urls) {
    const body = (await app.inject({ url })).json();
    assert.equal(body.ok, true, url);
    assert.equal(typeof body.data.primary_value, 'string', `${url} -> primary_value must be a string`);
    assert.ok(body.data.primary_value.length > 0, `${url} -> primary_value must not be empty`);
  }
});

test('all 10 chains resolve and are reachable via the gas-price route', async () => {
  assert.equal(SUPPORTED_CHAIN_KEYS.length, 10);
  for (const key of SUPPORTED_CHAIN_KEYS) {
    const res = await app.inject({ url: `/v1/gas-price?chain=${key}` });
    assert.equal(res.statusCode, 200, `${key} should resolve`);
  }
});

test('chain aliases resolve (matic -> polygon, avax -> avalanche, chain id)', async () => {
  for (const [alias, expected] of [['matic', 'polygon'], ['avax', 'avalanche'], ['8453', 'base']]) {
    const body = (await app.inject({ url: `/v1/gas-price?chain=${alias}` })).json();
    assert.equal(body.data.chain, expected);
  }
});

test('input validation: bad chain / address / hash', async () => {
  assert.equal((await app.inject({ url: '/v1/gas-price?chain=dogechain' })).statusCode, 400);
  assert.equal(
    (await app.inject({ url: '/v1/wallet-balance?chain=ethereum&address=nope' })).statusCode,
    400
  );
  assert.equal((await app.inject({ url: '/v1/tx?chain=ethereum&hash=0x123' })).statusCode, 400);
  assert.equal((await app.inject({ url: '/v1/tvl' })).statusCode, 400);
  assert.equal((await app.inject({ url: '/v1/price' })).statusCode, 400);
  assert.equal((await app.inject({ url: '/v1/price?token=nope' })).statusCode, 400);
});

test('health and index advertise all intents and chains', async () => {
  const health = (await app.inject({ url: '/health' })).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.intents, 6);
  assert.equal(health.chains, 10);

  const index = (await app.inject({ url: '/' })).json();
  assert.deepEqual(index.intents, INTENTS);
});

// --- natural-language routing: this is what validators actually send ---

test('/v1/ask answers a free-text gas question', async () => {
  const res = await app.inject({ url: '/v1/ask?query=' + encodeURIComponent('What is the gas price on Base right now?') });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.intent, 'GAS_PRICE');
  assert.equal(body.data.chain, 'base');
  assert.equal(body.resolved_via, 'extracted');
  assert.match(body.signal, /gwei/);
});

test('/v1/ask routes each intent from plain language', async () => {
  const cases = [
    ['What is the gas price on ethereum?', 'GAS_PRICE'],
    [`How much ETH does ${VITALIK} hold?`, 'WALLET_BALANCE_CHECK'],
    ['How many addresses hold USDC on ethereum?', 'TOKEN_HOLDER_COUNT'],
    ['What is the total value locked in aave?', 'TVL_LOOKUP'],
    [`Did transaction 0x${'c'.repeat(64)} succeed?`, 'ONCHAIN_TX_LOOKUP'],
    ['What is the price of ETH?', 'CRYPTO_PRICE']
  ];
  for (const [q, expected] of cases) {
    const body = (await app.inject({ url: '/v1/ask?query=' + encodeURIComponent(q) })).json();
    assert.equal(body.ok, true, `${q} -> ${JSON.stringify(body).slice(0, 160)}`);
    assert.equal(body.intent, expected, q);
    assert.ok(body.signal && body.signal.length > 0, `${q} must produce a signal`);
  }
});

test('/v1/ask resolves a token symbol to a contract for holder counts', async () => {
  const body = (await app.inject({
    url: '/v1/ask?query=' + encodeURIComponent('How many addresses hold USDC on ethereum?')
  })).json();
  assert.equal(body.data.token.toLowerCase(), USDC.toLowerCase());
  assert.equal(body.data.holder_count, 3141592);
});

test('/v1/ask returns 422 for an off-topic question, not a wrong answer', async () => {
  const res = await app.inject({ url: '/v1/ask?query=' + encodeURIComponent('Will SpaceX open-source Cursor?') });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().ok, false);
});

test('/v1/ask accepts POST with a JSON body', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/ask',
    payload: { query: 'What is the price of BTC?' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().intent, 'CRYPTO_PRICE');
});

test('intent endpoints accept ?query= as well as explicit params', async () => {
  const a = (await app.inject({ url: '/v1/gas-price?query=' + encodeURIComponent('gas on base') })).json();
  assert.equal(a.data.chain, 'base');
  const b = (await app.inject({ url: '/v1/tvl?query=' + encodeURIComponent("what is aave's tvl") })).json();
  assert.equal(b.data.protocol, 'aave');
});

test('every response carries a signal, checks and confidence', async () => {
  const urls = [
    '/v1/gas-price?chain=ethereum',
    `/v1/wallet-balance?chain=ethereum&address=${VITALIK}`,
    `/v1/token-holders?chain=ethereum&token=${USDC}`,
    '/v1/tvl?protocol=aave',
    `/v1/tx?chain=ethereum&hash=0x${'c'.repeat(64)}`,
    '/v1/price?symbol=eth'
  ];
  for (const url of urls) {
    const b = (await app.inject({ url })).json();
    assert.equal(typeof b.signal, 'string', `${url} signal`);
    assert.ok(b.signal.length > 10, `${url} signal too short`);
    assert.equal(typeof b.confidence, 'number', `${url} confidence`);
    assert.ok(b.checks_total > 0, `${url} checks`);
    assert.equal(b.status, 'ok');
  }
});

test('unparseable questions fail with a hint rather than a wrong answer', async () => {
  const res = await app.inject({ url: '/v1/wallet-balance?query=' + encodeURIComponent('how much does alice have') });
  assert.equal(res.statusCode, 400);
  const b = res.json();
  assert.equal(b.ok, false);
  assert.ok(b.hint, 'should tell the caller what was missing');
});

test('formatUnits edge cases', () => {
  assert.equal(rpc.formatUnits(0n, 18), '0');
  assert.equal(rpc.formatUnits(1n, 18), '0.000000000000000001');
  assert.equal(rpc.formatUnits(1500000000n, 9), '1.5');
});
