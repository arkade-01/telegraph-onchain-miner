// Natural-language parsing tests.
//
// These are the highest-value tests in the repo: live Telegraph traffic routes
// free-text questions to miners, and a miner that can't parse them scores zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, extractChain, extractSymbol, extractProtocol, extractAddress, extractTxHash, parseQuestion } from '../src/nlq.js';

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const HASH = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060';

test('classify: gas questions', () => {
  for (const q of [
    'What is the gas price on Base right now?',
    'How much are gas fees on Arbitrum?',
    "what's the current transaction fee on ethereum",
    'current gwei on polygon'
  ]) {
    assert.equal(classify(q), 'GAS_PRICE', q);
  }
});

test('classify: balance questions', () => {
  for (const q of [
    `How much ETH does ${VITALIK} hold?`,
    `what is the balance of ${VITALIK} on base`,
    `${VITALIK}`
  ]) {
    assert.equal(classify(q), 'WALLET_BALANCE_CHECK', q);
  }
});

test('classify: holder-count questions', () => {
  for (const q of [
    'How many addresses hold USDC on Ethereum?',
    'holder count for DAI',
    'how many distinct wallets own WBTC'
  ]) {
    assert.equal(classify(q), 'TOKEN_HOLDER_COUNT', q);
  }
});

test('classify: TVL questions', () => {
  for (const q of [
    'What is the total value locked in Aave?',
    "what's uniswap's tvl",
    'how much value is locked in lido'
  ]) {
    assert.equal(classify(q), 'TVL_LOOKUP', q);
  }
});

test('classify: transaction questions win over everything else', () => {
  assert.equal(classify(`Did transaction ${HASH} succeed?`), 'ONCHAIN_TX_LOOKUP');
  // even when the sentence also says "fee", the hash decides
  assert.equal(classify(`what fee did ${HASH} pay`), 'ONCHAIN_TX_LOOKUP');
});

test('classify: price questions', () => {
  for (const q of [
    'What is the price of ETH?',
    'how much is bitcoin worth',
    'BTC price',
    'what is solana trading at'
  ]) {
    assert.equal(classify(q), 'CRYPTO_PRICE', q);
  }
});

test('classify: returns null for unrelated questions', () => {
  assert.equal(classify('Will SpaceX open-source Cursor code?'), null);
  assert.equal(classify('explain what a rollup is'), null);
});

test('extractChain: names, aliases and multi-word spellings', () => {
  assert.equal(extractChain('gas on Base right now'), 'base');
  assert.equal(extractChain('fees on the BNB chain'), 'bsc');
  assert.equal(extractChain('balance on arbitrum one'), 'arbitrum');
  assert.equal(extractChain('what about matic'), 'polygon');
  assert.equal(extractChain('avalanche c-chain fees'), 'avalanche');
  assert.equal(extractChain('no chain mentioned here'), null);
});

test('extractSymbol: positional hints and bare tickers', () => {
  assert.equal(extractSymbol('what is the price of ETH'), 'eth');
  assert.equal(extractSymbol('how much is bitcoin worth'), 'btc');
  assert.equal(extractSymbol('BTC price'), 'btc');
  assert.equal(extractSymbol('solana trading at'), 'sol');
});

test('extractProtocol: known slugs and positional patterns', () => {
  assert.equal(extractProtocol('total value locked in aave'), 'aave');
  assert.equal(extractProtocol("uniswap's tvl"), 'uniswap');
  assert.equal(extractProtocol('tvl of pendle'), 'pendle');
});

test('extractAddress / extractTxHash', () => {
  assert.equal(extractAddress(`balance of ${VITALIK} please`), VITALIK);
  assert.equal(extractTxHash(`did ${HASH} succeed`), HASH);
  // a 64-hex hash must not be mistaken for a 40-hex address
  assert.equal(extractAddress('no address here'), null);
});

test('parseQuestion: explicit params beat extraction', () => {
  const p = parseQuestion('gas price on base', { chain: 'polygon' });
  assert.equal(p.params.chain, 'polygon');
  assert.equal(p.resolved_via, 'params');
});

test('parseQuestion: reports extraction when nothing explicit was passed', () => {
  const p = parseQuestion('what is the gas price on base');
  assert.equal(p.intent, 'GAS_PRICE');
  assert.equal(p.params.chain, 'base');
  assert.equal(p.resolved_via, 'extracted');
});

test('parseQuestion: an address in a holders question is the token, not a wallet', () => {
  const p = parseQuestion(`how many holders does ${VITALIK} have`);
  assert.equal(p.intent, 'TOKEN_HOLDER_COUNT');
  assert.equal(p.params.token, VITALIK);
});

// --- token registry ---
import { symbolForAddress, addressForSymbol } from '../src/tokens.js';

test('token registry resolves both directions', () => {
  const usdcEth = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  assert.equal(addressForSymbol('ethereum', 'usdc'), usdcEth);
  assert.equal(symbolForAddress('ethereum', usdcEth), 'USDC');
  // case-insensitive on the address
  assert.equal(symbolForAddress('ethereum', usdcEth.toLowerCase()), 'USDC');
  // same symbol, different address per chain
  assert.notEqual(addressForSymbol('base', 'usdc'), addressForSymbol('ethereum', 'usdc'));
  assert.equal(symbolForAddress('ethereum', '0x' + '9'.repeat(40)), null);
});
