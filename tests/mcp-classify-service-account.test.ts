/**
 * P15 T1: service-account sign-in failures. Every sentence below is AMP's own
 * (mint templates in McpServiceAccountToken.cs, prefix in MCPPromptRunner.cs:1266),
 * loaded from tests/fixtures/mcp-service-account-errors.json which is marked
 * "from AMP source, not a real answer". No network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyServerResponse } from '../src/modules/mcp/classify';

const run = (error: string) => classifyServerResponse(200, { error, tools: [] }, true);

interface Fixture {
  cite: string;
  note: string;
  error: string;
  expectState: string;
  expectBucket: string;
  expectCertainty: string;
}

const FIXTURES = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'mcp-service-account-errors.json'), 'utf8')) as Fixture[];

describe('service-account sign-in failures (one test per source sentence)', () => {
  it.each(FIXTURES.map((f) => [f.cite, f.error, f.expectState, f.expectBucket, f.expectCertainty] as const))(
    '%s',
    (_cite, error, state, bucket, certainty) => {
      const r = run(error);
      expect(r.state).toBe(state);
      expect(r.bucket).toBe(bucket);
      expect(r.certainty).toBe(certainty);
    },
  );
  it('every fixture is marked as source-derived, not a real answer', () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
    for (const f of FIXTURES) expect(f.note).toMatch(/from AMP source, not a real answer/);
  });
  it('the refused hint names the HTTP status from the sentence', () => {
    const r = run("This connector's service account could not sign in: The token endpoint h refused the service account (HTTP 401): invalid_client");
    expect(r.state).toBe('SERVICE_ACCOUNT_REFUSED');
    expect(r.hint).toContain('HTTP 401');
  });
  it('a refused 401 is Fix needed (connector owner), NOT a reconnect', () => {
    const r = run("This connector's service account could not sign in: The token endpoint h refused the service account (HTTP 401): x");
    expect(r.bucket).toBe('BROKEN');
    expect(r.hint).toMatch(/connector owner/);
  });
  it('an unreachable token endpoint classifies UNREACHABLE, so the retry-once applies', () => {
    expect(run("This connector's service account could not sign in: Could not reach the token endpoint h: timeout").state).toBe('UNREACHABLE');
  });
});

describe('a vendor quote inside the template cannot trigger service-account rules', () => {
  it('signing-key words after "Server said:" are ignored', () => {
    const r = run('Could not list tools from the MCP server: authentication failed (401). Please reconnect. Server said: A signing key is required.');
    expect(r.state).toBe('OAUTH_EXPIRED');
  });
  it('a bare prefix with only a vendor quote falls through to Unrecognised', () => {
    const r = run("This connector's service account could not sign in: Server said: A signing key is required.");
    expect(r.state).toBe('UNKNOWN_ERROR');
    expect(r.certainty).toBe('low');
  });
  it('refused words after "Server said:" are ignored', () => {
    const r = run('Could not list tools from the MCP server: access denied (403). No. Server said: refused the service account (HTTP 401): x');
    expect(r.state).toBe('FORBIDDEN');
  });
});
