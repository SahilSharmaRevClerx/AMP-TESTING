/**
 * P08 T4: runMcpHealth against an injected stub transport. No network.
 * Covers a healthy server, a dead host, a rejected key, a not-connected
 * server, an invisible server, a wrong-tool node, snapshots/diff/combine,
 * raw-answer files without secrets, and cancel.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMcpHealth, type McpTransport } from '../src/mcp/run';

const JWT = 'stub-jwt-for-mcp-run-test-0123456789';

const literal = (value: unknown) => ({ expression: { type: 'Literal', value } });

function stub(workflows: Record<string, unknown>, servers: Record<string, unknown[]>, tools: Record<number, unknown>): McpTransport {
  return {
    async post(func, body) {
      if (func === 'getmcpservers') {
        const scope = (body as { scope?: string }).scope ?? 'company';
        return { status: 200, json: servers[scope] ?? [] };
      }
      const id = (body as { mcpServerId?: number }).mcpServerId!;
      return { status: 200, json: tools[id] ?? { error: 'No such host for this tunnel' } };
    },
    async get(path) {
      if (path === '/api/elsa-agents/workflow-definitions') {
        return { ok: true, status: 200, json: Object.keys(workflows).map((definitionId, i) => ({ definitionId, name: `WF${i + 1}` })) };
      }
      const id = decodeURIComponent(path.split('/').pop()!);
      const g = workflows[id];
      return g ? { ok: true, status: 200, json: g } : { ok: false, status: 404, json: null };
    },
  };
}

const workflows = {
  w1: { activities: [{ type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: literal(4), toolName: literal('good_tool') } }] },
  w2: {
    activities: [
      { type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: literal(4), toolName: literal('missing_tool') } },
      { type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: literal(99), toolName: literal('t') } },
      { type: 'Elsa.HttpWebRequest', inputs: {} },
    ],
  },
};
const servers = {
  company: [
    { id: 4, name: 'Healthy MCP' },
    { id: 5, name: 'Key MCP' },
    { id: 6, name: 'Dead MCP' },
    { id: 8, name: 'OAuth MCP' },
  ],
  org: [],
  user: [],
};
const tools = {
  4: { tools: [{ name: 'good_tool' }] },
  5: { error: 'The server rejected the key in Headers' },
  6: { error: 'No such host is known' },
  8: { error: 'this server is not connected to your account' },
};

const env = { name: 'Stub', baseUrl: 'https://ai.sb.amp.vg', isProduction: false };

describe('runMcpHealth (stub transport, no network)', () => {
  it('classifies servers and nodes, writes raw answers without secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-run-'));
    const t = stub(workflows, servers, tools);
    const result = await runMcpHealth({ environment: env, accounts: [{ key: 'default', jwt: JWT }], outputDir: dir, transport: () => t });
    const acc = result.accounts.default!;
    expect(acc.servers.map((s) => [s.id, s.state, s.bucket])).toEqual([
      [4, 'OK', 'HEALTHY'],
      [5, 'KEY_REJECTED', 'BROKEN'],
      [6, 'DEAD_HOST', 'BROKEN'],
      [8, 'NOT_CONNECTED', 'NEEDS_YOU'],
      [99, 'NOT_VISIBLE', 'NEEDS_YOU'],
    ]);
    const states = acc.nodes.map((n) => n.state);
    expect(states).toContain('OK');
    expect(states.some((s) => s.startsWith('TOOL_MISSING: missing_tool'))).toBe(true);
    expect(states).toContain('SERVER_NOT_VISIBLE');
    expect(result.firstRun.default).toBe(true);
    expect(result.notCovered.webRequestNodes).toBe(1);
    expect(result.accounts.combined!.servers).toHaveLength(5);
    // Raw answers exist for non-working servers only, and contain no jwt.
    const rawDir = join(dir, '_mcp');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const files = walk(rawDir).filter((f) => f.endsWith('.json') && f.includes('raw'));
    expect(files.map((f) => f.split(/[/\\]/).pop()).sort()).toEqual(['default-5.json', 'default-6.json', 'default-8.json', 'default-99.json']);
    for (const f of walk(rawDir)) expect(readFileSync(f, 'utf8')).not.toContain(JWT);
    expect(acc.servers.find((s) => s.id === 4)!.rawUrl).toBeUndefined();
    expect(acc.servers.find((s) => s.id === 5)!.rawUrl).toMatch(/\/output\//);
  });

  it('second run diffs state flips and tool deltas for the same label only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-run2-'));
    const t1 = stub(workflows, servers, tools);
    await runMcpHealth({ environment: env, accounts: [{ key: 'default', jwt: JWT }], outputDir: dir, transport: () => t1 });
    const tools2 = { ...tools, 4: { tools: [{ name: 'good_tool' }, { name: 'new_tool' }] }, 5: { tools: [{ name: 't' }] } };
    const r2 = await runMcpHealth({ environment: env, accounts: [{ key: 'default', jwt: JWT }], outputDir: dir, transport: () => stub(workflows, servers, tools2) });
    expect(r2.firstRun.default).toBe(false);
    const byId = new Map(r2.changes.default!.map((c) => [c.id, c]));
    expect(byId.get(5)).toMatchObject({ from: 'BROKEN', to: 'HEALTHY' });
    expect(byId.get(4)).toMatchObject({ from: 'HEALTHY', to: 'HEALTHY', added: ['new_tool'], removed: [] });
    // Another label still gets a first run, never a diff against label one.
    const r3 = await runMcpHealth({ environment: env, accounts: [{ key: 'admin', jwt: `${JWT}-2` }], outputDir: dir, transport: () => t1 });
    expect(r3.firstRun.admin).toBe(true);
    expect(r3.changes.admin).toEqual([]);
  });

  it('unreachable workflows still run the connector checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-run3-'));
    const down: McpTransport = { post: stub(workflows, servers, tools).post, get: async () => ({ ok: false, status: 503, json: null }) };
    const r = await runMcpHealth({ environment: env, accounts: [{ key: 'default', jwt: JWT }], outputDir: dir, transport: () => down });
    expect(r.accounts.default!.nodes).toEqual([]);
    expect(r.accounts.default!.sub).toMatch(/unreachable/);
    expect(r.accounts.default!.servers.length).toBeGreaterThan(0);
  });

  it('cancel aborts the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-run4-'));
    const ctl = new AbortController();
    ctl.abort();
    await expect(runMcpHealth({ environment: env, accounts: [{ key: 'default', jwt: JWT }], outputDir: dir, signal: ctl.signal, transport: () => stub(workflows, servers, tools) })).rejects.toThrow('cancelled');
    expect(existsSync(dir)).toBe(true);
  });
});

describe('retry once for momentary answers', () => {
  const wf = { w1: { activities: [] } };
  const svs = { company: [{ id: 1, name: 'Flaky' }, { id: 2, name: 'Dead' }, { id: 3, name: 'Key' }, { id: 4, name: 'Stays down' }], org: [], user: [] };
  it('asks again once after unreachable/rate limited, and never for other failures', async () => {
    process.env.MCP_RETRY_DELAY_MS = '0';
    const calls: Record<number, number> = {};
    const t: McpTransport = {
      async post(func, body) {
        if (func === 'getmcpservers') return { status: 200, json: (body as { scope: string }).scope === 'company' ? svs.company : [] };
        const id = (body as { mcpServerId: number }).mcpServerId;
        calls[id] = (calls[id] ?? 0) + 1;
        if (id === 1) return { status: 200, json: calls[id] === 1 ? { error: 'Could not list tools from the MCP server: it is currently unavailable (503). Please try again later.' } : { tools: [{ name: 't' }] } };
        if (id === 2) return { status: 200, json: { error: 'No such host is known' } };
        if (id === 3) return { status: 200, json: { error: "Could not list tools from the MCP server: it rejected the key in this connector's Headers (401). Check the API key." } };
        return { status: 200, json: { error: 'Could not list tools from the MCP server: rate limit exceeded (429). Please wait a moment and try again.' } };
      },
      async get(path) { return path.endsWith('definitions') ? { ok: true, status: 200, json: [] } : { ok: false, status: 404, json: null }; },
    };
    try {
      const dir = mkdtempSync(join(tmpdir(), 'mcp-retry-'));
      const r = await runMcpHealth({ environment: env, accounts: [{ key: 'default', jwt: JWT }], outputDir: dir, transport: () => t });
      const st = new Map(r.accounts.default!.servers.map((s) => [s.id, s.state]));
      expect(st.get(1)).toBe('OK');
      expect(st.get(4)).toBe('RATE_LIMITED');
      expect([calls[1], calls[2], calls[3], calls[4]]).toEqual([2, 1, 1, 2]);
    } finally {
      delete process.env.MCP_RETRY_DELAY_MS;
    }
  });
});

describe('Run screen details (progress, tally, timestamped log, tool descriptions)', () => {
  const withDescriptions = {
    ...tools,
    4: { tools: [{ name: 'list_things', description: '  Lists   the things\nwith a long    description  ' }, { name: 'get_thing' }] },
  };

  it('every progress event carries start time, account, stage times and facts; the tally ends at the final counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-run-'));
    const events: import('../src/mcp/run').McpProgress[] = [];
    const result = await runMcpHealth({
      environment: env, accounts: [{ key: 'default', jwt: JWT }, { key: 'second', jwt: JWT }], outputDir: dir,
      transport: () => stub(workflows, servers, withDescriptions), onProgress: (p) => events.push(p),
    });
    expect(events.length).toBeGreaterThan(5);
    for (const e of events) {
      expect(typeof e.startedAt).toBe('number');
      expect(e.account?.count).toBe(2);
    }
    const lastOfFirst = [...events].reverse().find((e) => e.account?.key === 'default')!;
    expect(lastOfFirst.account).toEqual({ key: 'default', index: 1, count: 2 });
    expect(lastOfFirst.facts).toMatchObject({ workflows: 2, nodes: 3, servers: 4 });
    for (const stage of ['workflows', 'servers', 'tools', 'report'] as const) {
      expect(lastOfFirst.stageTimes?.[stage]?.startedAt).toBeTypeOf('number');
    }
    // the tally counts the same groups the results page shows
    const toolsDone = events.filter((e) => e.account?.key === 'default' && e.stage === 'tools' && e.done === e.total).pop()!;
    expect(toolsDone.tally).toEqual({ fix: 2, reconnect: 0, cantCheck: 2, working: 1, checked: 5 }); // 4 visible + node #99 that nobody can see
    // the second account starts its own stage list
    const secondFirst = events.find((e) => e.account?.key === 'second')!;
    expect(secondFirst.account?.index).toBe(2);
    expect(Object.keys(secondFirst.stageTimes ?? {})).toEqual(['workflows']);
    expect(result.accounts.default!.servers.filter((s) => s.bucket === 'BROKEN')).toHaveLength(2);
  });

  it('log lines start with an m:ss stamp and say what is happening in plain words', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-run-'));
    let lines: string[] = [];
    await runMcpHealth({ environment: env, accounts: [{ key: 'default', jwt: JWT }], outputDir: dir, transport: () => stub(workflows, servers, tools), onProgress: (p) => (lines = p.lines) });
    expect(lines.length).toBeGreaterThan(4);
    for (const l of lines) expect(l).toMatch(/^\d+:\d{2} {2}\[default\] /);
    const text = lines.join('\n');
    expect(text).toContain('Found 2 workflows');
    expect(text).toContain('Found 3 workflow steps that call a connector');
    expect(text).toContain('4 connectors are visible to this account');
    expect(text).toContain('Done: 1 of 5 connectors working');
    expect(text).not.toContain(JWT);
  });

  it('keeps AMP\'s tool descriptions (trimmed, one line) on the row, but not in the saved snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-run-'));
    const result = await runMcpHealth({ environment: env, accounts: [{ key: 'default', jwt: JWT }], outputDir: dir, transport: () => stub(workflows, servers, withDescriptions) });
    const row = result.accounts.default!.servers.find((s) => s.id === 4)!;
    expect(row.toolInfo).toEqual([{ name: 'get_thing' }, { name: 'list_things', description: 'Lists the things with a long description' }]);
    const snapDir = join(dir, '_mcp', 'history');
    const files = existsSync(snapDir) ? readdirSync(snapDir) : [];
    const all = files.map((f) => readFileSync(join(snapDir, f), 'utf8')).join('\n');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain('Lists the things');
  });
});
