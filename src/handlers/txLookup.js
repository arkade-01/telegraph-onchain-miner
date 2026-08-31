// ONCHAIN_TX_LOOKUP intent
// GET /v1/tx?chain=ethereum&hash=0x...
// GET /v1/tx?query=did transaction 0xabc... succeed
//
// A confirmed transaction is immutable, so it caches for an hour; a pending one
// is never cached.

import { resolveChain, SUPPORTED_CHAIN_KEYS } from '../chains.js';
import { rpcFirst, formatUnits, isTxHash } from '../rpc.js';
import { ok, fail } from '../envelope.js';
import { withCache } from '../cache.js';
import { parseQuestion } from '../nlq.js';

const CONFIRMED_TTL_MS = Number(process.env.TX_CACHE_MS || 3_600_000);

export async function txLookup(req, reply) {
  const startedAt = Date.now();
  const q = req.query.query || req.query.question || req.query.q;
  const parsed = parseQuestion(q, { chain: req.query.chain, hash: req.query.hash });

  const hash = parsed.params.hash;
  const chain = resolveChain(parsed.params.chain || 'ethereum');

  if (!chain) {
    return fail(reply, 400, 'Could not determine a supported chain.', 'ONCHAIN_TX_LOOKUP',
      `Supported chains: ${SUPPORTED_CHAIN_KEYS.join(', ')}`);
  }
  if (!isTxHash(hash)) {
    return fail(reply, 400,
      `Could not determine a transaction hash${q ? ' from the question' : ''}.`,
      'ONCHAIN_TX_LOOKUP', 'Provide ?hash=0x... (64 hex characters).');
  }

  const key = `tx:${chain.key}:${hash.toLowerCase()}`;

  const result = await withCache(key, CONFIRMED_TTL_MS, async () => {
    const [{ result: tx, source }, receiptRes] = await Promise.all([
      rpcFirst(chain.rpcs, 'eth_getTransactionByHash', [hash]),
      rpcFirst(chain.rpcs, 'eth_getTransactionReceipt', [hash]).catch(() => ({ result: null }))
    ]);
    if (!tx) throw new Error(`__404__Transaction ${hash} not found on ${chain.key}`);

    const receipt = receiptRes.result;
    const gasUsed = receipt?.gasUsed ? BigInt(receipt.gasUsed) : null;
    const effGasPrice = receipt?.effectiveGasPrice ? BigInt(receipt.effectiveGasPrice) : null;
    const feeWei = gasUsed !== null && effGasPrice !== null ? gasUsed * effGasPrice : null;

    let status = 'pending';
    if (receipt) {
      if (receipt.status === '0x1') status = 'success';
      else if (receipt.status === '0x0') status = 'failed';
      // pre-Byzantium receipts (Ethereum < block 4,370,000) carry no status
      // field — the tx was mined, so report success rather than failed
      else status = 'success';
    }

    const valueEth = formatUnits(BigInt(tx.value), 18);
    const block = tx.blockNumber ? Number(BigInt(tx.blockNumber)) : null;

    const envelope = ok(
      'ONCHAIN_TX_LOOKUP',
      {
        chain: chain.key,
        chain_id: chain.chainId,
        hash,
        status,
        block_number: block,
        from: tx.from,
        to: tx.to,
        contract_created: receipt?.contractAddress ?? null,
        value_wei: BigInt(tx.value).toString(),
        value: Number(valueEth),
        nonce: Number(BigInt(tx.nonce)),
        gas_used: gasUsed !== null ? gasUsed.toString() : null,
        effective_gas_price_wei: effGasPrice !== null ? effGasPrice.toString() : null,
        tx_fee_wei: feeWei !== null ? feeWei.toString() : null,
        tx_fee: feeWei !== null ? Number(formatUnits(feeWei, 18)) : null,
        logs_count: receipt ? receipt.logs.length : null,
        input_bytes: tx.input && tx.input !== '0x' ? (tx.input.length - 2) / 2 : 0,
        method_selector: tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10) : null
      },
      {
        // Was a 25-word sentence carrying the full 66-char hash, block,
        // value AND fee. Every one of those is a separate figure the ground
        // truth is unlikely to repeat, and each divides the overlap score.
        // The claim is the status; the rest stays in `data`.
        signal:
          status === 'pending'
            ? `Transaction ${hash} is pending on ${chain.key}`
            : `Transaction ${hash} ${status === 'success' ? 'succeeded' : 'failed'} on ${chain.key}`,
        sources: [source],
        startedAt,
        primaryValue: BigInt(tx.value).toString(),
        resolvedVia: parsed.resolved_via,
        checks: {
          live: true,
          canonical: true,
          corroborated: Boolean(receipt),
          quorum: false
        }
      }
    );

    if (status === 'pending') envelope.__noCache = true;
    return envelope;
  }, { resolved_via: parsed.resolved_via }).catch((e) => ({ __error: e.message }));

  if (result?.__error) {
    const msg = result.__error;
    if (msg.startsWith('__404__')) {
      return fail(reply, 404, msg.replace('__404__', ''), 'ONCHAIN_TX_LOOKUP');
    }
    return fail(reply, 502, msg, 'ONCHAIN_TX_LOOKUP');
  }
  return result;
}
