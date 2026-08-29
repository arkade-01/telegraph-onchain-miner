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

/** Compact number formatting for the human-readable signal string. */
export function fmtUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toPrecision(4)}`;
}

export const fmtNum = (n) => Number(n).toLocaleString('en-US');
