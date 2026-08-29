// Register this miner on-chain with the Telegraph MinerRegistryFacet.
//
// Env vars required:
//   PRIVATE_KEY   - registering wallet (needs Base Sepolia ETH for gas)
//   YAML_URL      - public URL where telegraph-miner.yaml is hosted
//   FEE_ADDRESS   - payout address (defaults to the registering wallet)
// Optional:
//   DIAMOND_ADDR  - Telegraph Diamond (default: Base Sepolia deployment)
//   MIN_PRICE     - min price in USDC 6-decimals units (default 10000 = $0.01)
//
// The YAML hash is computed from the LOCAL telegraph-miner.yaml — make sure
// the hosted copy at YAML_URL is byte-identical before running this.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const DIAMOND = process.env.DIAMOND_ADDR || '0x122396E8602BEed349434AA6E83123E7dD97F5A0';
const YAML_URL = process.env.YAML_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MIN_PRICE = BigInt(process.env.MIN_PRICE || '10000'); // $0.01 USDC (6 decimals)

// Keep in sync with telegraph-miner.yaml -> semantics.supported_intents.
// Canonical Telegraph intent names are UPPERCASE — confirmed against
// /api/canonical-intents on the explorer.
const INTENTS = [
  'GAS_PRICE',
  'WALLET_BALANCE_CHECK',
  'TOKEN_HOLDER_COUNT',
  'TVL_LOOKUP',
  'ONCHAIN_TX_LOOKUP',
  'CRYPTO_PRICE'
];

if (!PRIVATE_KEY || !YAML_URL) {
  console.error('Set PRIVATE_KEY and YAML_URL env vars. See README.');
  process.exit(1);
}

const yamlPath = resolve(import.meta.dirname, '..', 'telegraph-miner.yaml');
const yamlHash = '0x' + createHash('sha256').update(readFileSync(yamlPath)).digest('hex');

const account = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
const feeAddress = process.env.FEE_ADDRESS || account.address;

const abi = parseAbi([
  'function registerMiner(string yamlUrl, bytes32 yamlHash, address feeAddress, uint256 minPriceUsdc, string[] supportedIntents) returns (uint256)'
]);

const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });
const pub = createPublicClient({ chain: baseSepolia, transport: http() });

console.log('Registering miner on Base Sepolia');
console.log(`  diamond:    ${DIAMOND}`);
console.log(`  yaml url:   ${YAML_URL}`);
console.log(`  yaml hash:  ${yamlHash}`);
console.log(`  fee addr:   ${feeAddress}`);
console.log(`  min price:  ${MIN_PRICE} (USDC 6dp)`);
console.log(`  intents:    ${INTENTS.join(', ')}`);

const txHash = await wallet.writeContract({
  address: DIAMOND,
  abi,
  functionName: 'registerMiner',
  args: [YAML_URL, yamlHash, feeAddress, MIN_PRICE, INTENTS]
});
console.log(`tx sent: ${txHash}`);

const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
console.log(`status: ${receipt.status} in block ${receipt.blockNumber}`);
console.log('Miner staged — it activates at the next epoch boundary.');
