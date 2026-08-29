// Natural-language question parsing.
//
// WHY THIS EXISTS: Telegraph validators route free-text questions to miners
// ("What is the gas price on Base right now?"), not tidy query strings. A miner
// that only accepts ?chain=base returns nothing useful and scores ~0 — which is
// exactly what the public leaderboard shows for most on-chain miners.
//
// So every endpoint accepts BOTH: explicit params when given, and a `query`
// string otherwise. This module turns the question into an intent + params.

import { CHAINS } from './chains.js';

const ADDRESS_RE = /0x[0-9a-fA-F]{40}\b/;
const TXHASH_RE = /0x[0-9a-fA-F]{64}\b/;

// Chain words -> canonical chain key. Built from the registry so adding a chain
// in chains.js automatically teaches the parser about it.
const CHAIN_WORDS = (() => {
  const m = new Map();
  for (const [key, cfg] of Object.entries(CHAINS)) {
    m.set(key, key);
    for (const a of cfg.aliases) m.set(a, key);
  }
  // extra spellings the registry doesn't carry
  m.set('ethereum mainnet', 'ethereum');
  m.set('eth mainnet', 'ethereum');
  m.set('binance smart chain', 'bsc');
  m.set('bnb chain', 'bsc');
  m.set('arbitrum one', 'arbitrum');
  m.set('op mainnet', 'optimism');
  m.set('avalanche c-chain', 'avalanche');
  m.set('gnosis chain', 'gnosis');
  m.set('xdai', 'gnosis');
  m.set('polygon pos', 'polygon');
  return m;
})();

// Ticker symbols we can price. Kept separate from chain words because "eth"
// is both a chain and an asset — context decides which.
const SYMBOLS = new Set([
  'btc', 'bitcoin', 'eth', 'ether', 'ethereum', 'weth', 'wbtc', 'sol', 'solana',
  'bnb', 'pol', 'matic', 'avax', 'arb', 'op', 'usdc', 'usdt', 'dai', 'link',
  'uni', 'aave', 'ldo', 'mkr', 'crv', 'steth', 'wsteth', 'xdai', 'doge', 'ada',
  'xrp', 'ltc', 'dot', 'atom', 'near', 'apt', 'sui', 'ton', 'trx', 'shib', 'pepe'
]);

const SYMBOL_ALIASES = {
  bitcoin: 'btc',
  ether: 'eth',
  solana: 'sol'
};

// DefiLlama protocol slugs seen in TVL questions. Unknown words still pass
// through as a slug guess — DefiLlama 404s cleanly if wrong.
const KNOWN_PROTOCOLS = new Set([
  'aave', 'uniswap', 'lido', 'curve', 'makerdao', 'sky', 'compound', 'pendle',
  'eigenlayer', 'ethena', 'morpho', 'spark', 'rocket-pool', 'frax', 'balancer',
  'sushi', 'sushiswap', 'gmx', 'aerodrome', 'velodrome', 'jupiter', 'raydium',
  'convex-finance', 'yearn-finance', 'instadapp', 'venus', 'radiant', 'benqi'
]);

const norm = (s) => String(s || '').toLowerCase().trim();

/** Find a chain mentioned in the text. Longest match wins ("bnb chain" > "bnb"). */
export function extractChain(text) {
  const t = ` ${norm(text).replace(/[^\w\s-]/g, ' ')} `;
  let best = null;
  for (const [word, key] of CHAIN_WORDS) {
    if (t.includes(` ${word} `) && (!best || word.length > best.word.length)) {
      best = { word, key };
    }
  }
  return best ? best.key : null;
}

/** Find a ticker symbol. Skips words that are clearly being used as a chain. */
export function extractSymbol(text) {
  const t = norm(text);
  // "price of X" / "X price" / "how much is X" are strong positional hints
  const positional =
    t.match(/(?:price of|worth of|value of|how much is|how much does)\s+(?:a\s+|one\s+|1\s+)?([a-z]{2,10})\b/) ||
    t.match(/\b([a-z]{2,10})\s+(?:price|is worth|worth|trading at)/);
  if (positional) {
    const c = positional[1];
    if (SYMBOLS.has(c)) return SYMBOL_ALIASES[c] || c;
  }
  const words = t.replace(/[^\w\s]/g, ' ').split(/\s+/);
  for (const w of words) {
    if (SYMBOLS.has(w)) return SYMBOL_ALIASES[w] || w;
  }
  return null;
}

/** Find a DeFi protocol slug in a TVL question. */
export function extractProtocol(text) {
  const t = norm(text).replace(/[^\w\s-]/g, ' ');
  const words = t.split(/\s+/);
  for (const w of words) {
    if (KNOWN_PROTOCOLS.has(w)) return w;
  }
  // "tvl of <word>" / "<word> tvl" / "locked in <word>"
  const m =
    t.match(/(?:tvl (?:of|in|for)|locked in|value locked in)\s+([a-z0-9-]{3,30})/) ||
    t.match(/\b([a-z0-9-]{3,30})(?:'s)?\s+tvl\b/);
  if (m) {
    const cand = m[1];
    if (!CHAIN_WORDS.has(cand) && !['the', 'protocol', 'defi'].includes(cand)) return cand;
  }
  return null;
}

export const extractAddress = (text) => (String(text || '').match(ADDRESS_RE) || [null])[0];
export const extractTxHash = (text) => (String(text || '').match(TXHASH_RE) || [null])[0];

/**
 * Classify a free-text question into one of our six intents.
 * Order matters: the most specific signals are checked first.
 */
export function classify(text) {
  const t = norm(text);

  // A 64-hex hash is unambiguous.
  if (TXHASH_RE.test(text || '')) return 'ONCHAIN_TX_LOOKUP';

  if (/\bholders?\b|holder count|how many (?:distinct )?(?:addresses|wallets|people)\s+(?:hold|own)/.test(t)) {
    return 'TOKEN_HOLDER_COUNT';
  }
  // "total value locked", "value locked", and looser phrasings like
  // "how much value is locked in lido" / "how much is locked in aave"
  if (/\btvl\b|total value locked|value locked|\blocked in\b|\bis locked\b/.test(t)) {
    return 'TVL_LOOKUP';
  }
  if (/\bgas\b|gas price|gas fee|transaction fee|network fee|how much.*(?:to send|to transact)|base ?fee|gwei/.test(t)) {
    return 'GAS_PRICE';
  }
  if (/\bbalance\b|how much .*(?:does|do) .*(?:hold|have)|holdings of|how much is in/.test(t) || ADDRESS_RE.test(text || '')) {
    // an address with no other signal is a balance question
    return 'WALLET_BALANCE_CHECK';
  }
  if (/\bprice\b|worth|trading at|how much is|market value|usd value|\bcost\b/.test(t)) {
    return 'CRYPTO_PRICE';
  }
  return null;
}

/**
 * Parse a question into {intent, params, resolved_via}.
 * `explicit` params always win over anything extracted from the text.
 */
export function parseQuestion(query, explicit = {}) {
  const intent = classify(query);
  const chain = explicit.chain || extractChain(query);
  const address = explicit.address || extractAddress(query);
  const hash = explicit.hash || extractTxHash(query);
  const symbol = explicit.symbol || extractSymbol(query);
  const protocol = explicit.protocol || extractProtocol(query);

  // A 40-hex address in a holders/price question is a token, not a wallet.
  const token =
    explicit.token ||
    (intent === 'TOKEN_HOLDER_COUNT' || intent === 'CRYPTO_PRICE' ? address : null);

  return {
    intent,
    resolved_via: Object.keys(explicit).some((k) => explicit[k]) ? 'params' : 'extracted',
    params: { chain, address, hash, symbol, protocol, token }
  };
}
