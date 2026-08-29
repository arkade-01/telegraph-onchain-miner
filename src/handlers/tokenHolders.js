// TOKEN_HOLDER_COUNT intent
// GET /v1/token-holders?chain=ethereum&token=0x...
// GET /v1/token-holders?query=how many addresses hold USDC on ethereum

import { resolveChain, SUPPORTED_CHAIN_KEYS } from '../chains.js';
import { isAddress } from '../rpc.js';
import { ok, fail, fmtNum } from '../envelope.js';
import { withCache } from '../cache.js';
import { parseQuestion } from '../nlq.js';
import { addressForSymbol, symbolForAddress } from '../tokens.js';

let fetchImpl = globalThis.fetch;
export function setFetch(fn) {
  fetchImpl = fn;
}

const TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 10000);
const CACHE_TTL_MS = Number(process.env.HOLDERS_CACHE_MS || 300_000);

async function getJsonOnce(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * One retry on failure: source intermittently hangs on slow links, and a single
 * transient timeout should not turn a working intent into an error response.
 */
async function getJson(url, ...rest) {
  try {
    return await getJsonOnce(url, ...rest);
  } catch (e) {
    return await getJsonOnce(url, ...rest);
  }
}

export async function tokenHolders(req, reply) {
  const startedAt = Date.now();
  const q = req.query.query || req.query.question || req.query.q;
  const parsed = parseQuestion(q, { chain: req.query.chain, token: req.query.token });

  const chain = resolveChain(parsed.params.chain || 'ethereum');
  if (!chain) {
    return fail(reply, 400, 'Could not determine a supported chain.', 'TOKEN_HOLDER_COUNT',
      `Supported chains: ${SUPPORTED_CHAIN_KEYS.join(', ')}`);
  }

  // token address, or a known symbol resolved on this chain
  let token = req.query.token || parsed.params.token;
  if (!token && parsed.params.symbol) {
    token = addressForSymbol(chain.key, parsed.params.symbol);
  }
  if (!isAddress(token)) {
    return fail(reply, 400,
      `Could not determine a token contract${q ? ' from the question' : ''}.`,
      'TOKEN_HOLDER_COUNT',
      'Provide ?token=0x..., or name a well-known token (USDC, USDT, DAI, WETH, WBTC, LINK, UNI, AAVE).');
  }

  const key = `holders:${chain.key}:${token.toLowerCase()}`;
  const result = await withCache(key, CACHE_TTL_MS, async () => {
    if (chain.blockscout) {
      try {
        const url = `${chain.blockscout}/api/v2/tokens/${token}`;
        const body = await getJson(url);
        const holders = body.holders_count ?? body.holders;
        if (holders !== undefined && holders !== null) {
          const n = Number(holders);
          return ok(
            'TOKEN_HOLDER_COUNT',
            {
              chain: chain.key,
              chain_id: chain.chainId,
              token,
              name: body.name ?? null,
              symbol: body.symbol ?? null,
              holder_count: n,
              total_supply: body.total_supply ?? null
            },
            {
              signal: `${fmtNum(n)} distinct addresses hold ${body.symbol || symbolForAddress(chain.key, token) || token} on ${chain.key}.`,
              sources: [url],
              startedAt,
              primaryValue: n,
              resolvedVia: parsed.resolved_via,
              checks: { live: true, canonical: true, corroborated: false, quorum: false }
            }
          );
        }
      } catch {
        /* fall through to Etherscan */
      }
    }

    const apiKey = process.env.ETHERSCAN_API_KEY;
    if (apiKey) {
      const url = `https://api.etherscan.io/v2/api?chainid=${chain.chainId}&module=token&action=tokenholdercount&contractaddress=${token}&apikey=${apiKey}`;
      const body = await getJson(url);
      if (body.status === '1' && body.result) {
        const n = Number(body.result);
        return ok(
          'TOKEN_HOLDER_COUNT',
          { chain: chain.key, chain_id: chain.chainId, token, holder_count: n },
          {
            signal: `${fmtNum(n)} distinct addresses hold ${symbolForAddress(chain.key, token) || token} on ${chain.key}.`,
            sources: ['https://api.etherscan.io/v2/api (tokenholdercount)'],
            startedAt,
            primaryValue: n,
            resolvedVia: parsed.resolved_via,
            checks: { live: true, canonical: true, corroborated: false, quorum: false }
          }
        );
      }
      throw new Error(body.result || body.message || 'Etherscan error');
    }

    throw new Error(
      `No holder-count source available for ${chain.key}. ` +
        (chain.blockscout
          ? 'Blockscout failed and no ETHERSCAN_API_KEY set.'
          : 'Set ETHERSCAN_API_KEY for this chain.')
    );
  }, { resolved_via: parsed.resolved_via }).catch((e) => ({ __error: e.message }));

  if (result?.__error) return fail(reply, 502, result.__error, 'TOKEN_HOLDER_COUNT');
  return result;
}
