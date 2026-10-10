// Pure formatting helpers for the Fly Ask debug cards. No DOM access.

// Only http(s) URLs are safe to link to. Returns the normalised URL or null.
export function safeHttpUrl(u) {
  if (typeof u !== 'string') return null;
  const t = u.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    const p = new URL(t);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : null;
  } catch (_) { return null; }
}

// "https://www.thaipbs.or.th/x" -> "thaipbs.or.th"; '' when not a usable http(s) URL.
export function hostnameOf(url) {
  const safe = safeHttpUrl(url);
  if (!safe) return '';
  try { return new URL(safe).hostname.replace(/^www\./i, ''); } catch (_) { return ''; }
}

// 0.00731437 -> "$0.0073"; sub-cent values keep 4 decimals, bigger ones 2. '' when not a number.
export function formatCost(x) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) return '';
  return '$' + (x >= 1 ? x.toFixed(2) : x.toFixed(4));
}

// 0.7633 -> "76%"; clamped to 0..100; '-' when not a number.
export function formatPct(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '-';
  return Math.round(Math.min(1, Math.max(0, p)) * 100) + '%';
}

// 4241 -> "4.2 s"; '' when not a number.
export function formatSeconds(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  return (ms / 1000).toFixed(1) + ' s';
}

// Collapse whitespace; cut to n characters (code points) with an ellipsis. Returns {text, cut}.
export function clampText(s, n) {
  const flat = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (!(n > 0) || chars.length <= n) return { text: flat, cut: false };
  return { text: chars.slice(0, n).join('').trimEnd() + '…', cut: true };
}

// The three verification checks: use the server's `checks` when present, else derive them.
export function deriveChecks(a) {
  if (!a || typeof a !== 'object') return [];
  if (Array.isArray(a.checks) && a.checks.length) {
    return a.checks.map((c) => ({ name: String((c && c.name) || ''), ok: !!(c && c.ok) }));
  }
  const out = [];
  const winner = a.decision && a.decision !== 'inconclusive' ? a.decision : null;
  const known = a.id_ok !== undefined || a.agree !== undefined || a.mean || a.min_conf != null;
  if (!known) return out;
  out.push({ name: 'choice id was one of the options sent', ok: a.id_ok === undefined ? true : !!a.id_ok });
  out.push({ name: 'forward and swapped runs name the same candidate', ok: !!a.agree });
  const thr = typeof a.min_conf === 'number' ? a.min_conf : null;
  const p = winner && a.mean ? a.mean[winner] : null;
  out.push({ name: thr != null ? `mean probability >= ${thr}` : 'mean probability above the threshold', ok: !!winner && (thr == null || (typeof p === 'number' && p >= thr)) });
  return out;
}
