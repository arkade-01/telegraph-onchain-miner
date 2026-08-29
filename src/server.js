// Telegraph on-chain intelligence miner
// Serves 6 deterministic intents over plain HTTP; the Telegraph node handles
// x402 payment gating and routing, so this service stays a clean data API.

import Fastify from 'fastify';
import { gasPrice } from './handlers/gasPrice.js';
import { walletBalance } from './handlers/walletBalance.js';
import { tokenHolders } from './handlers/tokenHolders.js';
import { tvl } from './handlers/tvl.js';
import { txLookup } from './handlers/txLookup.js';
import { cryptoPrice } from './handlers/cryptoPrice.js';
import { ask } from './handlers/ask.js';
import { SUPPORTED_CHAIN_KEYS, USING_ALCHEMY } from './chains.js';
import { cacheStats } from './cache.js';

// Canonical Telegraph intent names — UPPERCASE, as the registry expects.
export const INTENTS = [
  'GAS_PRICE',
  'WALLET_BALANCE_CHECK',
  'TOKEN_HOLDER_COUNT',
  'TVL_LOOKUP',
  'ONCHAIN_TX_LOOKUP',
  'CRYPTO_PRICE'
];

export function buildServer() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.get('/', async () => ({
    name: 'telegraph-onchain-miner',
    version: '1.1.0',
    intents: INTENTS,
    chains: SUPPORTED_CHAIN_KEYS,
    endpoints: {
      'GET|POST /v1/ask': 'query (any on-chain question — classified and routed)',
      'GET /v1/gas-price': 'chain | query',
      'GET /v1/wallet-balance': 'chain, address, [token] | query',
      'GET /v1/token-holders': 'chain, token | query',
      'GET /v1/tvl': 'protocol | chain | query',
      'GET /v1/tx': 'chain, hash | query',
      'GET /v1/price': 'symbol | (chain, token) | query'
    },
    note: 'Every endpoint accepts a natural-language ?query= as well as explicit params.'
  }));

  // Health endpoint doubles as the uptime-monitor target. Keep it cheap: it
  // must never depend on an upstream, or a third-party outage reads as downtime.
  app.get('/health', async () => ({
    status: 'ok',
    uptime_s: Math.round(process.uptime()),
    cache: cacheStats(),
    alchemy: USING_ALCHEMY,
    chains: SUPPORTED_CHAIN_KEYS.length,
    intents: INTENTS.length
  }));

  app.get('/v1/ask', ask);
  app.post('/v1/ask', ask);
  app.get('/v1/gas-price', gasPrice);
  app.get('/v1/wallet-balance', walletBalance);
  app.get('/v1/token-holders', tokenHolders);
  app.get('/v1/tvl', tvl);
  app.get('/v1/tx', txLookup);
  app.get('/v1/price', cryptoPrice);

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = buildServer();
  const port = Number(process.env.PORT || 8080);

  // Latency feeds the Canonical Score, and public RPCs routinely take seconds
  // (or time out). Make the single highest-impact misconfiguration loud.
  if (!USING_ALCHEMY) {
    app.log.warn(
      'ALCHEMY_API_KEY is not set — falling back to public RPCs. Expect multi-second ' +
      'latencies and intermittent timeouts. Copy .env.example to .env and set the key.'
    );
  }
  app.listen({ port, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
