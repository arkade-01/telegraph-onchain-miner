// GAS_PRICE intent
// GET /v1/gas-price?chain=ethereum
// GET /v1/gas-price?query=what's the gas price on base right now
//
// Median gas price across a quorum of RPCs + EIP-1559 fee breakdown.
// Cached for roughly one block: a gas price is only meaningful per block, so a
// cached answer within the block is both faster AND more internally consistent.

import { resolveChain, SUPPORTED_CHAIN_KEYS } from '../chains.js';
import { rpcMedianBigInt, rpcFirst, formatUnits } from '../rpc.js';
import { ok, fail } from '../envelope.js';
import { withCache } from '../cache.js';
import { parseQuestion } from '../nlq.js';

export async function gasPrice(req, reply) {
  const startedAt = Date.now();
  const q = req.query.query || req.query.question || req.query.q;
  const parsed = parseQuestion(q, { chain: req.query.chain });

  // Default to Ethereum only when nothing was asked for; a question naming an
  // unsupported chain should say so rather than silently answer about Ethereum.
  const chainName = parsed.params.chain || (q ? null : 'ethereum') || 'ethereum';
  const chain = resolveChain(chainName);
  if (!chain) {
    return fail(
      reply,
      400,
      `Could not determine a supported chain${q ? ' from the question' : ''}.`,
      'GAS_PRICE',
      `Supported chains: ${SUPPORTED_CHAIN_KEYS.join(', ')}`
    );
  }

  try {
    return await withCache(`gas:${chain.key}`, chain.blockTimeMs, async () => {
      const { median, samples } = await rpcMedianBigInt(chain.rpcs, 'eth_gasPrice', []);

      let baseFee = null;
      let priority = null;
      try {
        // Optional enrichment: the gas price alone is a complete answer, so
        // this gets a tight budget rather than the full RPC timeout.
        const { result } = await rpcFirst(chain.rpcs, 'eth_feeHistory', ['0x5', 'latest', [50]], {
          timeoutMs: Number(process.env.FEE_HISTORY_TIMEOUT_MS || 1500),
          hedgeDelayMs: 400,
          max: 2
        });
        const bases = (result.baseFeePerGas || []).map((h) => BigInt(h));
        if (bases.length) baseFee = bases[bases.length - 1];
        const rewards = (result.reward || []).flat().map((h) => BigInt(h));
        if (rewards.length) {
          const sorted = rewards.sort((a, b) => (a < b ? -1 : 1));
          priority = sorted[Math.floor(sorted.length / 2)];
        }
      } catch {
        /* fee history unsupported — gasPrice alone is still a valid answer */
      }

      const gwei = formatUnits(median, 9);
      const pretty = Number(gwei).toFixed(Number(gwei) < 1 ? 4 : 2);

      return ok(
        'GAS_PRICE',
        {
          chain: chain.key,
          chain_id: chain.chainId,
          gas_price_wei: median.toString(),
          gas_price_gwei: Number(gwei),
          base_fee_wei: baseFee !== null ? baseFee.toString() : null,
          base_fee_gwei: baseFee !== null ? Number(formatUnits(baseFee, 9)) : null,
          priority_fee_wei: priority !== null ? priority.toString() : null,
          priority_fee_gwei: priority !== null ? Number(formatUnits(priority, 9)) : null,
          quorum_size: samples.length
        },
        {
          // One claim only. The base fee is a SECOND figure that the ground
          // truth for "what is the gas price" will not contain, so including it
          // could only dilute the word-overlap score. It stays in `data`.
          signal: `${pretty} gwei is the gas price on ${chain.key}`,
          sources: samples.map((s) => s.url),
          startedAt,
          confidence: samples.length >= 2 ? 1 : 0.8,
          primaryValue: median.toString(),
          resolvedVia: parsed.resolved_via,
          checks: {
            live: true,
            quorum: samples.length >= 2,
            corroborated: samples.length >= 2,
            canonical: true
          }
        }
      );
    }, { resolved_via: parsed.resolved_via });
  } catch (e) {
    return fail(reply, 502, e.message, 'GAS_PRICE');
  }
}
