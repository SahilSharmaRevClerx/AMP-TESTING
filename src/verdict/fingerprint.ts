import type { Fingerprint, PageEvidence } from '../types';
import { accessStateFromSignals } from './state';

/**
 * Builds a per-page fingerprint from the calibration user's run.
 * Tokens/APIs seen on most pages belong to the AMP shell (menu, header, notifications)
 * and are removed, so what's left identifies the page itself.
 */
export function buildFingerprints(calibration: PageEvidence[], shellShare = 0.5): Map<string, Fingerprint> {
  const opened = calibration.filter((e) => accessStateFromSignals(e) === null);
  const tokenFreq = new Map<string, number>();
  const apiFreq = new Map<string, number>();
  for (const e of opened) {
    for (const t of new Set(e.tokens)) tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1);
    for (const f of new Set(e.apiCalls.map((a) => a.func))) apiFreq.set(f, (apiFreq.get(f) ?? 0) + 1);
  }
  // Only strip shell tokens when there are enough pages to tell shell from page.
  const n = opened.length;
  const isShell = (freq: number | undefined) => n >= 4 && (freq ?? 0) / n >= shellShare;

  const out = new Map<string, Fingerprint>();
  for (const e of calibration) {
    const signal = accessStateFromSignals(e);
    if (signal !== null) {
      out.set(e.route, {
        route: e.route,
        tokens: [],
        apiFuncs: [],
        apiStatus: {},
        usable: false,
        reason: `calibration user got ${signal.state}: ${signal.reason}`,
      });
      continue;
    }
    const tokens = [...new Set(e.tokens)].filter((t) => !isShell(tokenFreq.get(t)));
    const apiFuncs = [...new Set(e.apiCalls.map((a) => a.func))].filter((f) => !isShell(apiFreq.get(f)));
    const apiStatus: Record<string, number | null> = {};
    for (const a of e.apiCalls) if (apiFuncs.includes(a.func)) apiStatus[a.func] = a.apiStatus;

    out.set(e.route, {
      route: e.route,
      tokens,
      apiFuncs,
      apiStatus,
      usable: tokens.length > 0,
      reason: tokens.length > 0 ? undefined : 'no page-specific elements found on calibration run',
    });
  }
  return out;
}

/** Share of the page's fingerprint tokens that are also on this user's screen (0..1). */
export function fingerprintScore(fp: Fingerprint | undefined, ev: PageEvidence): number | null {
  if (!fp || !fp.usable || fp.tokens.length === 0) return null;
  const seen = new Set(ev.tokens);
  const hit = fp.tokens.filter((t) => seen.has(t)).length;
  return Math.round((hit / fp.tokens.length) * 100) / 100;
}
