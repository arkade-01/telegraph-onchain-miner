// Well-known token registry, used two ways:
//   symbol -> address, so a question can name "USDC" instead of a contract
//   address -> symbol, as a fallback when an on-chain symbol() call times out
//
// The fallback matters for answer quality: a signal that reads "37.19 tokens"
// instead of "37.19 USDC" is a worse answer, and a flaky public RPC shouldn't
// be able to degrade it.

export const TOKEN_BY_SYMBOL = {
  ethereum: {
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    dai: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    wbtc: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    link: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    uni: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    aave: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    steth: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
    ldo: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32',
    crv: '0xD533a949740bb3306d119CC777fa900bA034cd52',
    mkr: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2'
  },
  base: {
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    weth: '0x4200000000000000000000000000000000000006',
    dai: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'
  },
  polygon: {
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    usdt: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    dai: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    weth: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'
  },
  bsc: {
    usdt: '0x55d398326f99059fF775485246999027B3197955',
    usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
  },
  arbitrum: {
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    usdt: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    arb: '0x912CE59144191C1204E64559FE8253a0e49E6548'
  },
  optimism: {
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    weth: '0x4200000000000000000000000000000000000006',
    op: '0x4200000000000000000000000000000000000042'
  },
  avalanche: {
    usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    usdt: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7'
  },
  scroll: { usdc: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4' },
  linea: { usdc: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff' },
  gnosis: { usdc: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0' }
};

// address (lowercase) -> SYMBOL, built once from the map above
const REVERSE = (() => {
  const m = new Map();
  for (const [chain, tokens] of Object.entries(TOKEN_BY_SYMBOL)) {
    for (const [sym, addr] of Object.entries(tokens)) {
      m.set(`${chain}:${addr.toLowerCase()}`, sym.toUpperCase());
    }
  }
  return m;
})();

export const symbolForAddress = (chainKey, address) =>
  REVERSE.get(`${chainKey}:${String(address || '').toLowerCase()}`) || null;

export const addressForSymbol = (chainKey, symbol) =>
  (TOKEN_BY_SYMBOL[chainKey] || {})[String(symbol || '').toLowerCase()] || null;
