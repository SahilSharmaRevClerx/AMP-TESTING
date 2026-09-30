import type { AccessState, Expected, Verdict } from '../types';

export interface VerdictResult {
  verdict: Verdict;
  reason: string;
}

/**
 * Compares the rulebook's Yes/No with whether the page actually opened for the user.
 * The menu never decides pass/fail (clients customise menus); it only sharpens the label:
 * a page that should be hidden, is missing from the menu, yet opens by URL is a security gap.
 */
export function pageVerdict(expected: Expected, inMenu: boolean, state: AccessState | null): VerdictResult {
  const menu = inMenu ? 'shown in menu' : 'not in menu';
  if (state === null) return { verdict: 'REVIEW', reason: 'page was not tested' };
  if (state === 'BAD_TOKEN' || state === 'ERROR' || state === 'UNCLEAR' || state === 'NOT_FOUND') {
    return { verdict: expected === null ? 'NOT_SPECIFIED' : 'REVIEW', reason: `${state.toLowerCase().replace('_', ' ')}; ${menu}` };
  }
  if (expected === null) return { verdict: 'NOT_SPECIFIED', reason: `rulebook has no Yes/No; actual: ${state}, ${menu}` };

  if (expected === 'Yes') {
    if (state === 'OPENED') return { verdict: 'PASS', reason: `page opens; ${menu}` };
    if (state === 'OPENED_EMPTY') return { verdict: 'FAIL_OPENS_EMPTY', reason: `page opens but its data is denied; ${menu}` };
    return { verdict: 'FAIL_MISSING_ACCESS', reason: `page is blocked; ${menu}` };
  }

  // expected === 'No'
  if (state === 'BLOCKED') return { verdict: 'PASS', reason: `page is blocked; ${menu}` };
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
