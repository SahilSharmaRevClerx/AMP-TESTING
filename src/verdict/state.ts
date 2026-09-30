import type { AccessState, ApiCall, Fingerprint, PageEvidence } from '../types';
import { isErrorPath, isLoginPath, isNoAccessPath, isNotFoundPath, urlPath } from '../util/route';
import { fingerprintScore } from './fingerprint';

export interface StateResult {
  state: AccessState;
  /** How much of the reference view this user saw (0..1), when there is a reference. Informational. */
  score: number | null;
  reason: string;
}

/** The AMP frame around every page (menu, header, notifications): ignored when judging content. */
export interface Frame {
  tokens: Set<string>;
  apis: Set<string>;
}

/** A user "got the page" with at least this many page-specific elements (or one plus loaded data). */
const MIN_CONTENT_ELEMENTS = 2;

/**
 * Hard signals that decide the state on their own: session problems, AMP's no-access screen,
 * on-screen "no permission" wording, redirects to /noaccess, not found, server errors.
 * Returns null when none apply.
 */
export function accessStateFromSignals(ev: PageEvidence): StateResult | null {
  const finalPath = urlPath(ev.finalUrl);
  const redirect = ev.fragmentRedirect ?? '';

  if (ev.error && ev.tokens.length === 0) return { state: 'ERROR', score: null, reason: ev.error };
  if (isLoginPath(finalPath) || isLoginPath(redirect)) {
    return { state: 'BAD_TOKEN', score: null, reason: `sent to ${isLoginPath(redirect) ? redirect : finalPath}` };
  }
  if (ev.noAccessMarker) return { state: 'BLOCKED', score: null, reason: 'AMP no-access page shown' };
  if (ev.denialText) return { state: 'BLOCKED', score: null, reason: `page says "${ev.denialText}"` };
  if (isNoAccessPath(finalPath) || isNoAccessPath(redirect)) return { state: 'BLOCKED', score: null, reason: 'redirected to /noaccess' };
  if (ev.fragmentStatus === 404 || isNotFoundPath(finalPath) || isNotFoundPath(redirect)) {
    return { state: 'NOT_FOUND', score: null, reason: 'route not found on this build' };
  }
  if ((ev.fragmentStatus ?? 0) >= 500 || isErrorPath(finalPath) || isErrorPath(redirect)) {
    return { state: 'ERROR', score: null, reason: `server error${ev.fragmentStatus ? ` (HTTP ${ev.fragmentStatus})` : ''}` };
  }
  return null;
}

export interface PageContent {
  /** Elements/headings on screen that are not part of the AMP frame. */
  tokens: string[];
  /** The page's own data calls that returned data. */
  dataApis: string[];
  has: boolean;
}

/** What this user got beyond the AMP frame. */
export function pageContent(ev: PageEvidence, frame: Frame): PageContent {
  const tokens = [...new Set(ev.tokens)].filter((t) => !frame.tokens.has(t));
  const dataApis = [...new Set(ev.apiCalls.filter((a) => a.hasData && !frame.apis.has(a.func)).map((a) => a.func))];
  const has = tokens.length >= MIN_CONTENT_ELEMENTS || (tokens.length >= 1 && dataApis.length >= 1);
  return { tokens, dataApis, has };
}

/** The page's own data calls that were denied (or answered differently than in the reference view). */
export function deniedPageApis(ev: PageEvidence, frame: Frame, ref: Fingerprint | undefined): ApiCall[] {
  return ev.apiCalls.filter((a) => {
    if (frame.apis.has(a.func)) return false;
    if (a.denied) return true;
    const expectedStatus = ref?.apiStatus[a.func];
    return expectedStatus !== undefined && expectedStatus !== null && a.apiStatus !== null && a.apiStatus !== expectedStatus;
  });
}

/**
 * What the user experienced on the page, judged on its own terms (not by matching another user,
 * since pages like dashboards differ per user):
 *   BLOCKED / BAD_TOKEN / NOT_FOUND / ERROR from hard signals, then
 *   ERROR   — an error message and (almost) nothing else,
 *   OPENED  — page content beyond the AMP frame (OPENED_EMPTY if its data calls were denied),
 *   BLOCKED — nothing shown and its data calls were denied,
 *   BLANK   — only the AMP frame rendered.
 */
export function accessState(ev: PageEvidence, frame: Frame, ref?: Fingerprint & { referenceUser?: string | null }): StateResult {
  const hard = accessStateFromSignals(ev);
  if (hard) return hard;

  const content = pageContent(ev, frame);
  const denied = deniedPageApis(ev, frame, ref);
  const score = ref ? fingerprintScore(ref, ev) : null;
  const like = score !== null && ref?.referenceUser ? ` · ${Math.round(score * 100)}% of ${ref.referenceUser}'s view` : '';

  if (ev.errorText && content.tokens.length < 3) return { state: 'ERROR', score, reason: `page shows "${ev.errorText}"` };
  if (content.has) {
    const what = `${content.tokens.length} page element${content.tokens.length === 1 ? '' : 's'}${content.dataApis.length ? ', data loaded' : ''}`;
    if (denied.length) return { state: 'OPENED_EMPTY', score, reason: `page opened (${what}) but data calls were denied: ${denied.map((d) => d.func).join(', ')}${like}` };
    return { state: 'OPENED', score, reason: `page content shown (${what})${like}` };
  }
  if (denied.length) return { state: 'BLOCKED', score, reason: `nothing shown and the page's data calls were denied: ${denied.map((d) => d.func).join(', ')}` };
  if (ev.pageErrors.length) return { state: 'ERROR', score, reason: `nothing rendered and the page script failed: ${ev.pageErrors[0]}` };
  return { state: 'BLANK', score, reason: 'only the AMP frame rendered (blank page)' };
}
