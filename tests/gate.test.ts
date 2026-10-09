import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSafeEnvironment, checkWorkflowListBody, decideBrowserRequest, isReadOnlyApiFunc, RequestGate, SafetyError } from '../src/core/safety/gate';
import { AuditLog } from '../src/core/util/audit';

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

describe('RequestGate (P08 MCP Connector Health, Phase 0 read-only)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-mcp-'));
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  const gate = new RequestGate({ name: 'AISB', baseUrl: `https://${HOST}`, isProduction: false }, 0, audit);

  it.each(['getmcpservers', 'getmcpservertools'])('allows POST api.ashx?func=%s', (f) => {
    expect(gate.checkToolRequest('POST', new URL(api(f)))).toBeNull();
  });

  it.each([
    'savemcpserver',
    'deletemcpserver',
    'callmcptools',
    'CallMCPTools',
    'approvemcptool',
    'ApproveMCPTool',
    'mcptoolpermission',
    'savemptoolpermission',
    'getmcptoolpermission',
  ])('keeps POST api.ashx?func=%s blocked in Phase 0', (f) => {
    expect(gate.checkToolRequest('POST', new URL(api(f)))).toMatch(/not allow-listed/);
  });

  it('keeps GET /api/<Func> blocked for the tool (including the MCP reads)', () => {
    expect(gate.checkToolRequest('GET', new URL(`https://${HOST}/api/GetMCPServers`))).toMatch(/GET to api endpoint/);
    expect(gate.checkToolRequest('GET', new URL(`https://${HOST}/api/GetMCPServerTools`))).toMatch(/GET to api endpoint/);
  });

  it('keeps POST /api/<Func> blocked for the tool (route proof pending, P08 T1)', () => {
    expect(gate.checkToolRequest('POST', new URL(`https://${HOST}/api/GetMCPServers`))).toMatch(/POST only allowed/);
    expect(gate.checkToolRequest('POST', new URL(`https://${HOST}/api/GetMCPServerTools`))).toMatch(/POST only allowed/);
  });

  it('allows the workflow-list GETs the module reads (no login required on AMP)', () => {
    expect(gate.checkToolRequest('GET', new URL(`https://${HOST}/api/elsa-agents/workflow-definitions`))).toBeNull();
    expect(gate.checkToolRequest('GET', new URL(`https://${HOST}/api/elsa-agents/workflow-definitions/abc123`))).toBeNull();
  });

  it.each(['POST', 'PUT', 'DELETE'])('keeps %s to /api/elsa-agents blocked', (m) => {
    expect(gate.checkToolRequest(m, new URL(`https://${HOST}/api/elsa-agents/workflow-definitions`))).not.toBeNull();
  });
});

describe('RequestGate (P14 workflow-kind labels, read-only)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-p14-'));
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  const gate = new RequestGate({ name: 'AISB', baseUrl: `https://${HOST}`, isProduction: false }, 0, audit);
  const goodBody = {
    type: 'definitions',
    isPublished: true,
    isPublic: false,
    hasCategory: false,
    isAgentic: false,
    page: 0,
    pageSize: 1000,
    Page: 0,
    PageSize: 1000,
    sort: 'updatedon',
    ascending: false,
    search: '',
    filters: [],
    condition: false,
    format: 4,
  };

  it('allows the narrow workflow-list POST with the pinned body shape', () => {
    expect(gate.checkToolRequest('POST', new URL(`https://${HOST}/api/GetAIAutomationWorkflows`))).toBeNull();
    expect(checkWorkflowListBody(goodBody)).toBeNull();
  });

  it.each([
    { body: { ...goodBody, type: 'instances' }, why: 'wrong type' },
    { body: { ...goodBody, isPublished: undefined }, why: 'missing flag' },
    { body: { ...goodBody, isPublic: 'yes' }, why: 'non-boolean flag' },
    { body: { ...goodBody, pageSize: 5000 }, why: 'oversized page' },
    { body: { ...goodBody, extra: 1 }, why: 'unknown field' },
    { body: 'definitions', why: 'non-object body' },
    { body: null, why: 'null body' },
  ])('refuses a different body ($why)', ({ body }) => {
    expect(checkWorkflowListBody(body)).not.toBeNull();
  });

  it.each([
    `https://${HOST}/api/GetAIAutomationWorkflow`,
    `https://${HOST}/api/SaveAIAutomationWorkflow`,
    `https://${HOST}/api/GetAIAutomationWorkflows/extra`,
    `https://${HOST}/api/GetMCPServers`,
  ])('refuses a different path (%s)', (u) => {
    expect(gate.checkToolRequest('POST', new URL(u))).not.toBeNull();
  });

  it('refuses a write-like name on the api.ashx path as before', () => {
    expect(gate.checkToolRequest('POST', new URL(api('callmcptools')))).toMatch(/not allow-listed/);
  });

  it('lets the designer Latest GET through (reads one workflow graph, version pinned in the URL)', () => {
    expect(gate.checkToolRequest('GET', new URL(`https://${HOST}/elsa/api/workflow-definitions/by-definition-id/abc123?versionOptions=Latest`))).toBeNull();
    expect(gate.checkToolRequest('GET', new URL(`https://${HOST}/elsa/api/workflow-definitions/by-definition-id/abc123?versionOptions=Published`))).toBeNull();
  });
});
