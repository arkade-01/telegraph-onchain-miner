// WALLET_BALANCE_CHECK intent
// GET /v1/wallet-balance?chain=ethereum&address=0x...[&token=0x...]
// GET /v1/wallet-balance?query=how much ETH does 0xd8dA... hold

import { resolveChain, SUPPORTED_CHAIN_KEYS } from '../chains.js';
import {
  rpcFirst, ethCall, abiAddress, SELECTORS,
  decodeUint, decodeString, formatUnits, isAddress
} from '../rpc.js';
import { ok, fail } from '../envelope.js';
import { withCache } from '../cache.js';
import { parseQuestion } from '../nlq.js';
import { symbolForAddress } from '../tokens.js';

export async function walletBalance(req, reply) {
  const startedAt = Date.now();
  const q = req.query.query || req.query.question || req.query.q;
  const parsed = parseQuestion(q, {
    chain: req.query.chain,
    address: req.query.address,
    token: req.query.token
  });

  const address = parsed.params.address;
  // In a balance question the 40-hex address is the wallet; an explicit
  // ?token= (or a second address) is the ERC-20 contract.
  const token = req.query.token || null;
  const chain = resolveChain(parsed.params.chain || 'ethereum');

  if (!chain) {
    return fail(reply, 400, 'Could not determine a supported chain.', 'WALLET_BALANCE_CHECK',
      `Supported chains: ${SUPPORTED_CHAIN_KEYS.join(', ')}`);
  }
  if (!isAddress(address)) {
    return fail(reply, 400,
      `Could not determine a wallet address${q ? ' from the question' : ''}.`,
      'WALLET_BALANCE_CHECK', 'Provide ?address=0x... (40 hex characters).');
  }
  if (token && !isAddress(token)) {
    return fail(reply, 400, 'Invalid ?token= address', 'WALLET_BALANCE_CHECK');
  }

  const key = `bal:${chain.key}:${address.toLowerCase()}:${(token || 'native').toLowerCase()}`;

  try {
    return await withCache(key, chain.blockTimeMs, async () => {
      if (!token) {
        const { result, source } = await rpcFirst(chain.rpcs, 'eth_getBalance', [address, 'latest']);
        const wei = BigInt(result);
        const bal = formatUnits(wei, 18);
        return ok(
          'WALLET_BALANCE_CHECK',
          {
            chain: chain.key,
            chain_id: chain.chainId,
            address,
            asset: chain.nativeSymbol,
            balance_wei: wei.toString(),
            balance: Number(bal)
          },
          {
            signal: `${Number(bal).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${chain.nativeSymbol} is the balance of ${address} on ${chain.key}.`,
            sources: [source],
            startedAt,
            primaryValue: wei.toString(),
            resolvedVia: parsed.resolved_via,
            checks: { live: true, canonical: true, corroborated: false, quorum: false }
          }
        );
      }

      const balData = SELECTORS.balanceOf + abiAddress(address);
      const [bal, dec, sym] = await Promise.all([
        ethCall(chain.rpcs, token, balData),
        ethCall(chain.rpcs, token, SELECTORS.decimals).catch(() => ({ result: null })),
        ethCall(chain.rpcs, token, SELECTORS.symbol).catch(() => ({ result: null }))
      ]);
      const raw = decodeUint(bal.result);
      const decimals = dec.result ? Number(BigInt(dec.result)) : 18;
      // A flaky RPC must not degrade the answer to "37.19 tokens" — fall back
      // to the well-known token registry when symbol() fails or returns junk.
      const symbol =
        (sym.result ? decodeString(sym.result) : null) || symbolForAddress(chain.key, token);
      const human = formatUnits(raw, decimals);

      return ok(
        'WALLET_BALANCE_CHECK',
        {
          chain: chain.key,
          chain_id: chain.chainId,
          address,
          token,
          symbol,
          decimals,
          balance_raw: raw,
          balance: Number(human)
        },
        {
          signal: `${Number(human).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${symbol || 'tokens'} is the balance of ${address} on ${chain.key}.`,
          sources: [bal.source],
          startedAt,
          primaryValue: raw,
          resolvedVia: parsed.resolved_via,
          checks: { live: true, canonical: true, corroborated: false, quorum: false }
        }
      );
    }, { resolved_via: parsed.resolved_via });
  } catch (e) {
    return fail(reply, 502, e.message, 'WALLET_BALANCE_CHECK');
  }
}
