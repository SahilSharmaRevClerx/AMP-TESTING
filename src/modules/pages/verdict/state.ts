import type { AccessState, ApiCall, Fingerprint, PageEvidence } from '../types';
import { isErrorPath, isLoginPath, isNoAccessPath, isNotFoundPath, urlPath } from '../../../core/util/route';
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
 * A "no permission" message only blocks the whole page when there is little else on it. With at least
 * this many other page elements it belongs to one section (e.g. a dashboard widget saying
 * "Permission Needed") and the page itself opened.
 */
const SECTION_DENIAL_MIN_ELEMENTS = 4;
const DENIAL_HEADING = /permission|no access|access denied|not authori[sz]ed|unauthori[sz]ed|restricted/i;

/** Page elements other than the denial message itself, when there are enough for the denial to be one section. */
export function sectionDenial(ev: PageEvidence, frame: Frame): boolean {
  if (!ev.denialText) return false;
  const others = [...new Set(ev.tokens)].filter((t) => !frame.tokens.has(t) && !DENIAL_HEADING.test(t));
  return others.length >= SECTION_DENIAL_MIN_ELEMENTS;
}

/**
 * Hard signals that decide the state on their own: session problems, AMP's no-access screen,
 * on-screen "no permission" wording, redirects to /noaccess, not found, server errors.
 * With the frame, a "no permission" message inside one section of an otherwise rendered page
 * (see sectionDenial) is not a hard signal. Returns null when none apply.
 */
export function accessStateFromSignals(ev: PageEvidence, frame?: Frame): StateResult | null {
  const finalPath = urlPath(ev.finalUrl);
  const redirect = ev.fragmentRedirect ?? '';

  if (ev.error && ev.tokens.length === 0) return { state: 'ERROR', score: null, reason: ev.error };
  if (isLoginPath(finalPath) || isLoginPath(redirect)) {
    return { state: 'BAD_TOKEN', score: null, reason: `sent to ${isLoginPath(redirect) ? redirect : finalPath}` };
  }
  if (ev.noAccessMarker) return { state: 'BLOCKED', score: null, reason: 'AMP no-access page shown' };
  if (ev.denialText && !(frame && sectionDenial(ev, frame))) return { state: 'BLOCKED', score: null, reason: `page says "${ev.denialText}"` };
  if (isNoAccessPath(finalPath) || isNoAccessPath(redirect)) return { state: 'BLOCKED', score: null, reason: 'redirected to /noaccess' };
  if (ev.fragmentStatus === 404 || isNotFoundPath(finalPath) || isNotFoundPath(redirect)) {
    return { state: 'NOT_FOUND', score: null, reason: 'route not found on this site' };
  }
  // AMP's "Looks like you're lost / ERROR CODE: 404" screen with (almost) nothing else on the page.
  if (ev.notFoundText) {
    const others = frame ? [...new Set(ev.tokens)].filter((t) => !frame.tokens.has(t)).length : 0;
    if (others < SECTION_DENIAL_MIN_ELEMENTS) return { state: 'NOT_FOUND', score: null, reason: `AMP's "page not found" screen ("${ev.notFoundText.slice(0, 60)}")` };
  }
  if (isErrorPath(finalPath) || isErrorPath(redirect)) {
    return { state: 'ERROR', score: null, reason: `sent to AMP's error page (${isErrorPath(redirect) ? redirect : finalPath})` };
  }
  if ((ev.fragmentStatus ?? 0) >= 500) return { state: 'ERROR', score: null, reason: `server error (HTTP ${ev.fragmentStatus})` };
  return null;
}

export interface PageContent {
  /** Elements/headings on screen that are not part of the AMP frame. */
  tokens: string[];
  /** The page's own data calls that returned data. */
  dataApis: string[];
  /** The page's own data calls that AMP answered without a denial (with or without rows). */
  okApis: string[];
  has: boolean;
}

/**
 * What this user got beyond the AMP frame. An empty list is still a usable page: a heading plus the
 * page's own "No Data Found" message, or a data call AMP answered without a denial, counts as content.
 */
export function pageContent(ev: PageEvidence, frame: Frame): PageContent {
  const tokens = [...new Set(ev.tokens)].filter((t) => !frame.tokens.has(t));
  const own = ev.apiCalls.filter((a) => !frame.apis.has(a.func));
  const dataApis = [...new Set(own.filter((a) => a.hasData).map((a) => a.func))];
  const okApis = [...new Set(own.filter((a) => !a.denied && a.httpStatus < 400).map((a) => a.func))];
  const answered = dataApis.length >= 1 || okApis.length >= 1;
  const has =
    tokens.length >= MIN_CONTENT_ELEMENTS ||
    (tokens.length >= 1 && (answered || !!ev.emptyText)) ||
    (!!ev.emptyText && answered);
  return { tokens, dataApis, okApis, has };
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
  const hard = accessStateFromSignals(ev, frame);
  if (hard) return hard;

  const content = pageContent(ev, frame);
  const denied = deniedPageApis(ev, frame, ref);
  const score = ref ? fingerprintScore(ref, ev) : null;
  const like = score !== null && ref?.referenceUser ? ` · ${Math.round(score * 100)}% of ${ref.referenceUser}'s view` : '';
  const section = ev.denialText ? ` · one section says "${ev.denialText.slice(0, 80)}"` : '';

  if (ev.errorText && content.tokens.length < 3) return { state: 'ERROR', score, reason: `page shows "${ev.errorText}"` };
  if (content.has) {
    const data = content.dataApis.length ? ', data loaded' : ev.emptyText ? `, empty list: "${ev.emptyText.slice(0, 60)}"` : content.okApis.length ? ', data calls answered' : '';
    const what = `${content.tokens.length} page element${content.tokens.length === 1 ? '' : 's'}${data}`;
    const deniedFuncs = [...new Set(denied.map((d) => d.func))];
    // Pages made of widgets (dashboards) check permission per widget: some denied while most load is a
    // usable page. "Opens empty" only when denied calls are at least as many as those that returned data.
    if (deniedFuncs.length && deniedFuncs.length >= content.dataApis.length) {
      return { state: 'OPENED_EMPTY', score, reason: `page opened (${what}) but data calls were denied: ${deniedFuncs.join(', ')}${section}${like}` };
    }
    const partly = deniedFuncs.length ? ` · ${deniedFuncs.length} of ${deniedFuncs.length + content.dataApis.length} data calls denied (sections without permission): ${deniedFuncs.join(', ')}` : '';
    return { state: 'OPENED', score, reason: `page content shown (${what})${partly}${section}${like}` };
  }
  if (denied.length) return { state: 'BLOCKED', score, reason: `nothing shown and the page's data calls were denied: ${denied.map((d) => d.func).join(', ')}` };
  if (ev.pageErrors.length) return { state: 'ERROR', score, reason: `nothing rendered and the page script failed: ${ev.pageErrors[0]}` };
  return { state: 'BLANK', score, reason: 'only the AMP frame rendered (blank page)' };
}
