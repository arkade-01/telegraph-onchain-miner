# Telegraph On-Chain Intel Miner

A [Telegraph Protocol](https://telegraphprotocol.com) miner serving **six canonical intents** across **10 EVM chains** (Ethereum, Base, Polygon, BSC, Arbitrum, Optimism, Avalanche, Scroll, Linea, Gnosis).

| Intent | Endpoint | Answers |
|---|---|---|
| `GAS_PRICE` | `/v1/gas-price` | Median gas price across an RPC quorum + EIP-1559 base/priority fees |
| `WALLET_BALANCE_CHECK` | `/v1/wallet-balance` | Native or ERC-20 balance (auto decimals/symbol) |
| `TOKEN_HOLDER_COUNT` | `/v1/token-holders` | Holder count via Blockscout (Etherscan V2 fallback) |
| `TVL_LOOKUP` | `/v1/tvl` | TVL in USD for a protocol or chain, via DefiLlama |
| `ONCHAIN_TX_LOOKUP` | `/v1/tx` | Tx status, value, fee, logs, method selector |
| `CRYPTO_PRICE` | `/v1/price` | USD price — median of DefiLlama, Coinbase and Binance |
| *any of the above* | `/v1/ask` | Classifies a free-text question and routes it internally |

## The thing that actually matters

**Telegraph routes natural-language questions to miners, not query strings.** Live traffic on the explorer looks like `"What is the USD to NGN exchange rate?"`, and miners that only accept params fail with errors like *"could not determine a currency pair from the question"*.

That is almost certainly why every on-chain miner on the leaderboard scores between 0.000 and 0.031, while miners that accept a question and answer in prose score 0.59–1.00.

So every endpoint here takes **both**: explicit params when supplied, and `?query=` free text otherwise. `src/nlq.js` extracts chain, address, tx hash, symbol and protocol from the question and classifies it into one of the six intents; `/v1/ask` accepts anything and dispatches.

```bash
curl 'localhost:8080/v1/ask?query=What%20is%20the%20gas%20price%20on%20Base%20right%20now'
# {"ok":true,"intent":"GAS_PRICE","signal":"0.0060 gwei is the current gas price on base (base fee 0.0050 gwei).",
#  "confidence":1,"checks":{"live":true,"quorum":true,...},"resolved_via":"extracted",...}
```

Other design choices aimed at the Canonical Score:

- **Quorum + median, not one source.** Gas prices medianed across three RPCs, symbol prices across three venues. One stale or wicking endpoint can't move the answer.
- **`signal` first.** Every response leads with a number-first sentence, which is what a validator grades — not a raw JSON blob.
- **Honest confidence.** Price responses report `spread_pct` between venues and reduce `confidence` when they disagree; `checks`/`checks_passed` show exactly what was verified.
- **Fail loudly, not wrongly.** An unparseable question returns 4xx with a `hint`, rather than a confidently wrong default.
- **Block-aware caching.** Gas and balances cache for one block time — more internally consistent *and* faster. Confirmed txs cache an hour; failures and pending txs never cache. Per-request metadata is refreshed on a cache hit rather than served stale.

## Quick start

```bash
npm install
npm test          # 43 offline tests (all upstreams mocked)
npm start         # :8080
npm run smoke     # live: every intent, all 10 chains, NL questions, latencies
```

## Deploy

Stateless; one small always-on instance is enough.

```bash
docker build -t onchain-miner . && docker run -p 8080:8080 --env-file .env onchain-miner
```

**Railway** (hobby): point at the repo, the Dockerfile is picked up. Set `ALCHEMY_API_KEY` (one key covers all 10 chains — it becomes the primary RPC with public nodes as fallback) and optionally `ETHERSCAN_API_KEY`.

> **Avoid hosts that sleep on idle.** A ~30s cold start reads as a failed response if a validator probes during it. Point an uptime monitor at `/health`, which is deliberately dependency-free so a DefiLlama outage never reads as your downtime.

## Register on Telegraph

Miner = this API + `telegraph-miner.yaml` hosted publicly + one registration on **Base Sepolia**.

1. Deploy, then set `base_url` in `telegraph-miner.yaml`.
2. Host the YAML at a stable public URL (raw GitHub works).
3. `npm run hash:yaml` — SHA-256, **not** keccak. Hash **last**, after every edit.
4. Register (needs a little Base Sepolia ETH — [faucet](https://www.alchemy.com/faucets/base-sepolia)):

   ```bash
   PRIVATE_KEY=0x... \
   YAML_URL=https://raw.githubusercontent.com/YOU/REPO/main/telegraph-miner.yaml \
   npm run register
   ```

Goes to `MinerRegistryFacet` at `0x122396E8602BEed349434AA6E83123E7dD97F5A0`, activates at the next epoch boundary. Re-registering with the same `slug` replaces the config.

### YAML structure notes

Verified against the miners currently scoring highest on the network (`patchsignal-cve` 1.00, `sarzops-transaction-risk` 1.00, `telegraph-chatbot` 0.59):

- `kind: miner` — **not** `subnet`, despite what the generic YAML docs suggest
- Intent names are **UPPERCASE** (`GAS_PRICE`, not `gas_price`)
- Each endpoint declares its own `intents: [...]` so the router knows what serves what
- Top-level `input_schema` / `output_schema`
- `signal_mapping` carries **no `type:` key** — just `label_field` / `confidence_field` / `reason_field`
- **`id` must be globally unused or the registration is REJECTED.** `900` was checked against the live `/api/integrations` list (106 miners) on 2026-08-29 — 901 and 910 are taken, 900 is free. Re-check at `explorer.telegraphprotocol.com` before registering.

x402 payment gating ($0.01/call floor) is handled by the Telegraph node layer; this service contains no payment code.

## Hackathon checklist

**Track 1 closes Aug 31** (the site listed 12:00 UTC for the phase — confirm in Discord).

- [ ] Deploy (always-on) + host YAML + `npm run hash:yaml` + register
- [ ] Set `ALCHEMY_API_KEY` — public RPCs measured ~1.7s on Ethereum
- [ ] Uptime monitor on `/health`
- [ ] First X post tagging **@Telegraphprotoc** — 25% of score, judged on *consistency*, so start early
- [ ] Keep the miner live **through Sep 7**
- [ ] Track 3 (Aug 31 – Sep 7): build an app on these intents — second $2,000 track, and it drives the 100 real requests each intent needs to be prize-eligible

### Competitive snapshot (2026-08-29)

| Intent | Miners | Best avg score |
|---|---|---|
| GAS_PRICE | 9 | 0.031 |
| WALLET_BALANCE_CHECK | 8 | 0.031 |
| TOKEN_HOLDER_COUNT | 4 | 0.132 |
| TVL_LOOKUP | 8 | 0.031 |
| ONCHAIN_TX_LOOKUP | 11 | 0.031 |
| CRYPTO_PRICE | 12 | 0.031 |

Every intent already clears the 3-miner guardrail. Scores are computed as *your average ÷ the best average in that intent*, so the bar for leading any of these is currently very low.

## Layout

```
src/
  server.js            Fastify app + routes
  nlq.js               natural-language question -> intent + params
  chains.js            10-chain registry (Alchemy + public RPCs, Blockscout)
  rpc.js               JSON-RPC quorum/median/fallback + minimal ABI codec
  cache.js             TTL cache (lazy enablement; refreshes per-request metadata)
  envelope.js          response envelope: signal, checks, confidence, primary_value
  handlers/            one per intent, plus ask.js (universal router)
scripts/
  hash-yaml.js         SHA-256 for registration
  register.js          on-chain registerMiner() via viem
  smoke.sh             live test: intents, chains, NL questions, latency
test/                  43 offline tests (node --test)
telegraph-miner.yaml   Telegraph YAML Standard v1 descriptor
```
