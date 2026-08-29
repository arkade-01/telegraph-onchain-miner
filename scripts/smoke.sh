#!/usr/bin/env bash
# Live smoke test — run this on a machine with real internet access.
# Starts the server if not already running, hits every intent, prints results
# and a latency summary (latency feeds your Telegraph Canonical Score).
set -o pipefail

BASE="${BASE:-http://localhost:8080}"
STARTED=0

if [ -f "$(dirname "$0")/../.env" ]; then
  set -a; . "$(dirname "$0")/../.env"; set +a
fi
if [ -z "${ALCHEMY_API_KEY:-}" ]; then
  echo "WARNING: ALCHEMY_API_KEY not set — using public RPCs."
  echo "         Expect multi-second latencies and timeouts below; this is"
  echo "         configuration, not a code failure. cp .env.example .env"
  echo
fi

if ! curl -sf -m 15 "$BASE/health" >/dev/null 2>&1; then
  echo "starting server..."
  node "$(dirname "$0")/../src/server.js" >/tmp/miner-smoke.log 2>&1 &
  SERVER_PID=$!
  STARTED=1
  for i in $(seq 1 20); do
    sleep 0.5
    curl -sf -m 5 "$BASE/health" >/dev/null 2>&1 && break
  done
fi

pass=0; failed=0
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

# check <name> <url> [expected_intent]
#
# NOTE: this must delete the body file before every request and check curl's
# exit code explicitly. An earlier version reused a stale body file when curl
# failed, which scored timeouts as passes and showed the PREVIOUS response.
check () {
  local name="$1" url="$2" want="${3:-}" code tt ms body intent
  : > "$BODY"
  tt=$(curl -s -m 25 -o "$BODY" -w '%{time_total}' "$url"); code=$?
  ms=$(awk -v t="${tt:-0}" 'BEGIN{printf "%.0f", t*1000}')
  body=$(cat "$BODY" 2>/dev/null)

  if [ "$code" -ne 0 ]; then
    printf 'FAIL  %-34s %6sms  (curl exit %s — timeout or connection refused)\n' "$name" "$ms" "$code"
    failed=$((failed+1)); return
  fi
  if ! printf '%s' "$body" | grep -q '"ok":true'; then
    printf 'FAIL  %-34s %6sms\n' "$name" "$ms"
    printf '      %s\n' "$(printf '%s' "$body" | head -c 220)"
    failed=$((failed+1)); return
  fi
  # Guard against answering the wrong question.
  if [ -n "$want" ]; then
    intent=$(printf '%s' "$body" | sed -n 's/.*"intent":"\([A-Z_]*\)".*/\1/p')
    if [ "$intent" != "$want" ]; then
      printf 'FAIL  %-34s %6sms  (expected %s, got %s)\n' "$name" "$ms" "$want" "$intent"
      failed=$((failed+1)); return
    fi
  fi
  printf 'PASS  %-34s %6sms\n' "$name" "$ms"
  printf '      %s\n' "$(printf '%s' "$body" | head -c 190)"
  pass=$((pass+1))
}

VITALIK=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
USDC_ETH=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
TX=0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060

echo "--- intents ---"
check "gas_price (ethereum)"          "$BASE/v1/gas-price?chain=ethereum" GAS_PRICE
check "gas_price (base)"              "$BASE/v1/gas-price?chain=base" GAS_PRICE
check "wallet_balance native"         "$BASE/v1/wallet-balance?chain=ethereum&address=$VITALIK" WALLET_BALANCE_CHECK
check "wallet_balance erc20 (USDC)"   "$BASE/v1/wallet-balance?chain=ethereum&address=$VITALIK&token=$USDC_ETH" WALLET_BALANCE_CHECK
check "token_holder_count (USDC)"     "$BASE/v1/token-holders?chain=ethereum&token=$USDC_ETH" TOKEN_HOLDER_COUNT
check "tvl protocol (aave)"           "$BASE/v1/tvl?protocol=aave" TVL_LOOKUP
check "tvl chain (base)"              "$BASE/v1/tvl?chain=base" TVL_LOOKUP
check "tx_lookup (pre-byzantium)"     "$BASE/v1/tx?chain=ethereum&hash=$TX" ONCHAIN_TX_LOOKUP
check "crypto_price symbol (eth)"     "$BASE/v1/price?symbol=eth" CRYPTO_PRICE
check "crypto_price symbol (btc)"     "$BASE/v1/price?symbol=btc" CRYPTO_PRICE
check "crypto_price token (USDC)"     "$BASE/v1/price?chain=ethereum&token=$USDC_ETH" CRYPTO_PRICE

echo
echo "--- all chains (gas_price) ---"
for c in ethereum base polygon bsc arbitrum optimism avalanche scroll linea gnosis; do
  check "gas_price ($c)" "$BASE/v1/gas-price?chain=$c" GAS_PRICE
done

echo
echo "--- natural-language questions (what validators actually send) ---"
ask () { check "$1" "$BASE/v1/ask?query=$(printf '%s' "$2" | sed 's/ /%20/g; s/?/%3F/g; s/'"'"'/%27/g')" "$3"; }
ask "NL gas (base)"        "What is the gas price on Base right now" GAS_PRICE
ask "NL gas (arbitrum)"    "How much are gas fees on Arbitrum" GAS_PRICE
ask "NL balance"           "How much ETH does 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 hold" WALLET_BALANCE_CHECK
ask "NL holders"           "How many addresses hold USDC on Ethereum" TOKEN_HOLDER_COUNT
ask "NL tvl"               "What is the total value locked in Aave" TVL_LOOKUP
ask "NL price"             "What is the price of ETH" CRYPTO_PRICE
ask "NL price (bitcoin)"   "How much is bitcoin worth" CRYPTO_PRICE
ask "NL tx"                "Did transaction 0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060 succeed" ONCHAIN_TX_LOOKUP

echo
echo "--- cache check (repeat should be much faster) ---"
check "gas_price ethereum (cold-ish)" "$BASE/v1/gas-price?chain=ethereum" GAS_PRICE
check "gas_price ethereum (cached)"   "$BASE/v1/gas-price?chain=ethereum" GAS_PRICE

echo
echo "passed: $pass  failed: $failed"
[ "$STARTED" = "1" ] && kill "$SERVER_PID" 2>/dev/null
exit $([ "$failed" -eq 0 ] && echo 0 || echo 1)
