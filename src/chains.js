// Chain registry: every supported chain with redundant RPC endpoints and its
// Blockscout instance (used for token holder counts).
//
// RPC priority order:
//   1. RPC_<CHAIN> env override (comma-separated) — wins outright if set
//   2. Alchemy (if ALCHEMY_API_KEY is set) — paid, low latency, goes first
//   3. Public fallbacks — keep the miner answering if Alchemy hiccups
//
// Latency feeds the Telegraph Canonical Score, so a paid primary + public
// fallbacks is the right shape: fast when healthy, still correct when not.

const env = (name) =>
  (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || '';

// Alchemy subdomains — verify against your dashboard; a chain missing from
// your plan simply falls back to the public list below.
const alchemyUrl = (subdomain) =>
  ALCHEMY_KEY && subdomain ? [`https://${subdomain}.g.alchemy.com/v2/${ALCHEMY_KEY}`] : [];

const def = ({ chainId, aliases, nativeSymbol, alchemy, publicRpcs, blockscout, llamaSlug, llamaChainKey, blockTimeMs }) => ({
  chainId,
  aliases,
  nativeSymbol,
  alchemy,
  publicRpcs,
  blockscout,
  llamaSlug,
  // DefiLlama coins API prefix for `chain:0xtoken` price lookups
  llamaChainKey,
  blockTimeMs
});

const RAW = {
  ethereum: def({
    chainId: 1,
    aliases: ['eth', 'mainnet', '1'],
    nativeSymbol: 'ETH',
    alchemy: 'eth-mainnet',
    publicRpcs: [
      'https://ethereum-rpc.publicnode.com',
      'https://1rpc.io/eth',
      'https://eth.drpc.org',
      'https://rpc.ankr.com/eth'
      // eth.llamarpc.com removed: returning HTTP 521 (Cloudflare origin down)
    ],
    blockscout: 'https://eth.blockscout.com',
    llamaSlug: 'Ethereum',
    llamaChainKey: 'ethereum',
    blockTimeMs: 12000
  }),
  base: def({
    chainId: 8453,
    aliases: ['8453'],
    nativeSymbol: 'ETH',
    alchemy: 'base-mainnet',
    publicRpcs: [
      'https://mainnet.base.org',
      'https://base-rpc.publicnode.com',
      'https://base.drpc.org',
      'https://1rpc.io/base'
    ],
    blockscout: 'https://base.blockscout.com',
    llamaSlug: 'Base',
    llamaChainKey: 'base',
    blockTimeMs: 2000
  }),
  polygon: def({
    chainId: 137,
    aliases: ['matic', '137'],
    nativeSymbol: 'POL',
    alchemy: 'polygon-mainnet',
    publicRpcs: [
      'https://polygon-rpc.com',
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon.drpc.org'
    ],
    blockscout: 'https://polygon.blockscout.com',
    llamaSlug: 'Polygon',
    llamaChainKey: 'polygon',
    blockTimeMs: 2000
  }),
  bsc: def({
    chainId: 56,
    aliases: ['bnb', 'binance', '56'],
    nativeSymbol: 'BNB',
    alchemy: 'bnb-mainnet',
    publicRpcs: [
      'https://bsc-dataseed.bnbchain.org',
      'https://bsc-rpc.publicnode.com',
      'https://bsc.drpc.org'
    ],
    blockscout: null, // holder counts need ETHERSCAN_API_KEY here
    llamaSlug: 'BSC',
    llamaChainKey: 'bsc',
    blockTimeMs: 3000
  }),
  arbitrum: def({
    chainId: 42161,
    aliases: ['arb', 'arbitrum-one', '42161'],
    nativeSymbol: 'ETH',
    alchemy: 'arb-mainnet',
    publicRpcs: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.drpc.org'
    ],
    blockscout: 'https://arbitrum.blockscout.com',
    llamaSlug: 'Arbitrum',
    llamaChainKey: 'arbitrum',
    blockTimeMs: 250
  }),
  optimism: def({
    chainId: 10,
    aliases: ['op', '10'],
    nativeSymbol: 'ETH',
    alchemy: 'opt-mainnet',
    publicRpcs: [
      'https://mainnet.optimism.io',
      'https://optimism-rpc.publicnode.com',
      'https://optimism.drpc.org'
    ],
    blockscout: 'https://optimism.blockscout.com',
    llamaSlug: 'OP Mainnet',
    llamaChainKey: 'optimism',
    blockTimeMs: 2000
  }),
  avalanche: def({
    chainId: 43114,
    aliases: ['avax', 'avalanche-c', '43114'],
    nativeSymbol: 'AVAX',
    alchemy: 'avax-mainnet',
    publicRpcs: [
      'https://api.avax.network/ext/bc/C/rpc',
      'https://avalanche-c-chain-rpc.publicnode.com',
      'https://avalanche.drpc.org'
    ],
    blockscout: null,
    llamaSlug: 'Avalanche',
    llamaChainKey: 'avax',
    blockTimeMs: 2000
  }),
  scroll: def({
    chainId: 534352,
    aliases: ['534352'],
    nativeSymbol: 'ETH',
    alchemy: 'scroll-mainnet',
    publicRpcs: [
      'https://rpc.scroll.io',
      'https://scroll-rpc.publicnode.com',
      'https://scroll.drpc.org',
      'https://scroll-mainnet.public.blastapi.io',
      'https://1rpc.io/scroll'
    ],
    blockscout: 'https://scroll.blockscout.com',
    llamaSlug: 'Scroll',
    llamaChainKey: 'scroll',
    blockTimeMs: 3000
  }),
  linea: def({
    chainId: 59144,
    aliases: ['59144'],
    nativeSymbol: 'ETH',
    alchemy: 'linea-mainnet',
    publicRpcs: [
      'https://rpc.linea.build',
      'https://linea-rpc.publicnode.com',
      'https://linea.drpc.org'
    ],
    blockscout: 'https://explorer.linea.build',
    llamaSlug: 'Linea',
    llamaChainKey: 'linea',
    blockTimeMs: 3000
  }),
  gnosis: def({
    chainId: 100,
    aliases: ['xdai', '100'],
    nativeSymbol: 'XDAI',
    alchemy: 'gnosis-mainnet',
    publicRpcs: [
      'https://rpc.gnosischain.com',
      'https://gnosis-rpc.publicnode.com',
      'https://gnosis.drpc.org'
    ],
    blockscout: 'https://gnosis.blockscout.com',
    llamaSlug: 'Gnosis',
    llamaChainKey: 'xdai',
    blockTimeMs: 5000
  })
};

// Build the final RPC list per chain, honouring env overrides + Alchemy.
export const CHAINS = Object.fromEntries(
  Object.entries(RAW).map(([name, cfg]) => {
    const override = env(`RPC_${name.toUpperCase()}`);
    const rpcs = override.length ? override : [...alchemyUrl(cfg.alchemy), ...cfg.publicRpcs];
    return [name, { ...cfg, rpcs }];
  })
);

/** Resolve a user-supplied chain name/alias/id to a chain config. */
export function resolveChain(input) {
  if (!input) return null;
  const key = String(input).toLowerCase().trim();
  if (CHAINS[key]) return { key, ...CHAINS[key] };
  for (const [name, cfg] of Object.entries(CHAINS)) {
    if (cfg.aliases.includes(key)) return { key: name, ...cfg };
  }
  return null;
}

export const SUPPORTED_CHAIN_KEYS = Object.keys(CHAINS);
export const USING_ALCHEMY = Boolean(ALCHEMY_KEY);
