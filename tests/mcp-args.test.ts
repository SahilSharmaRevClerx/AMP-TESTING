/**
 * P15 T3: fixed-argument check. Key names are kept, VALUES never are.
 * Table of node shapes (extraction + compare), a values-leak test over a
 * full run result and its saved snapshot file, and a snapshot round-trip.
 * No network.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkArgs, type ToolSchemaFields } from '../src/modules/mcp/classify';
import { extractMcpNodes } from '../src/modules/mcp/nodes';
import { runMcpHealth } from '../src/modules/mcp/run';
import { loadPrevious } from '../src/modules/mcp/snapshot';

const literal = (value: unknown) => ({ expression: { type: 'Literal', value } });
const node = (inputs: Record<string, unknown>) => extractMcpNodes({ activities: [{ type: 'ElsaServer.Activities.GmailMCP', inputs }] }, 'W').nodes[0]!;

const SCHEMAS: ToolSchemaFields[] = [
  { name: 'search', fields: [{ name: 'query', type: 'string' }, { name: 'when', type: 'string' }], required: ['query'] },
  { name: 'ping', fields: [], required: [] },
];

describe('argKeys extraction (names only, never values)', () => {
  it('keeps top-level keys of a Literal JSON object', () => {
    const n = node({ mcpServerId: literal(4), toolName: literal('search'), argumentsJson: literal('{"query":"is:unread","maxResults":10}') });
    expect(n.argKeys).toEqual(['query', 'maxResults']);
  });
  it('reads the ArgumentsJson casing and the direct-on-activity shape', () => {
    const a = node({ mcpServerId: literal(4), toolName: literal('t'), ArgumentsJson: literal('{"a":1}') });
    expect(a.argKeys).toEqual(['a']);
    const b = extractMcpNodes({ root: { type: 'x-mcp', argumentsJson: literal('{"b":2}') } }, 'W').nodes[0]!;
    expect(b.argKeys).toEqual(['b']);
  });
  it.each([
    ['array JSON', '["a"]'],
    ['non-object JSON', '"str"'],
    ['number JSON', '5'],
    ['empty text', ''],
    ['blank text', '   '],
    ['unparseable text', '{oops'],
  ])('%s leaves argKeys absent', (_label, value) => {
    expect(node({ mcpServerId: literal(4), toolName: literal('t'), argumentsJson: literal(value) }).argKeys).toBeUndefined();
  });
  it('a non-Literal expression leaves argKeys absent', () => {
    const n = node({ mcpServerId: literal(4), toolName: literal('t'), argumentsJson: { expression: { type: 'Variable', value: 'args' } } });
    expect(n.argKeys).toBeUndefined();
  });
  it('no arguments input leaves argKeys absent (old nodes unchanged)', () => {
    expect(node({ mcpServerId: literal(4), toolName: literal('t') })).toEqual({ workflow: 'W', serverId: 4, serverName: undefined, tool: 't', toolNames: undefined });
  });
});

describe('checkArgs (compare keys with the schema)', () => {
  it.each([
    ['fixed ok', ['query', 'when'], undefined, 'search', 'ok', [], []],
    ['missing required', ['when'], undefined, 'search', 'missing', ['query'], []],
    ['missing and extra', ['zzz'], undefined, 'search', 'missing', ['query'], ['zzz']],
    ['extra key only', ['query', 'zzz'], undefined, 'search', 'extra', [], ['zzz']],
    ['no fixed tool name', ['query'], undefined, undefined, 'not_checked', [], []],
    ['AI-agent toolNames', ['query'], ['a', 'b'], 'search', 'not_checked', [], []],
    ['tool missing from the list', ['query'], undefined, 'gone', 'not_checked', [], []],
    ['no keys (not a fixed object)', undefined, undefined, 'search', 'not_checked', [], []],
    ['schema without properties', ['query'], undefined, 'ping', 'not_checked', [], []],
  ])('%s', (_label, keys, names, tool, state, missing, extra) => {
    const r = checkArgs(keys as string[] | undefined, names as string[] | undefined, tool as string | undefined, SCHEMAS);
    expect(r.state).toBe(state);
    expect(r.missing ?? []).toEqual(missing);
    expect(r.extra ?? []).toEqual(extra);
  });
  it('required without properties still reports missing, with no extras', () => {
    const r = checkArgs(['other'], undefined, 'req', [{ name: 'req', fields: [], required: ['need'] }]);
    expect(r).toEqual({ state: 'missing', missing: ['need'] });
  });
  it('tolerates old schemas without a required list', () => {
    const r = checkArgs(['a'], undefined, 'old', [{ name: 'old', fields: [{ name: 'a', type: 'string' }] } as ToolSchemaFields]);
    expect(r.state).toBe('ok');
  });
  it('never changes the health bucket (checked at the row level below)', () => {
    expect(checkArgs(['when'], undefined, 'search', SCHEMAS).state).toBe('missing');
  });
});

describe('argument values never reach the result or the snapshot', () => {
  const JWT = 'stub-jwt-for-mcp-args-test-0123456789';
  const SECRET = 'customer-password-value-abc123';
  const env = { name: 'Stub', baseUrl: 'https://ai.sb.amp.vg', isProduction: false };
  const graphs = {
    w1: { activities: [{ type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: literal(4), toolName: literal('search'), argumentsJson: literal(`{"when":"x","token":"${SECRET}"}`) } }] },
  };
  const transport = () => ({
    async post(func: 'getmcpservers' | 'getmcpservertools', body: unknown) {
      if (func === 'getmcpservers') return { status: 200, json: [{ id: 4, name: 'S' }] };
      return { status: 200, json: { tools: [{ name: 'search', inputSchema: { properties: { query: { type: 'string' }, when: { type: 'string' } }, required: ['query'] } }] } };
    },
    async get(path: string) {
      if (path === '/api/elsa-agents/workflow-definitions') return { ok: true, status: 200, json: [{ definitionId: 'w1', name: 'W' }] };
      return { ok: true, status: 200, json: graphs.w1 };
    },
    async postWorkflowList() {
      return { status: 200, json: { status: 0, result: { item: [{ definitionId: 'w1' }], row_count: 1 } } };
    },
  });
  it('keys are kept, values appear nowhere', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-args-'));
    const r = await runMcpHealth({ environment: env, accounts: [{ key: 'a', jwt: JWT }], outputDir: dir, transport });
    const row = r.accounts.a!.nodes[0]!;
    expect(row.argCheck).toEqual({ state: 'missing', missing: ['query'], extra: ['token'] });
    expect(row.bucket).toBe('HEALTHY');
    expect(JSON.stringify(r)).not.toContain(SECRET);
    const prev = loadPrevious(dir, 'ai.sb.amp.vg', 'a');
    expect(JSON.stringify(prev?.snapshot)).not.toContain(SECRET);
    expect(prev?.snapshot.nodes[0]?.argCheck).toEqual({ state: 'missing', missing: ['query'], extra: ['token'] });
  });
});
