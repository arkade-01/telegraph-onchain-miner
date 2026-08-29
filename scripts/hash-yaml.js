// Compute the SHA-256 hash of telegraph-miner.yaml for on-chain registration.
// Telegraph requires SHA-256, NOT keccak256.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2] || resolve(import.meta.dirname, '..', 'telegraph-miner.yaml');
const bytes = readFileSync(file);
const hash = '0x' + createHash('sha256').update(bytes).digest('hex');
console.log(`file:   ${file}`);
console.log(`sha256: ${hash}`);
