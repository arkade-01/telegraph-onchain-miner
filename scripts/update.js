// Re-submit a corrected YAML with updateMiner().
//
// A rejected registration is NOT fixed by registering again — the docs are
// explicit that you call updateMiner() with the old registrationId. It
// deregisters the old entry and registers the new one atomically, so you keep
// your slug and get a fresh registrationId + intentId.
//
// Env vars:
//   PRIVATE_KEY       registering wallet (must be the one that owns the slug)
//   YAML_URL          public URL of the corrected YAML
//   REGISTRATION_ID   the registrationId being replaced
// Optional:
//   FEE_ADDRESS, MIN_PRICE, DIAMOND_ADDR
//
// The hash is computed from the LOCAL telegraph-miner.yaml, so push the file
// before running this — local and hosted bytes must be identical.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const DIAMOND = process.env.DIAMOND_ADDR || '0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8';
const YAML_URL = process.env.YAML_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const REGISTRATION_ID = process.env.REGISTRATION_ID;
const MIN_PRICE = BigInt(process.env.MIN_PRICE || '10000');

// Keep in sync with telegraph-miner.yaml -> semantics.supported_intents.
const INTENTS = [
  'GAS_PRICE',
  'WALLET_BALANCE_CHECK',
  'TOKEN_HOLDER_COUNT',
  'TVL_LOOKUP',
  'ONCHAIN_TX_LOOKUP',
  'CRYPTO_PRICE'
];

if (!PRIVATE_KEY || !YAML_URL || !REGISTRATION_ID) {
  console.error('Set PRIVATE_KEY, YAML_URL and REGISTRATION_ID. See README.');
  process.exit(1);
}

const yamlPath = resolve(import.meta.dirname, '..', 'telegraph-miner.yaml');
const yamlBytes = readFileSync(yamlPath);
const yamlHash = '0x' + createHash('sha256').update(yamlBytes).digest('hex');

const account = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
const feeAddress = process.env.FEE_ADDRESS || account.address;

const abi = parseAbi([
  'function updateMiner(uint256 oldRegistrationId, string yamlUrl, bytes32 yamlHash, address feeAddress, uint256 minPriceUsdc, string[] supportedIntents)'
]);

const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });
const pub = createPublicClient({ chain: baseSepolia, transport: http() });

console.log('Updating miner on Base Sepolia');
console.log(`  diamond:     ${DIAMOND}`);
console.log(`  signer:      ${account.address}`); // the address that owns the slug
console.log(`  replacing:   registrationId ${REGISTRATION_ID}`);
console.log(`  yaml url:    ${YAML_URL}`);
console.log(`  yaml hash:   ${yamlHash}`);
console.log(`  fee addr:    ${feeAddress}`);
console.log(`  intents:     ${INTENTS.join(', ')}`);
console.log('');

// Guard: the hosted bytes must match the hash we are about to commit, or the
// node rejects on hash mismatch. Checking here is cheaper than a failed update.
try {
  const res = await fetch(YAML_URL);
  const hosted = Buffer.from(await res.arrayBuffer());
  const hostedHash = '0x' + createHash('sha256').update(hosted).digest('hex');
  if (hostedHash !== yamlHash) {
    console.error('ABORT: the hosted YAML does not match the local file.');
    console.error(`  hosted: ${hostedHash}`);
    console.error(`  local:  ${yamlHash}`);
    console.error('Commit and push the YAML, wait for the raw URL to update, then retry.');
    process.exit(1);
  }
  console.log('hosted YAML matches local bytes ✓');
} catch (e) {
  console.error(`Could not verify the hosted YAML (${e.message}). Continuing anyway.`);
}

const txHash = await wallet.writeContract({
  address: DIAMOND,
  abi,
  functionName: 'updateMiner',
  args: [BigInt(REGISTRATION_ID), YAML_URL, yamlHash, feeAddress, MIN_PRICE, INTENTS]
});
console.log(`tx sent: ${txHash}`);

const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
console.log(`status: ${receipt.status} in block ${receipt.blockNumber}`);
console.log('');
console.log('This creates a NEW registrationId — read it from the MinerRegistered');
console.log('event in this transaction, then check activation:');
console.log(`  curl -s https://devnode.telegraphprotocol.com/api/miners/<newId> | jq '.miner | {activation_status, rejection_reason}'`);
