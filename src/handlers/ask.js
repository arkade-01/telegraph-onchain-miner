// Universal question endpoint — GET/POST /v1/ask?query=...
//
// Telegraph routes a free-text question to a miner. This endpoint classifies
// the question into one of our six intents and dispatches internally, so the
// miner answers whatever on-chain question arrives without the caller needing
// to know which sub-endpoint to hit.

import { classify } from '../nlq.js';
import { fail } from '../envelope.js';
import { gasPrice } from './gasPrice.js';
import { walletBalance } from './walletBalance.js';
import { tokenHolders } from './tokenHolders.js';
import { tvl } from './tvl.js';
import { txLookup } from './txLookup.js';
import { cryptoPrice } from './cryptoPrice.js';

const ROUTES = {
  GAS_PRICE: gasPrice,
  WALLET_BALANCE_CHECK: walletBalance,
  TOKEN_HOLDER_COUNT: tokenHolders,
  TVL_LOOKUP: tvl,
  ONCHAIN_TX_LOOKUP: txLookup,
  CRYPTO_PRICE: cryptoPrice
};

export async function ask(req, reply) {
  const body = req.body || {};
  const query =
    req.query.query || req.query.question || req.query.q ||
    body.query || body.question || body.q;

  if (!query) {
    return fail(reply, 400, 'Missing question.', null,
      'Provide ?query=<your question>, or call an intent endpoint directly.');
  }

  // An explicit intent hint wins over classification.
  const hinted = String(req.query.intent || body.intent || '').toUpperCase();
  const intent = ROUTES[hinted] ? hinted : classify(query);

  if (!intent || !ROUTES[intent]) {
    return fail(reply, 422,
      'Could not determine an on-chain intent from the question.', null,
      `This miner serves: ${Object.keys(ROUTES).join(', ')}.`);
  }

  // Merge any explicit params from the body so POST callers work too.
  req.query = { ...body, ...req.query, query };
  return ROUTES[intent](req, reply);
}
