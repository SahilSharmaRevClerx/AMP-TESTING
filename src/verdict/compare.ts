import type { AccessState, Expected, Verdict } from '../types';

export interface VerdictResult {
  verdict: Verdict;
  reason: string;
}

/** What other tested users experienced on the same page. */
export interface PeerContext {
  /** Other user types who got the page's content. */
  othersWithContent: string[];
}

/**
 * Rulebook Yes/No versus what the user got. The question is "did this user get a usable page?",
 * and the expectation says how to read a page that isn't usable:
 *
 *                 | usable content          | blocked / blank / error / not found
 *   Rulebook Yes  | Pass                    | Fail (missing access) — or Review if nobody got the page
 *   Rulebook No   | Fail (extra access /    | Pass (nothing usable)
 *                 |  security gap)          |
 *
 * The menu never decides pass/fail (clients customise menus); it only upgrades "extra access" to
 * "security gap" when the page is hidden from the menu yet opens by URL.
 */
export function pageVerdict(expected: Expected, inMenu: boolean, state: AccessState | null, peers: PeerContext = { othersWithContent: [] }): VerdictResult {
  const menu = inMenu ? 'shown in menu' : 'not in menu';
  if (state === null) return { verdict: 'REVIEW', reason: 'page was not tested' };
  if (state === 'BAD_TOKEN') return { verdict: 'REVIEW', reason: 'session expired or invalid during the run' };
  if (state === 'UNCLEAR') return { verdict: expected === null ? 'NOT_SPECIFIED' : 'REVIEW', reason: `unclear; ${menu}` };

  const usable = state === 'OPENED' || state === 'OPENED_EMPTY';
  const what: Partial<Record<AccessState, string>> = {
    BLOCKED: 'page is blocked',
    BLANK: 'page is blank',
    ERROR: 'page shows an error',
    NOT_FOUND: 'route not found',
  };
  if (expected === null) return { verdict: 'NOT_SPECIFIED', reason: `rulebook has no Yes/No; ${usable ? 'page opens' : what[state]}; ${menu}` };

  if (expected === 'Yes') {
    if (state === 'OPENED') return { verdict: 'PASS', reason: `page opens; ${menu}` };
    if (state === 'OPENED_EMPTY') return { verdict: 'FAIL_OPENS_EMPTY', reason: `page opens but its data is denied; ${menu}` };
    if (state === 'BLOCKED') return { verdict: 'FAIL_MISSING_ACCESS', reason: `page is blocked; ${menu}` };
    // BLANK / ERROR / NOT_FOUND: a real access problem if someone else got the page, otherwise the page itself is broken.
    if (peers.othersWithContent.length) {
      return { verdict: 'FAIL_MISSING_ACCESS', reason: `${what[state]} for this user while ${peers.othersWithContent.join(', ')} get the page; ${menu}` };
    }
    return { verdict: 'REVIEW', reason: `${what[state]} and no tested user got this page (broken page or wrong route?); ${menu}` };
  }

  // expected === 'No'
  if (!usable) return { verdict: 'PASS', reason: `${what[state]} (nothing usable); ${menu}` };
  const how = state === 'OPENED' ? 'page opens' : 'page opens (its data is denied)';
  return inMenu
    ? { verdict: 'FAIL_EXTRA_ACCESS', reason: `${how}; shown in menu` }
    : { verdict: 'FAIL_SECURITY_GAP', reason: `${how} by URL although hidden from the menu` };
}

export const VERDICT_ORDER: Verdict[] = [
  'FAIL_SECURITY_GAP',
  'FAIL_EXTRA_ACCESS',
  'FAIL_MISSING_ACCESS',
  'FAIL_OPENS_EMPTY',
  'REVIEW',
  'NOT_SPECIFIED',
  'PASS',
];
