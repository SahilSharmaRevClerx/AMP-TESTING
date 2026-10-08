/**
 * P12 T3: the classifier against AMP's own sentences (from D:\git MCPPromptRunner.cs / MCPClientService.cs, cited per row)
 * and against the real, scrubbed error messages saved from sandbox runs (tests/fixtures/mcp-real-errors.json).
 * No network. The fixture holds only error text: hosts, URLs, emails and long token-like strings were redacted.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyServerResponse } from '../src/modules/mcp/classify';

const run = (error: string, extra: Record<string, unknown> = {}) => classifyServerResponse(200, { error, tools: [], ...extra }, true);
const P = 'Could not list tools from the MCP server: ';

describe('AMP templates (golden table; one row per sentence AMP builds)', () => {
  it.each([
    // [AMP file:line, sentence, state, group, certainty]
    ['MCPPromptRunner.cs:1066', `${P}authentication failed (401). Your access token may be expired or not accepted by this server — please reconnect via your profile settings.`, 'OAUTH_EXPIRED', 'MAYBE', 'high'],
    ['MCPPromptRunner.cs:1068', `${P}access denied (403). Your account is missing the required permissions/scopes. Reconnect with broader permissions or contact an administrator.`, 'FORBIDDEN', 'BROKEN', 'high'],
    ['MCPPromptRunner.cs:1070', `${P}endpoint not found (404). The server URL in the connector configuration is incorrect.`, 'URL_404', 'BROKEN', 'high'],
    ['MCPPromptRunner.cs:1072', `${P}rate limit exceeded (429). Please wait a moment and try again.`, 'RATE_LIMITED', 'MAYBE', 'high'],
    ['MCPPromptRunner.cs:1074', `${P}it is currently unavailable (503). Please try again later.`, 'UNREACHABLE', 'BROKEN', 'high'],
    ['MCPPromptRunner.cs:1195', 'This MCP server is not connected to your account. Please authenticate via your profile settings.', 'NOT_CONNECTED', 'NEEDS_YOU', 'high'],
    ['MCPPromptRunner.cs:1200', "This MCP server's connector is misconfigured (missing endpoint URL). Please contact an administrator.", 'MISCONFIGURED', 'BROKEN', 'high'],
    ['MCPPromptRunner.cs:1263', 'This MCP server has no configuration. Please edit it and set a server URL.', 'MISCONFIGURED', 'BROKEN', 'high'],
    ['MCPPromptRunner.cs:1187', 'Your session has expired. Please sign in again.', 'OAUTH_EXPIRED', 'MAYBE', 'high'],
    ['MCPPromptRunner.cs:1245', 'MCP server #42 was not found. It may have been deleted.', 'URL_404', 'BROKEN', 'high'],
    ['MCPClientService.cs:305', `${P}MCP server returned a 301 redirect to 'https://example.test/mcp'. Redirects are not followed; point the connector at its final URL.`, 'REDIRECT', 'BROKEN', 'high'],
    ['MCPClientService.cs:325', `${P}MCP server returned non-JSON response (content-type: text/html): <html>login</html>`, 'HTML_NOT_MCP', 'BROKEN', 'high'],
  ] as const)('%s -> %s', (_cite, sentence, state, group, certainty) => {
    const r = run(sentence);
    expect(r.state).toBe(state);
    expect(r.bucket).toBe(group);
    expect(r.certainty).toBe(certainty);
  });

  it('authRequired flag alone is OAUTH_EXPIRED, high (GetMCPServerTools.cs:58)', () => {
    const r = classifyServerResponse(200, { authRequired: true, tools: [] }, true);
    expect(r.state).toBe('OAUTH_EXPIRED');
    expect(r.certainty).toBe('high');
  });
});

describe('deployed-AMP wording that D:\\git does not have (seen in 28+ real sandbox answers)', () => {
  const REAL_KEY_MSG = `${P}it rejected the key in this connector's Headers (401). Check the API key and the server URL, then save and try again. Server said: (no body) WWW-Authenticate: Bearer error="invalid_token"`;
  it('a rejected key is Fix needed (KEY_REJECTED, high), NOT a reconnect, even though the text says (401)', () => {
    const r = run(REAL_KEY_MSG);
    expect(r.state).toBe('KEY_REJECTED');
    expect(r.bucket).toBe('BROKEN');
    expect(r.certainty).toBe('high');
  });
  it("the same sentence without the apostrophe still matches", () => {
    expect(run(`${P}it rejected the key in this connectors Headers (401).`).state).toBe('KEY_REJECTED');
  });
});

describe('vendor text after "Server said:" never outranks AMP\'s own sentence', () => {
  it.each([
    ['vendor says "rejected the key" inside AMP\'s 403 template', `${P}access denied (403). Your account is missing the required permissions/scopes. Server said: the gateway rejected the key in Headers`, 'FORBIDDEN'],
    ['vendor page says 404 and expired inside AMP\'s 401 template', `${P}authentication failed (401). Please reconnect. Server said: 404 Not Found: this link has expired`, 'OAUTH_EXPIRED'],
    ['vendor says "No such host" inside AMP\'s 503 template', `${P}it is currently unavailable (503). Please try again later. Server said: No such host is known`, 'UNREACHABLE'],
  ])('%s', (_name, text, state) => {
    expect(run(text).state).toBe(state);
  });
  it('unquoted vendor passthrough (no AMP template) still classifies, but only at medium', () => {
    const r = run(`${P}No such host is known. (abc.example:443)`);
    expect(r.state).toBe('DEAD_HOST');
    expect(r.certainty).toBe('medium');
  });
});

describe('tricky and reworded messages', () => {
  it('a port or id that looks like a status code does not decide the cause', () => {
    expect(run(`${P}connection failed to tunnel.example:4040 for request 5031234`).state).toBe('UNKNOWN_ERROR');
  });
  it('a reworded AMP message falls to UNKNOWN_ERROR (Fix needed, low) instead of a guessed cause', () => {
    const r = run('The connector could not be contacted right now, reason code XJ-9.');
    expect(r.state).toBe('UNKNOWN_ERROR');
    expect(r.bucket).toBe('BROKEN');
    expect(r.certainty).toBe('low');
  });
});

interface Real { error: string; wasState: string; expectState: string; expectCertainty: string; groupChangesVsOld: boolean }
const REAL = JSON.parse(readFileSync(new URL('./fixtures/mcp-real-errors.json', import.meta.url), 'utf8')) as Real[];

describe(`real sandbox messages (scrubbed fixture, ${REAL.length} distinct)`, () => {
  it('fixture is non-trivial and holds no jwt-like, email-like or URL-with-query text', () => {
    expect(REAL.length).toBeGreaterThan(40);
    for (const r of REAL) {
      expect(r.error).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
      expect(r.error).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(r.error).not.toMatch(/https?:\/\/(?!\[host\])/);
      expect(r.error).not.toMatch(/\?[A-Za-z0-9_]+=/);
    }
  });
  it.each(REAL.map((r, i) => [i, r] as const))('#%i classifies as recorded', (_i, r) => {
    const v = classifyServerResponse(200, { error: r.error, tools: [] }, true);
    expect(v.state).toBe(r.expectState);
    expect(v.certainty).toBe(r.expectCertainty);
  });
  it('NO real message changed group versus the earlier classifier, except AMP\'s 403 template (Reconnect to Fix needed, decided 2026-10-07)', () => {
    const moved = REAL.filter((r) => r.groupChangesVsOld);
    for (const r of moved) {
      expect(r.expectState).toBe('FORBIDDEN');
      expect(r.error).toMatch(/access denied \(403\)/);
    }
  });
  it('every rejected-key message from deployed AMP stays KEY_REJECTED / Fix needed', () => {
    const keyMsgs = REAL.filter((r) => /rejected the key in this connector/i.test(r.error));
    expect(keyMsgs.length).toBeGreaterThan(10);
    for (const r of keyMsgs) expect(classifyServerResponse(200, { error: r.error }, true).bucket).toBe('BROKEN');
  });
});
