import type { Expected, Fingerprint, PageEvidence } from '../types';
import { accessStateFromSignals, pageContent, type Frame } from './state';

/** Evidence of every tested user: user type → route → what that user saw. */
export type EvidenceByUser = Map<string, Map<string, PageEvidence>>;

export interface PageReference extends Fingerprint {
  /** The user whose view of this page is the reference (saw the most of it). */
  referenceUser: string | null;
}

/**
 * Learns the AMP frame (menu, header, notifications…) that surrounds every page, so it can be
 * ignored when judging whether a user got page content:
 *  - everything seen on each user's "frame only" snapshot (a route that doesn't exist), and
 *  - elements / data calls present on at least half of all clean page views (needs ≥ 4 views).
 */
export function buildFrame(byUser: EvidenceByUser, baselines: PageEvidence[], share = 0.5): Frame {
  const tokens = new Set<string>();
  const apis = new Set<string>();
  for (const b of baselines) {
    b.tokens.forEach((t) => tokens.add(t));
    b.apiCalls.forEach((a) => apis.add(a.func));
  }
  const clean: PageEvidence[] = [];
  for (const pages of byUser.values()) for (const ev of pages.values()) if (accessStateFromSignals(ev) === null) clean.push(ev);
  if (clean.length >= 4) {
    const tf = new Map<string, number>();
    const af = new Map<string, number>();
    for (const ev of clean) {
      for (const t of new Set(ev.tokens)) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const f of new Set(ev.apiCalls.map((a) => a.func))) af.set(f, (af.get(f) ?? 0) + 1);
    }
    for (const [t, n] of tf) if (n / clean.length >= share) tokens.add(t);
    for (const [f, n] of af) if (n / clean.length >= share) apis.add(f);
  }
  return { tokens, apis };
}

/**
 * The reference view of one page: among users who got page content (no denial), the one who saw
 * the most — preferring users the rulebook expects to have access. Used as supporting evidence
 * (how much of it another user saw, whether the same data calls succeeded), never as the gate:
 * pages like dashboards legitimately differ per user.
 */
export function pickReference(route: string, byUser: EvidenceByUser, expected: Record<string, Expected>, frame: Frame): PageReference {
  let best: { user: string; ev: PageEvidence; tokens: string[]; yes: boolean } | null = null;
  for (const [user, pages] of byUser) {
    const ev = pages.get(route);
    if (!ev || accessStateFromSignals(ev) !== null) continue;
    const c = pageContent(ev, frame);
    if (!c.has) continue;
    const yes = expected[user] === 'Yes';
    if (!best || (yes && !best.yes) || (yes === best.yes && c.tokens.length > best.tokens.length)) best = { user, ev, tokens: c.tokens, yes };
  }
  if (!best) {
    return { route, tokens: [], apiFuncs: [], apiStatus: {}, usable: false, referenceUser: null, reason: 'no tested user got content on this page' };
  }
  const apiFuncs = [...new Set(best.ev.apiCalls.map((a) => a.func))].filter((f) => !frame.apis.has(f));
  const apiStatus: Record<string, number | null> = {};
  for (const a of best.ev.apiCalls) if (apiFuncs.includes(a.func)) apiStatus[a.func] = a.apiStatus;
  return { route, tokens: best.tokens, apiFuncs, apiStatus, usable: best.tokens.length > 0, referenceUser: best.user };
}

/** Share of the reference view's page content that is also on this user's screen (0..1). */
export function fingerprintScore(fp: Fingerprint | undefined, ev: PageEvidence): number | null {
  if (!fp || !fp.usable || fp.tokens.length === 0) return null;
  const seen = new Set(ev.tokens);
  const hit = fp.tokens.filter((t) => seen.has(t)).length;
  return Math.round((hit / fp.tokens.length) * 100) / 100;
}
