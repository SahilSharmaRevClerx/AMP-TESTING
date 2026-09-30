import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSafeEnvironment, decideBrowserRequest, isReadOnlyApiFunc, RequestGate, SafetyError } from '../src/safety/gate';
import { AuditLog } from '../src/util/audit';

const HOST = 'aisb.amp.vg';
const api = (func: string) => `https://${HOST}/services/api.ashx?func=${func}`;

describe('isReadOnlyApiFunc', () => {
  it.each(['getusers', 'GetNavigationTopBanner', 'loadpagewithpageid', 'checkgoalachieved', 'hascasesharingaccess'])('%s is read-only', (f) =>
    expect(isReadOnlyApiFunc(f)).toBe(true),
  );
  it.each(['savecontact', 'deleteorganizations', 'getoraddfilter', 'getandsavetwiliocallrecord', 'updatelastviewedforcontactplaybook', 'quickemailsend', ''])(
    '%s is treated as a write',
    (f) => expect(isReadOnlyApiFunc(f)).toBe(false),
  );
});

describe('decideBrowserRequest', () => {
  it('allows GET page loads and assets, including other hosts', () => {
    expect(decideBrowserRequest('GET', `https://${HOST}/setup/roles`, HOST).allowed).toBe(true);
    expect(decideBrowserRequest('GET', 'https://cdn.example.com/x.js', HOST).allowed).toBe(true);
  });
  it('allows POST only for read-only APIs', () => {
    expect(decideBrowserRequest('POST', api('getusers'), HOST).allowed).toBe(true);
    expect(decideBrowserRequest('POST', api('saverole'), HOST).allowed).toBe(false);
    expect(decideBrowserRequest('POST', api('getusers,deleteusers'), HOST).allowed).toBe(false);
    expect(decideBrowserRequest('POST', `https://${HOST}/services/api.ashx`, HOST).allowed).toBe(false);
  });
  it('treats /api/<FuncName> (deployed AMP) like api.ashx', () => {
    expect(decideBrowserRequest('POST', `https://${HOST}/api/GetProfileDetails`, HOST).allowed).toBe(true);
    expect(decideBrowserRequest('POST', `https://${HOST}/api/getInteractiveBannerTemplate`, HOST).allowed).toBe(true);
    expect(decideBrowserRequest('POST', `https://${HOST}/api/SaveContact`, HOST).allowed).toBe(false);
    expect(decideBrowserRequest('POST', `https://${HOST}/api/GetOrAddFilter`, HOST).allowed).toBe(false);
    expect(decideBrowserRequest('POST', `https://${HOST}/api/a/b`, HOST).allowed).toBe(false);
    expect(decideBrowserRequest('POST', `https://${HOST}/bridge/ask/ai?isdashboardwidget=true`, HOST).allowed).toBe(false);
  });

  it('blocks non-GET to other endpoints/hosts and any logout', () => {
    expect(decideBrowserRequest('POST', `https://${HOST}/upload.ashx`, HOST).allowed).toBe(false);
    expect(decideBrowserRequest('POST', 'https://tracker.example.com/beacon', HOST).allowed).toBe(false);
    expect(decideBrowserRequest('GET', `https://${HOST}/logout`, HOST).allowed).toBe(false);
    expect(decideBrowserRequest('PUT', api('getusers'), HOST).allowed).toBe(true); // read-only api regardless of verb
  });
});

describe('environment guard', () => {
  it('refuses production unless overridden, and plain http for remote hosts', () => {
    expect(() => assertSafeEnvironment({ name: 'prod', baseUrl: `https://${HOST}`, isProduction: true })).toThrow(SafetyError);
    expect(() => assertSafeEnvironment({ name: 'prod', baseUrl: `https://${HOST}`, isProduction: true, allowProduction: true })).not.toThrow();
    expect(() => assertSafeEnvironment({ name: 'x', baseUrl: `http://${HOST}`, isProduction: false })).toThrow(SafetyError);
    expect(() => assertSafeEnvironment({ name: 'local', baseUrl: 'http://localhost:5000', isProduction: false })).not.toThrow();
  });
});

describe('RequestGate (tool requests)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  const gate = new RequestGate({ name: 'AISB', baseUrl: `https://${HOST}`, isProduction: false }, 0, audit);
  const creds = { jwt: 'jwt-secret-value-123', csrf: 'csrf-secret-value-456' };

  it('only allows the allow-listed API and same-host GETs', () => {
    expect(gate.checkToolRequest('POST', new URL(api('getpermissiondataforuser')))).toBeNull();
    expect(gate.checkToolRequest('POST', new URL(api('getusers')))).toMatch(/not allow-listed/);
    expect(gate.checkToolRequest('GET', new URL(`https://${HOST}/`))).toBeNull();
    expect(gate.checkToolRequest('GET', new URL('https://evil.example.com/'))).toMatch(/not the configured/);
    expect(gate.checkToolRequest('DELETE', new URL(`https://${HOST}/`))).toMatch(/not allowed/);
  });

  it('throws and audits a blocked request without sending it', async () => {
    await expect(gate.fetch('x', 'POST', new URL(api('saverole')), creds)).rejects.toThrow(SafetyError);
    const log = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    expect(log).toContain('"decision":"blocked"');
  });
});
