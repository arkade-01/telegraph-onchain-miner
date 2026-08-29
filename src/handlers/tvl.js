// TVL_LOOKUP intent
// GET /v1/tvl?protocol=aave  |  ?chain=base
// GET /v1/tvl?query=what's the total value locked in aave

import { resolveChain } from '../chains.js';
import { ok, fail, fmtUsd } from '../envelope.js';
import { withCache } from '../cache.js';
import { parseQuestion } from '../nlq.js';

let fetchImpl = globalThis.fetch;
export function setFetch(fn) {
  fetchImpl = fn;
}

const LLAMA = process.env.DEFILLAMA_BASE_URL || 'https://api.llama.fi';
const TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 10000);
const CACHE_TTL_MS = Number(process.env.TVL_CACHE_MS || 300_000);

async function getJsonOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from DefiLlama`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * One retry on failure: DefiLlama intermittently hangs on slow links, and a single
 * transient timeout should not turn a working intent into an error response.
 */
async function getJson(url, ...rest) {
  try {
    return await getJsonOnce(url, ...rest);
  } catch (e) {
    return await getJsonOnce(url, ...rest);
  }
}

export async function tvl(req, reply) {
  const startedAt = Date.now();
  const q = req.query.query || req.query.question || req.query.q;
  const parsed = parseQuestion(q, { protocol: req.query.protocol, chain: req.query.chain });

  const protocol = parsed.params.protocol;
  // A chain only answers the question when no protocol was identified.
  const chainParam = protocol ? null : parsed.params.chain || req.query.chain;

  if (!protocol && !chainParam) {
    return fail(reply, 400,
      `Could not determine a protocol or chain${q ? ' from the question' : ''}.`,
      'TVL_LOOKUP', 'Provide ?protocol=<defillama-slug> or ?chain=<name>.');
  }

  const key = protocol ? `tvl:p:${protocol}` : `tvl:c:${String(chainParam).toLowerCase()}`;

  const result = await withCache(key, CACHE_TTL_MS, async () => {
    if (protocol) {
      const url = `${LLAMA}/tvl/${encodeURIComponent(protocol)}`;
      const value = await getJson(url);
      if (typeof value !== 'number') throw new Error(`Unknown protocol slug "${protocol}" on DefiLlama`);
      return ok(
        'TVL_LOOKUP',
        { protocol, tvl_usd: value },
        {
          signal: `${fmtUsd(value)} is the current total value locked in ${protocol}.`,
          sources: [url],
          startedAt,
          primaryValue: value,
          resolvedVia: parsed.resolved_via,
          checks: { live: true, canonical: true, corroborated: false, quorum: false }
        }
      );
    }

    const chain = resolveChain(chainParam);
    const name = chain ? chain.llamaSlug : String(chainParam);
    const url = `${LLAMA}/v2/chains`;
    const chains = await getJson(url);
    const hit = chains.find(
      (c) =>
        c.name?.toLowerCase() === name.toLowerCase() ||
        c.gecko_id?.toLowerCase() === name.toLowerCase()
    );
    if (!hit) throw new Error(`Chain "${chainParam}" not found on DefiLlama`);
    return ok(
      'TVL_LOOKUP',
      { chain: hit.name, tvl_usd: hit.tvl, token_symbol: hit.tokenSymbol ?? null },
      {
        signal: `${fmtUsd(hit.tvl)} is the current total value locked on ${hit.name}.`,
        sources: [url],
        startedAt,
        primaryValue: hit.tvl,
        resolvedVia: parsed.resolved_via,
        checks: { live: true, canonical: true, corroborated: false, quorum: false }
      }
    );
  }, { resolved_via: parsed.resolved_via }).catch((e) => ({ __error: e.message }));

  if (result?.__error) return fail(reply, 502, result.__error, 'TVL_LOOKUP');
  return result;
}
