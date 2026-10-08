import { describe, expect, it } from 'vitest';
import type { ApiCall, PageEvidence } from '../src/modules/pages/types';
import { buildFrame, pickReference, type EvidenceByUser } from '../src/modules/pages/verdict/fingerprint';
import { accessState, type Frame } from '../src/modules/pages/verdict/state';
import { pageVerdict } from '../src/modules/pages/verdict/compare';
import { duplicateIdentities } from '../src/core/sessions/validate';

describe('duplicateIdentities', () => {
  it('flags a later row logged in as the same person (same name, same org)', () => {
    const id = (userType: string, userName: string, organizationId = 44649) => ({ userType, valid: true, userName, organizationId });
    const dups = duplicateIdentities([id('super_admin', 'Sahil Sharma'), id('user', 'Sahil Sharma'), id('partner', 'ayushmaan Singh')]);
    expect([...dups]).toEqual([['user', 'super_admin']]);
    expect(duplicateIdentities([id('a', 'Sam'), id('b', 'Sam', 7)]).size).toBe(0); // same name, different organization
  });
});

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
  it('an empty list is a usable page: heading + "No Data Found", or heading + data call answered without rows', () => {
    const contacts = (extra: Partial<PageEvidence>) => ev('connections/contacts', { tokens: [...FRAME, 'h:contacts'], ...extra });
    expect(accessState(contacts({ emptyText: 'No Data Found' }), frame).state).toBe('OPENED');
    expect(accessState(contacts({ apiCalls: [api('getcontactsforcurrentuser', { hasData: false })] }), frame).state).toBe('OPENED');
    expect(accessState(contacts({}), frame).state).toBe('BLANK'); // a heading alone is not enough
    expect(accessState(contacts({ apiCalls: [api('getcontactsforcurrentuser', { httpStatus: 401, denied: true, hasData: false })] }), frame).state).toBe('BLOCKED');
  });
  it('"no permission" inside one widget of a rendered dashboard is not a blocked page', () => {
    const dash = ev('dashboard/sales', {
      tokens: [...FRAME, 'id:widget-grid', 'id:eventsThisMonth', 'h:journey', 'h:permission needed', 'h:partner engagement scores', 'h:user report'],
      denialText: 'You do not have the permission. Please go to the "Help" menu above to contact support for further assistance.',
    });
    const r = accessState(dash, frame);
    expect(r.state).toBe('OPENED');
    expect(r.reason).toContain('one section says');
    // The same message on an otherwise empty page still blocks it.
    expect(accessState(ev('a', { tokens: [...FRAME, 'h:permission needed', 'id:msg'], denialText: 'You do not have the permission.' }), frame).state).toBe('BLOCKED');
  });
  it("AMP's error page is an error with a readable reason", () => {
    const r = accessState(ev('a', { fragmentStatus: 302, fragmentRedirect: '/error' }), frame);
    expect(r.state).toBe('ERROR');
    expect(r.reason).toBe("sent to AMP's error page (/error)");
  });
  it('dashboard with some widgets denied but most loading is OPENED; a list whose main call is denied is OPENED_EMPTY', () => {
    const ok = ['gettierdata', 'getcalendarevents', 'getorganizationdetail'].map((f) => api(f));
    const no = ['getcasefielddata', 'getemailsreport'].map((f) => api(f, { denied: true, hasData: false }));
    const dash = accessState(ev('dashboard/sales', { apiCalls: [...ok, ...no] }), frame);
    expect(dash.state).toBe('OPENED');
    expect(dash.reason).toContain('2 of 5 data calls denied');
    expect(accessState(ev('a', { apiCalls: [api('getfilters'), api('getlist', { denied: true, hasData: false })] }), frame).state).toBe('OPENED_EMPTY');
  });
  it('NOT_FOUND from AMP\'s "Looks like you\'re lost / ERROR CODE: 404" screen', () => {
    expect(accessState(ev('collateral/internal-playbok', { tokens: [...FRAME], notFoundText: 'Looks like you’re lost' }), frame).state).toBe('NOT_FOUND');
    // The words inside a real page with plenty of content don't make it a missing page.
    const article = ev('help/article', { tokens: [...FRAME, 'id:a1', 'id:a2', 'h:help', 'h:errors', 'h:faq'], notFoundText: 'Page not found' });
    expect(accessState(article, frame).state).toBe('OPENED');
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
    ['No', false, 'NOT_FOUND', none, 'REVIEW'], // link exists for nobody (typo?): never tested, so never a Pass
    ['No', false, 'NOT_FOUND', someone, 'PASS'], // others get the page, this user gets 404: as good as blocked
    ['No', false, 'OPENED', none, 'FAIL_SECURITY_GAP'],
    ['No', true, 'OPENED', none, 'FAIL_EXTRA_ACCESS'],
    ['No', false, 'OPENED_EMPTY', none, 'FAIL_SECURITY_GAP'],
    // Other
    [null, true, 'OPENED', none, 'NOT_SPECIFIED'],
    ['Yes', true, 'BAD_TOKEN', none, 'REVIEW'],
  ] as const)('expected %s, menu %s, state %s -> %s', (exp, menu, state, peers, verdict) => {
    expect(pageVerdict(exp, menu, state, { othersWithContent: [...peers.othersWithContent] }).verdict).toBe(verdict);
  });

  it('still loading when time ran out → Review, never a guessed pass/fail (but a real block still counts)', () => {
    expect(pageVerdict('Yes', true, 'BLANK', { othersWithContent: ['x'], stillLoading: true }).verdict).toBe('REVIEW');
    expect(pageVerdict('No', true, 'BLANK', { othersWithContent: [], stillLoading: true }).verdict).toBe('REVIEW');
    expect(pageVerdict('No', true, 'BLOCKED', { othersWithContent: [], stillLoading: true }).verdict).toBe('PASS');
    expect(pageVerdict('Yes', true, 'OPENED', { othersWithContent: [], stillLoading: true }).verdict).toBe('PASS');
  });
});
