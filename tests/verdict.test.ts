import { describe, expect, it } from 'vitest';
import type { PageEvidence } from '../src/types';
import { buildFingerprints, fingerprintScore } from '../src/verdict/fingerprint';
import { accessState } from '../src/verdict/state';
import { pageVerdict } from '../src/verdict/compare';

const BASE = 'https://aisb.amp.vg';
const SHELL = ['id:nav', 'id:header', 'h:dashboard'];

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
    tokens: [...SHELL, `id:${route}-grid`, `h:${route} title`],
    title: '',
    screenshot: null,
    durationMs: 1,
    ...extra,
  };
}

const routes = ['a', 'b', 'c', 'd', 'e'];
const calibration = routes.map((r) => ev(r, { apiCalls: [{ func: `get${r}`, httpStatus: 200, apiStatus: 0, denied: false }, { func: 'getnotifications', httpStatus: 200, apiStatus: 0, denied: false }] }));
const fps = buildFingerprints(calibration);

describe('buildFingerprints', () => {
  it('removes shell tokens and shell APIs that appear on most pages', () => {
    const fp = fps.get('a')!;
    expect(fp.tokens.sort()).toEqual(['h:a title', 'id:a-grid']);
    expect(fp.apiFuncs).toEqual(['geta']);
    expect(fp.usable).toBe(true);
  });

  it('marks pages the calibration user could not open as unusable', () => {
    const f = buildFingerprints([...calibration, ev('z', { noAccessMarker: true })]);
    expect(f.get('z')!.usable).toBe(false);
  });
});

describe('accessState', () => {
  const fp = fps.get('a');
  it('OPENED when fingerprint matches', () => {
    expect(accessState(ev('a'), fp, 0.6).state).toBe('OPENED');
    expect(fingerprintScore(fp, ev('a'))).toBe(1);
  });
  it('BLOCKED on the no-access marker even with HTTP 200', () => {
    expect(accessState(ev('a', { noAccessMarker: true }), fp, 0.6).state).toBe('BLOCKED');
  });
  it('BLOCKED on redirect to /noaccess', () => {
    expect(accessState(ev('a', { fragmentStatus: 302, fragmentRedirect: '/noaccess' }), fp, 0.6).state).toBe('BLOCKED');
  });
  it('BAD_TOKEN on login redirect', () => {
    expect(accessState(ev('a', { finalUrl: `${BASE}/login` }), fp, 0.6).state).toBe('BAD_TOKEN');
  });
  it('NOT_FOUND on 404', () => {
    expect(accessState(ev('a', { fragmentStatus: 404 }), fp, 0.6).state).toBe('NOT_FOUND');
  });
  it('OPENED_EMPTY when the page loads but its own API is denied', () => {
    const e = ev('a', { apiCalls: [{ func: 'geta', httpStatus: 200, apiStatus: 5, denied: false }] });
    expect(accessState(e, fp, 0.6).state).toBe('OPENED_EMPTY');
  });
  it('UNCLEAR when only the shell shows and nothing says denied', () => {
    expect(accessState(ev('a', { tokens: SHELL }), fp, 0.6).state).toBe('UNCLEAR');
  });
});

describe('pageVerdict', () => {
  it.each([
    ['Yes', true, 'OPENED', 'PASS'],
    ['Yes', false, 'OPENED', 'PASS'], // not in the (custom) menu is not a failure
    ['No', false, 'BLOCKED', 'PASS'],
    ['No', true, 'BLOCKED', 'PASS'],
    ['No', false, 'OPENED', 'FAIL_SECURITY_GAP'],
    ['No', false, 'OPENED_EMPTY', 'FAIL_SECURITY_GAP'],
    ['No', true, 'OPENED', 'FAIL_EXTRA_ACCESS'],
    ['Yes', false, 'BLOCKED', 'FAIL_MISSING_ACCESS'],
    ['Yes', true, 'BLOCKED', 'FAIL_MISSING_ACCESS'],
    ['Yes', true, 'OPENED_EMPTY', 'FAIL_OPENS_EMPTY'],
    ['Yes', true, 'UNCLEAR', 'REVIEW'],
    [null, true, 'OPENED', 'NOT_SPECIFIED'],
  ] as const)('expected %s, menu %s, state %s -> %s', (exp, menu, state, verdict) => {
    expect(pageVerdict(exp, menu, state).verdict).toBe(verdict);
  });
});