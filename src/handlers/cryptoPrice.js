// CRYPTO_PRICE intent
// GET /v1/price?symbol=eth                      -> multi-source median USD price
// GET /v1/price?chain=ethereum&token=0x...      -> token price by contract address
//
// Accuracy strategy: for symbols we query three independent venues in parallel
// (DefiLlama, Coinbase, Binance) and return the MEDIAN. A single exchange can
// be stale, wick, or halt; the median of three is materially harder to beat and
// is what should separate this miner from a naive single-API wrapper.
//
// The spread between sources is reported, and confidence degrades when the
// sources disagree — validators can see exactly how sure the answer is.

import { resolveChain, SUPPORTED_CHAIN_KEYS } from '../chains.js';
import { isAddress } from '../rpc.js';
import { ok, fail, fmtUsd } from '../envelope.js';
import { withCache } from '../cache.js';
import { parseQuestion } from '../nlq.js';

let fetchImpl = globalThis.fetch;
export function setFetch(fn) {
  fetchImpl = fn;
}

const TIMEOUT_MS = Number(process.env.PRICE_TIMEOUT_MS || 7000);
// Stop waiting once enough venues have answered — one slow exchange must not
// set the latency of the whole price lookup.
const SOFT_DEADLINE_MS = Number(process.env.PRICE_SOFT_DEADLINE_MS || 1500);
const CACHE_TTL_MS = Number(process.env.PRICE_CACHE_MS || 5000);

// Common symbols -> CoinGecko ids (DefiLlama's `coingecko:` namespace).
// Anything not listed still works via ?chain=&token=.
const SYMBOL_TO_GECKO = {
  btc: 'bitcoin',
  wbtc: 'wrapped-bitcoin',
  eth: 'ethereum',
  weth: 'weth',
  sol: 'solana',
  bnb: 'binancecoin',
  pol: 'polygon-ecosystem-token',
  matic: 'matic-network',
  avax: 'avalanche-2',
  arb: 'arbitrum',
  op: 'optimism',
  usdc: 'usd-coin',
  usdt: 'tether',
  dai: 'dai',
  link: 'chainlink',
  uni: 'uniswap',
  aave: 'aave',
  ldo: 'lido-dao',
  mkr: 'maker',
  crv: 'curve-dao-token',
  xdai: 'xdai',
  steth: 'staked-ether',
  wsteth: 'wrapped-steth'
};

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// --- individual venues; each resolves to {price, source} or throws ---

async function fromLlamaGecko(geckoId) {
  const url = `https://coins.llama.fi/prices/current/coingecko:${geckoId}`;
  const body = await getJson(url);
  const entry = body?.coins?.[`coingecko:${geckoId}`];
  if (!entry || typeof entry.price !== 'number') throw new Error('no price');
  return { price: entry.price, source: url };
}

async function fromCoinbase(symbol) {
  const url = `https://api.coinbase.com/v2/prices/${symbol.toUpperCase()}-USD/spot`;
  const body = await getJson(url);
  const amt = Number(body?.data?.amount);
  if (!Number.isFinite(amt)) throw new Error('no price');
  return { price: amt, source: url };
}

async function fromBinance(symbol) {
  // Binance quotes in USDT, which tracks USD closely; the median across
  // venues absorbs the small basis difference.
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}USDT`;
  const body = await getJson(url);
  const p = Number(body?.price);
  if (!Number.isFinite(p)) throw new Error('no price');
  return { price: p, source: url };
}

/**
 * Await several venue lookups, resolving as soon as `quorum` have succeeded or
 * the soft deadline passes with at least one answer. Rejected venues are simply
 * absent from the result. Never rejects — an empty array means nobody answered.
 */
function raceQuorum(promises, quorum, softDeadlineMs) {
  return new Promise((resolve) => {
    const good = [];
    let outstanding = promises.length;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(good);
    };

    const timer = setTimeout(() => {
      if (good.length > 0) finish();
    }, softDeadlineMs);

    for (const p of promises) {
      Promise.resolve(p)
        .then((v) => {
          good.push(v);
          if (good.length >= quorum) finish();
        })
        .catch(() => {})
        .finally(() => {
          outstanding -= 1;
          if (outstanding === 0) finish();
        });
    }
  });
}

const median = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export async function cryptoPrice(req, reply) {
  const startedAt = Date.now();
  const q = req.query.query || req.query.question || req.query.q;
  const parsed = parseQuestion(q, {
    symbol: req.query.symbol,
    token: req.query.token,
    chain: req.query.chain
  });
  const symbol = parsed.params.symbol;
  const token = req.query.token || parsed.params.token;
  const chainParam = parsed.params.chain;

  // --- token by contract address ---
  if (token) {
    if (!isAddress(token)) return fail(reply, 400, 'Invalid ?token=0x... address', 'CRYPTO_PRICE');
    const chain = resolveChain(chainParam || 'ethereum');
    if (!chain) {
      return fail(reply, 400, 'Could not determine a supported chain.', 'CRYPTO_PRICE',
        `Supported chains: ${SUPPORTED_CHAIN_KEYS.join(', ')}`);
    }
    const key = `price:${chain.key}:${token.toLowerCase()}`;
    try {
      return await withCache(key, CACHE_TTL_MS, async () => {
        const id = `${chain.llamaChainKey}:${token.toLowerCase()}`;
        const url = `https://coins.llama.fi/prices/current/${id}`;
        const body = await getJson(url);
        const entry = body?.coins?.[id];
        if (!entry || typeof entry.price !== 'number') {
          throw new Error(`No price found for ${token} on ${chain.key}`);
        }
        return ok(
          'CRYPTO_PRICE',
          {
            chain: chain.key,
            token,
            symbol: entry.symbol ?? null,
            price_usd: entry.price,
            source_count: 1
          },
          {
            signal: `${entry.symbol || token} is ${fmtUsd(entry.price)} USD`,
            sources: [url],
            startedAt,
            // DefiLlama publishes its own confidence for address lookups
            confidence: typeof entry.confidence === 'number' ? entry.confidence : 0.9,
            primaryValue: entry.price,
            resolvedVia: parsed.resolved_via,
            checks: { live: true, canonical: true, corroborated: false, quorum: false }
          }
        );
      });
    } catch (e) {
      return fail(reply, 502, e.message, 'CRYPTO_PRICE');
    }
  }

  // --- symbol: median of up to 3 venues ---
  if (!symbol) {
    return fail(reply, 400,
      `Could not determine an asset${q ? ' from the question' : ''}.`,
      'CRYPTO_PRICE', 'Provide ?symbol=eth, or ?chain=&token=0x... for long-tail tokens.');
  }
  const sym = String(symbol).toLowerCase().trim();
  const gecko = SYMBOL_TO_GECKO[sym];

  const key = `price:sym:${sym}`;
  try {
    return await withCache(key, CACHE_TTL_MS, async () => {
      const attempts = [
        gecko ? fromLlamaGecko(gecko) : Promise.reject(new Error('symbol not mapped')),
        fromCoinbase(sym),
        fromBinance(sym)
      ];
      const good = await raceQuorum(attempts, 3, SOFT_DEADLINE_MS);

      if (good.length === 0) {
        throw new Error(
          `No venue returned a price for "${sym}". Try ?chain=&token=0x... for long-tail tokens.`
        );
      }

      const prices = good.map((g) => g.price);
      const med = median(prices);
      const spread = prices.length > 1 ? (Math.max(...prices) - Math.min(...prices)) / med : 0;

      // Confidence drops as venues disagree: <0.5% spread is full confidence,
      // and a single surviving source is capped at 0.85.
      let confidence = good.length === 1 ? 0.85 : 1;
      if (spread > 0.005) confidence = Math.max(0.5, confidence - spread * 10);

      return ok(
        'CRYPTO_PRICE',
        {
          symbol: sym.toUpperCase(),
          price_usd: med,
          source_count: good.length,
          spread_pct: Number((spread * 100).toFixed(4)),
          quotes: good.map((g) => ({ price: g.price, source: new URL(g.source).host }))
        },
        {
          // venue count is provenance, not the answer — it lives in `data`
          signal: `${sym.toUpperCase()} is ${fmtUsd(med)} USD`,
          sources: good.map((g) => g.source),
          startedAt,
          confidence: Number(confidence.toFixed(3)),
          primaryValue: med,
          resolvedVia: parsed.resolved_via,
          checks: {
            live: true,
            canonical: true,
            corroborated: good.length >= 2,
            quorum: good.length >= 3
          }
        }
      );
    });
  } catch (e) {
    return fail(reply, 502, e.message, 'CRYPTO_PRICE');
  }
}
