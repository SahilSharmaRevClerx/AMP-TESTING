import { describe, expect, it } from 'vitest';
import type { ApiCall, PageEvidence } from '../src/types';
import { buildFrame, pickReference, type EvidenceByUser } from '../src/verdict/fingerprint';
import { accessState, type Frame } from '../src/verdict/state';
import { pageVerdict } from '../src/verdict/compare';

const BASE = 'https://aisb.amp.vg';
const FRAME = ['id:nav', 'id:header', 'h:notifications'];

function ev(route: string, extra: Partial<PageEvidence> = {}): PageEvidence {
  return {
    route,
    finalUrl: `${BASE}/#${route}`,
    fragmentStatus: 200,
    fragmentRedirect: null,
    noAccessMarker: false,
    apiCalls: [],
    blockedRequests: [],
    pageErrors: [],
    textLength: 1000,
    tokens: [...FRAME, `id:${route}-grid`, `h:${route} title`],
    title: '',
    screenshot: null,
    durationMs: 1,
    ...extra,
  };
}
const api = (func: string, extra: Partial<ApiCall> = {}): ApiCall => ({ func, httpStatus: 200, apiStatus: 0, denied: false, hasData: true, ...extra });
const byUser = (users: Record<string, PageEvidence[]>): EvidenceByUser => new Map(Object.entries(users).map(([u, list]) => [u, new Map(list.map((e) => [e.route, e]))]));
const frameOnly = (): PageEvidence => ev('__frame__', { tokens: [...FRAME], apiCalls: [api('getnotifications')] });

describe('buildFrame', () => {
  it('learns the AMP frame from the frame-only snapshot, even with few pages', () => {
    const f = buildFrame(byUser({ u: [ev('a')] }), [frameOnly()]);
    expect([...f.tokens].sort()).toEqual([...FRAME].sort());
    expect([...f.apis]).toEqual(['getnotifications']);
  });

  it('also learns it from what repeats on most pages when there is no snapshot', () => {
    const f = buildFrame(byUser({ u: ['a', 'b', 'c', 'd'].map((r) => ev(r)) }), []);
    expect([...f.tokens].sort()).toEqual([...FRAME].sort());
  });
});

describe('accessState — judged on the page itself, not by matching another user', () => {
  const frame: Frame = buildFrame(byUser({}), [frameOnly()]);

  it('OPENED when there is page content beyond the frame', () => {
    expect(accessState(ev('a'), frame).state).toBe('OPENED');
  });
  it('dashboards: different widgets per user both count as OPENED', () => {
    const admin = ev('dashboard', { tokens: [...FRAME, 'id:widget-revenue', 'id:widget-pipeline', 'h:company overview'] });
    const partner = ev('dashboard', { tokens: [...FRAME, 'id:widget-my-deals', 'id:widget-training'] });
    const ref = pickReference('dashboard', byUser({ admin: [admin], partner: [partner] }), { admin: 'Yes', partner: 'Yes' }, frame);
    expect(accessState(admin, frame, ref).state).toBe('OPENED');
    expect(accessState(partner, frame, ref).state).toBe('OPENED'); // 0% like the admin's view, still opened
  });
  it('BLANK when only the AMP frame rendered', () => {
    const r = accessState(ev('a', { tokens: [...FRAME] }), frame);
    expect(r.state).toBe('BLANK');
  });
  it('ERROR when the page shows an error message and nothing else', () => {
    expect(accessState(ev('a', { tokens: [...FRAME, 'h:oops'], errorText: 'Something went wrong' }), frame).state).toBe('ERROR');
  });
  it('BLOCKED on AMP no-access screen, own "no permission" message, or /noaccess', () => {
    expect(accessState(ev('a', { noAccessMarker: true }), frame).state).toBe('BLOCKED');
    expect(accessState(ev('a', { denialText: 'You do not have permission to view this page.' }), frame).state).toBe('BLOCKED');
    expect(accessState(ev('a', { fragmentStatus: 302, fragmentRedirect: '/noaccess' }), frame).state).toBe('BLOCKED');
  });
  it('BLOCKED when nothing rendered and the page data calls were denied', () => {
    expect(accessState(ev('a', { tokens: [...FRAME], apiCalls: [api('geta', { denied: true, hasData: false })] }), frame).state).toBe('BLOCKED');
  });
  it('OPENED_EMPTY when the page renders but its data calls are denied', () => {
    expect(accessState(ev('a', { apiCalls: [api('geta', { denied: true, hasData: false })] }), frame).state).toBe('OPENED_EMPTY');
  });
  it('BAD_TOKEN / NOT_FOUND from hard signals', () => {
    expect(accessState(ev('a', { finalUrl: `${BASE}/login` }), frame).state).toBe('BAD_TOKEN');
    expect(accessState(ev('a', { fragmentStatus: 404 }), frame).state).toBe('NOT_FOUND');
  });
});

describe('pickReference', () => {
  const frame: Frame = buildFrame(byUser({}), [frameOnly()]);
  it('prefers users the rulebook expects to have access, then who saw the most', () => {
    const views = byUser({
      partner: [ev('x', { tokens: [...FRAME, 'a', 'b', 'c', 'd'] })], // saw more but expected No
      manager: [ev('x', { tokens: [...FRAME, 'a', 'b'] })],
      user: [ev('x', { noAccessMarker: true })],
    });
    expect(pickReference('x', views, { partner: 'No', manager: 'Yes', user: 'Yes' }, frame).referenceUser).toBe('manager');
  });
  it('no reference when nobody got content (e.g. a No No No page)', () => {
    const views = byUser({ a: [ev('x', { noAccessMarker: true })], b: [ev('x', { tokens: [...FRAME] })] });
    const ref = pickReference('x', views, { a: 'No', b: 'No' }, frame);
    expect(ref.referenceUser).toBeNull();
  });
});

describe('pageVerdict', () => {
  const none = { othersWithContent: [] };
  const someone = { othersWithContent: ['Super Admin'] };
  it.each([
    // Rulebook Yes
    ['Yes', true, 'OPENED', none, 'PASS'],
    ['Yes', false, 'OPENED', none, 'PASS'], // not in a custom menu is not a failure
    ['Yes', true, 'OPENED_EMPTY', none, 'FAIL_OPENS_EMPTY'],
    ['Yes', true, 'BLOCKED', none, 'FAIL_MISSING_ACCESS'],
    ['Yes', true, 'BLANK', someone, 'FAIL_MISSING_ACCESS'], // others get the page, this user gets blank
    ['Yes', true, 'ERROR', someone, 'FAIL_MISSING_ACCESS'],
    ['Yes', true, 'BLANK', none, 'REVIEW'], // nobody got it: broken page, not a permission result
    ['Yes', true, 'NOT_FOUND', none, 'REVIEW'],
    // Rulebook No (incl. No No No rows)
    ['No', false, 'BLOCKED', none, 'PASS'],
    ['No', false, 'BLANK', none, 'PASS'],
    ['No', false, 'ERROR', none, 'PASS'],
    ['No', false, 'NOT_FOUND', none, 'PASS'],
    ['No', false, 'OPENED', none, 'FAIL_SECURITY_GAP'],
    ['No', true, 'OPENED', none, 'FAIL_EXTRA_ACCESS'],
    ['No', false, 'OPENED_EMPTY', none, 'FAIL_SECURITY_GAP'],
    // Other
    [null, true, 'OPENED', none, 'NOT_SPECIFIED'],
    ['Yes', true, 'BAD_TOKEN', none, 'REVIEW'],
  ] as const)('expected %s, menu %s, state %s -> %s', (exp, menu, state, peers, verdict) => {
    expect(pageVerdict(exp, menu, state, { othersWithContent: [...peers.othersWithContent] }).verdict).toBe(verdict);
  });
});
