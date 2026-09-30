import type { AccessState, ApiCall, Fingerprint, PageEvidence } from '../types';
import { isErrorPath, isLoginPath, isNoAccessPath, isNotFoundPath, urlPath } from '../util/route';
import { fingerprintScore } from './fingerprint';

export interface StateResult {
  state: AccessState;
  score: number | null;
  reason: string;
}

/**
 * Hard signals that decide the state without a fingerprint:
 * errors, login redirect, no-access page, not-found. Returns null when none apply.
 */
export function accessStateFromSignals(ev: PageEvidence): StateResult | null {
  const finalPath = urlPath(ev.finalUrl);
  const redirect = ev.fragmentRedirect ?? '';

  if (ev.error && ev.tokens.length === 0) return { state: 'ERROR', score: null, reason: ev.error };
  if (isLoginPath(finalPath) || isLoginPath(redirect)) {
    return { state: 'BAD_TOKEN', score: null, reason: `sent to ${isLoginPath(redirect) ? redirect : finalPath}` };
  }
  if (ev.noAccessMarker) return { state: 'BLOCKED', score: null, reason: 'no-access page shown' };
  if (isNoAccessPath(finalPath) || isNoAccessPath(redirect)) return { state: 'BLOCKED', score: null, reason: 'redirected to /noaccess' };
  if (ev.fragmentStatus === 404 || isNotFoundPath(finalPath) || isNotFoundPath(redirect)) {
    return { state: 'NOT_FOUND', score: null, reason: 'route not found on this build' };
  }
  if ((ev.fragmentStatus ?? 0) >= 500 || isErrorPath(finalPath) || isErrorPath(redirect)) {
    return { state: 'ERROR', score: null, reason: `server error${ev.fragmentStatus ? ` (HTTP ${ev.fragmentStatus})` : ''}` };
  }
  return null;
}

/** Page-specific API calls that were denied for this user (or got a different status than calibration). */
export function deniedPageApis(ev: PageEvidence, fp: Fingerprint | undefined): ApiCall[] {
  const pageFuncs = new Set(fp?.apiFuncs ?? []);
  return ev.apiCalls.filter((a) => {
    if (a.denied) return true;
    if (!pageFuncs.has(a.func) || !fp) return false;
    const expectedStatus = fp.apiStatus[a.func];
    return expectedStatus !== undefined && expectedStatus !== null && a.apiStatus !== null && a.apiStatus !== expectedStatus;
  });
}

/** Decides what the user experienced on the page. */
export function accessState(ev: PageEvidence, fp: Fingerprint | undefined, threshold: number): StateResult {
  const hard = accessStateFromSignals(ev);
  if (hard) return hard;

  const score = fingerprintScore(fp, ev);
  const denied = deniedPageApis(ev, fp);

  if (score === null) {
    return {
      state: 'UNCLEAR',
      score,
      reason: fp?.reason ? `no fingerprint (${fp.reason})` : 'no calibration fingerprint for this page',
    };
  }
  if (score >= threshold) {
    if (denied.length > 0) {
      return { state: 'OPENED_EMPTY', score, reason: `page opened but data calls denied: ${denied.map((d) => d.func).join(', ')}` };
    }
    return { state: 'OPENED', score, reason: `page matched ${Math.round(score * 100)}% of its fingerprint` };
  }
  if (denied.length > 0) {
    return { state: 'OPENED_EMPTY', score, reason: `page shell loaded, data calls denied: ${denied.map((d) => d.func).join(', ')}` };
  }
  return { state: 'UNCLEAR', score, reason: `only ${Math.round(score * 100)}% of fingerprint matched and no denial signal` };
}
