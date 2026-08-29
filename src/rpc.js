// Minimal JSON-RPC layer with multi-endpoint quorum + fallback.
// No web3 library needed: raw eth_* calls over fetch.
//
// `fetchImpl` is injectable so tests can stub the network.

let fetchImpl = globalThis.fetch;
export function setFetch(fn) {
  fetchImpl = fn;
}

// 5s was too tight for cross-region links; a slow answer still beats none,
// and the soft deadline below stops a straggler from delaying the response.

/**
 * Strip credentials from a URL before it is ever shown to a caller.
 *
 * SECURITY: RPC URLs embed the API key in the path (Alchemy: /v2/<key>) or in
 * a query parameter. Both `sources` on a successful answer and the error text
 * on a failed one are returned in the HTTP response, so an unredacted URL
 * publishes the key to every caller of this miner.
 */
export function redactUrl(url) {
  try {
    const u = new URL(String(url));
    // Redact only credential-shaped segments: long, opaque and alphanumeric.
    // Public identifiers stay visible so `sources` remains useful provenance —
    // 0x addresses and hashes are on-chain data, and ids like
    // "coingecko:ethereum" contain punctuation a key never would.
    const looksSecret = (seg) =>
      seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg) && !/^0x[0-9a-fA-F]+$/.test(seg);
    const path = u.pathname
      .split('/')
      .map((seg) => (looksSecret(seg) ? '***' : seg))
      .join('/');
    for (const k of [...u.searchParams.keys()]) {
      if (/key|token|secret|auth|pass/i.test(k)) u.searchParams.set(k, '***');
    }
    const qs = u.searchParams.toString();
    // keep a bare origin bare — no cosmetic trailing slash
    const cleanPath = path === '/' ? '' : path;
    return `${u.origin}${cleanPath}${qs ? `?${qs}` : ''}`;
  } catch {
    return '[redacted]';
  }
}

const DEFAULT_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 8000);

async function rpcCallOne(url, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${redactUrl(url)}`);
    const body = await res.json();
    if (body.error) throw new Error(`RPC error from ${redactUrl(url)}: ${body.error.message}`);
    return body.result;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Return the first successful answer, using HEDGED requests.
 *
 * The naive version tried endpoints strictly in order, waiting out each one's
 * hard timeout before moving on — so a single slow endpoint could cost 8s, and
 * three of them 24s. That is what made eth_feeHistory turn 400ms gas lookups
 * into 20s responses.
 *
 * Instead we start endpoint 0, and if it hasn't answered within `hedgeDelayMs`
 * we start endpoint 1 alongside it, and so on. Whoever answers first wins;
 * latency tracks the FASTEST endpoint rather than the sum of the slow ones.
 */
export async function rpcFirst(rpcs, method, params, opts = {}) {
  const {
    hedgeDelayMs = Number(process.env.RPC_HEDGE_DELAY_MS || 700),
    timeoutMs, // per-attempt hard timeout; defaults to DEFAULT_TIMEOUT_MS
    max = 4
  } = opts;

  const targets = rpcs.slice(0, max);
  if (targets.length === 0) throw new Error(`No RPC endpoints configured for ${method}`);

  return new Promise((resolve, reject) => {
    const errors = [];
    const timers = [];
    let done = false;
    let settled = 0;

    const clearAll = () => timers.forEach(clearTimeout);
    const failIfAllSettled = () => {
      if (!done && settled >= targets.length) {
        done = true;
        clearAll();
        reject(new Error(`All RPCs failed for ${method}: ${errors.join(' | ')}`));
      }
    };

    targets.forEach((url, i) => {
      timers.push(
        setTimeout(() => {
          if (done) return;
          rpcCallOne(url, method, params, timeoutMs)
            .then((result) => {
              if (done) return;
              done = true;
              clearAll();
              resolve({ result, source: redactUrl(url) });
            })
            .catch((e) => {
              errors.push(`${redactUrl(url)}: ${e.message}`);
            })
            .finally(() => {
              settled += 1;
              failIfAllSettled();
            });
        }, i * hedgeDelayMs)
      );
    });
  });
}

/**
 * Query several RPCs in parallel and return the median of the numeric results —
 * this resists a single stale or lying endpoint.
 *
 * Critically it does NOT wait for every endpoint. Promise.allSettled would make
 * each call as slow as the slowest RPC, so one dead public node turned a 300ms
 * Alchemy answer into a 5s response. Instead we resolve as soon as we have a
 * full quorum, or at a soft deadline with whatever has arrived.
 */
export async function rpcMedianBigInt(rpcs, method, params, opts = {}) {
  const {
    quorum = 3, // enough answers to stop waiting entirely
    softDeadlineMs = Number(process.env.RPC_SOFT_DEADLINE_MS || 1200),
    // At the soft deadline we want at least two answers, so the "median"
    // actually corroborates. Only at the last-resort deadline do we accept a
    // lone answer rather than failing.
    minAtSoftDeadline = 2,
    lastResortMs = Number(process.env.RPC_LAST_RESORT_MS || 3000),
    max = 5 // how many endpoints to ask at all
  } = opts;

  const targets = rpcs.slice(0, max);
  const results = [];
  const errors = [];

  return new Promise((resolve, reject) => {
    let done = false;
    let outstanding = targets.length;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(lastResort);
      if (results.length === 0) {
        reject(new Error(`All RPCs failed for ${method}: ${errors.join(' | ')}`));
        return;
      }
      const sorted = [...results].sort((a, b) =>
        a.value < b.value ? -1 : a.value > b.value ? 1 : 0
      );
      resolve({
        median: sorted[Math.floor(sorted.length / 2)].value,
        samples: results.map((o) => ({ url: redactUrl(o.url), value: o.value.toString() }))
      });
    };

    // Two-stage: prefer a corroborated answer, settle for a single one only
    // if that is all that arrives before the last-resort deadline.
    const timer = setTimeout(() => {
      if (results.length >= minAtSoftDeadline) finish();
    }, softDeadlineMs);
    const lastResort = setTimeout(() => {
      if (results.length > 0) finish();
    }, lastResortMs);

    for (const url of targets) {
      rpcCallOne(url, method, params)
        .then((r) => {
          results.push({ value: BigInt(r), url });
          if (results.length >= quorum) finish();
        })
        .catch((e) => {
          errors.push(`${redactUrl(url)}: ${e.message}`);
        })
        .finally(() => {
          outstanding -= 1;
          if (outstanding === 0) finish(); // everyone reported; nothing left to wait for
        });
    }
  });
}

/** hex quantity -> decimal string (safe for uint256) */
export const hexToDec = (hex) => BigInt(hex).toString(10);

/** wei bigint -> decimal string of ether-like unit with `decimals` */
export function formatUnits(wei, decimals = 18) {
  const w = BigInt(wei);
  const base = 10n ** BigInt(decimals);
  const whole = w / base;
  const frac = (w % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

// ---- minimal ABI helpers (no library) ----

const strip0x = (s) => (s.startsWith('0x') ? s.slice(2) : s);

/** encode address as 32-byte ABI word */
export const abiAddress = (addr) => strip0x(addr).toLowerCase().padStart(64, '0');

/** eth_call helper */
export async function ethCall(rpcs, to, data) {
  return rpcFirst(rpcs, 'eth_call', [{ to, data }, 'latest']);
}

export const SELECTORS = {
  balanceOf: '0x70a08231', // balanceOf(address)
  decimals: '0x313ce567', // decimals()
  symbol: '0x95d89b41' // symbol()
};

/** decode a single uint256 return word */
export const decodeUint = (hex) => (hex && hex !== '0x' ? BigInt(hex).toString(10) : '0');

/** decode ABI-encoded string return (best effort) */
export function decodeString(hex) {
  try {
    const h = strip0x(hex);
    if (h.length < 128) {
      // some old tokens return bytes32 symbols
      // Trim the NUL padding old bytes32 symbols carry. Written as an escape,
      // not a literal NUL byte, so the file stays valid UTF-8 text (a raw NUL
      // makes git and most editors treat the source as binary).
      return Buffer.from(h, 'hex').toString('utf8').replace(/\u0000+$/g, '').trim() || null;
    }
    const len = Number(BigInt('0x' + h.slice(64, 128)));
    return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
  } catch {
    return null;
  }
}

export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s || '');
export const isTxHash = (s) => /^0x[0-9a-fA-F]{64}$/.test(s || '');
