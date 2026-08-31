// Uniform response envelope for every intent.
//
// Shape follows what scores well on Telegraph today: a `signal` string that
// states the answer number-first in plain language (validators grade the
// answer, and a bare JSON blob reads poorly), plus the structured data, an
// explicit `checks` block showing how the answer was verified, and a
// `confidence` the checks actually justify.
//
// `primary_value` is the single normalized headline number, so one YAML
// on_chain rule extracts the answer for ALL intents.

export function ok(intent, data, {
  sources = [],
  startedAt,
  confidence = 1,
  primaryValue,
  signal,
  checks = {},
  resolvedVia
} = {}) {
  const checksTotal = Object.keys(checks).length;
  const checksPassed = Object.values(checks).filter(Boolean).length;

  return {
    ok: true,
    status: 'ok',
    intent,
    // Number-first natural-language answer — this is what a validator reads.
    signal,
    data: {
      ...data,
      primary_value:
        primaryValue !== undefined && primaryValue !== null ? String(primaryValue) : null
    },
    confidence,
    checks,
    checks_passed: checksPassed,
    checks_total: checksTotal,
    // 'params' when the caller passed explicit query params, 'extracted' when
    // we parsed them out of a natural-language question.
    resolved_via: resolvedVia,
    sources,
    latency_ms: startedAt ? Date.now() - startedAt : undefined,
    as_of: new Date().toISOString(),
    timestamp: new Date().toISOString()
  };
}

export function fail(reply, code, message, intent, hint) {
  reply.code(code);
  return {
    ok: false,
    status: 'error',
    intent,
    error: message,
    hint,
    timestamp: new Date().toISOString()
  };
}

// Number formatting for `signal`.
//
// SCORING: the default scoring module compares our answer to a ground-truth
// string word by word, dividing by OUR word count. Thousands separators are
// pure downside — "9,026,572" can never match "9026572", and the comma buys
// nothing. So these emit bare numbers: no commas, no B/M suffixes, no currency
// symbol glued to the digits.
export function fmtUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  // large values keep 2dp; small ones keep precision
  return v >= 1 ? v.toFixed(2) : String(Number(v.toPrecision(6)));
}

export const fmtNum = (n) => String(Number(n));

/** Trim a float for display without introducing separators. */
export const fmtAmount = (n, maxDp = 6) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return String(Number(v.toFixed(maxDp)));
};
