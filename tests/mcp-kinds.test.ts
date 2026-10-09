/**
 * P14 workflow-kind labels: the 5-way rule, the folder reader (paging,
 * all-or-nothing failure), the pinned body passing the gate, snapshot
 * round-trip keeping the kind, and Combined precedence. No network.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkWorkflowListBody } from '../src/core/safety/gate';
import { betterKind, KIND_LIST_PAGE_SIZE, kindOfWorkflow, readWorkflowLists, workflowListBody, type WorkflowListSets } from '../src/modules/mcp/kinds';
import { combineAccounts, loadPrevious, saveSnapshot } from '../src/modules/mcp/snapshot';
import type { McpNodeRow, McpServerRow } from '../src/modules/mcp/types';

const sets = (over: Partial<WorkflowListSets> = {}): WorkflowListSets => ({
  published: new Set(['live1']),
  draft: new Set(['draft1', 'live1']),
  public: new Set(['tmpl1']),
  ok: true,
  reads: 8,
  ...over,
});

describe('kindOfWorkflow (the 5-way rule)', () => {
  it.each([
    ['tmpl1', true, 'template'],
    ['live1', true, 'live'],
    ['draft1', true, 'draft'],
    ['unlisted1', true, 'unlisted'],
    ['ghost', false, 'unknown'],
  ])('%s in our list=%s reads %s', (id, ours, want) => {
    expect(kindOfWorkflow(id, sets(), ours)).toBe(want);
  });
  it('template wins over live, live over draft (a workflow with both versions)', () => {
    expect(kindOfWorkflow('live1', sets(), true)).toBe('live');
    expect(kindOfWorkflow('tmpl1', sets({ published: new Set(['tmpl1']) }), true)).toBe('template');
  });
  it('every step reads unknown when the lists failed', () => {
    const bad = sets({ ok: false });
    for (const [id, ours] of [['tmpl1', true], ['live1', true], ['draft1', true], ['unlisted1', true]] as const) {
      expect(kindOfWorkflow(id, bad, ours)).toBe('unknown');
    }
  });
});

describe('betterKind (Combined precedence)', () => {
  it('orders Live, Template, Draft only, Not in lists, Unknown', () => {
    expect(betterKind('draft', 'live')).toBe('live');
    expect(betterKind('unknown', 'unlisted')).toBe('unlisted');
    expect(betterKind('template', 'draft')).toBe('template');
    expect(betterKind('live', 'live')).toBe('live');
  });
});

describe('workflowListBody (pinned shape passes the gate)', () => {
  it('every folder body passes checkWorkflowListBody', async () => {
    const { KIND_LIST_REQUESTS } = await import('../src/modules/mcp/kinds');
    expect(KIND_LIST_REQUESTS).toHaveLength(8);
    for (const r of KIND_LIST_REQUESTS) {
      expect(checkWorkflowListBody(workflowListBody(r.flags, 0))).toBeNull();
      expect(checkWorkflowListBody(workflowListBody(r.flags, 3))).toBeNull();
    }
    expect(KIND_LIST_PAGE_SIZE).toBe(1000);
  });
});

/** Folder fixtures keyed by the four flags, like the fake AMP in tests/e2e. */
function folderStub(folders: Record<string, { definitionId: string }[]>, fail = false) {
  const calls: unknown[] = [];
  return {
    calls,
    async postWorkflowList(body: unknown) {
      calls.push(body);
      if (fail) return { status: 500, json: null };
      const b = body as { isPublished: boolean; isPublic: boolean; hasCategory: boolean; isAgentic: boolean; page: number; pageSize: number };
      const key = [b.isPublished, b.isPublic, b.hasCategory, b.isAgentic].join('|');
      const all = folders[key] ?? [];
      const rows = all.map((w) => ({ definitionId: w.definitionId, name: w.definitionId, description: '', isPublished: b.isPublished, isPublic: b.isPublic, version: 1 }));
      const slice = rows.slice(b.page * b.pageSize, b.page * b.pageSize + b.pageSize);
      return { status: 200, json: { status: 0, result: { item: slice, row_count: rows.length } } };
    },
  };
}

describe('readWorkflowLists', () => {
  const FOLDERS = {
    'true|false|false|false': [{ definitionId: 'live1' }],
    'true|false|true|false': [{ definitionId: 'live2' }],
    'true|false|false|true': [{ definitionId: 'liveAg' }],
    'false|false|false|false': [{ definitionId: 'draft1' }],
    'false|false|true|false': [],
    'false|false|false|true': [],
    'false|true|false|false': [{ definitionId: 'tmpl1' }],
    'false|true|true|false': [{ definitionId: 'tmpl2' }],
  };
  it('splits the 8 folders into published, draft and public sets', async () => {
    const s = await readWorkflowLists(folderStub(FOLDERS));
    expect(s.ok).toBe(true);
    expect(s.reads).toBe(8);
    expect([...s.published].sort()).toEqual(['live1', 'live2', 'liveAg']);
    expect([...s.draft]).toEqual(['draft1']);
    expect([...s.public].sort()).toEqual(['tmpl1', 'tmpl2']);
  });
  it('loops on row_count when a folder spans pages', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ definitionId: `p${i}` }));
    const t = folderStub({ 'true|false|false|false': many });
    const s = await readWorkflowLists(t);
    expect(s.ok).toBe(true);
    expect(s.published.size).toBe(1001);
    // One folder needed 2 pages; the other 7 needed 1 each.
    expect(t.calls.length).toBe(9);
    expect(s.reads).toBe(9);
  });
  it('is all-or-nothing: one failed folder labels every step unknown', async () => {
    const s = await readWorkflowLists(folderStub(FOLDERS, true));
    expect(s.ok).toBe(false);
    expect(kindOfWorkflow('live1', s, true)).toBe('unknown');
  });
  it('an unreadable answer fails the whole read', async () => {
    const s = await readWorkflowLists({ postWorkflowList: async () => ({ status: 200, json: { status: 0, result: { nope: 1 } } }) });
    expect(s.ok).toBe(false);
  });
});

const row = (id: number, state: string, bucket: 'HEALTHY' | 'BROKEN', tools: string[] = []): McpServerRow => ({
  id, name: `S${id}`, state: state as McpServerRow['state'], bucket, tools: tools.length, toolNames: tools, detail: '', hint: '',
});
const node = (workflow: string, kind?: McpNodeRow['workflowKind']): McpNodeRow => ({
  workflow, tool: 't', server: 4, state: 'OK', bucket: 'HEALTHY', hint: '', ...(kind ? { workflowKind: kind } : {}),
});

describe('snapshots keep the kind', () => {
  it('save/load round-trips workflowKind on nodes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-kind-snap-'));
    const snap = { base: 'https://x', host: 'x', label: 'a', when: new Date().toISOString(), servers: [row(4, 'OK', 'HEALTHY', ['t'])], nodes: [node('W', 'template')], rulesVersion: 'v' };
    saveSnapshot(dir, snap);
    const prev = loadPrevious(dir, 'x', 'a');
    expect(prev?.snapshot.nodes[0]?.workflowKind).toBe('template');
  });
  it('combineAccounts shows the most informative kind for the same step', () => {
    const acc = (kind?: McpNodeRow['workflowKind']) => ({ title: kind ?? 'x', sub: '', servers: [], nodes: [node('W', kind)] });
    const out = combineAccounts({ a: acc('draft'), b: acc('live'), c: acc('template') }, ['a', 'b', 'c']);
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0]?.workflowKind).toBe('live');
    const out2 = combineAccounts({ a: acc('unknown'), b: acc('unlisted') }, ['a', 'b']);
    expect(out2.nodes[0]?.workflowKind).toBe('unlisted');
    // Health still wins the row; the kind merges across accounts.
    const bad = { title: 'bad', sub: '', servers: [], nodes: [{ ...node('W', 'live'), state: 'TOOL_MISSING: t', bucket: 'BROKEN' as const }] };
    const out3 = combineAccounts({ good: acc('template'), bad }, ['good', 'bad']);
    expect(out3.nodes[0]?.bucket).toBe('HEALTHY');
    expect(out3.nodes[0]?.workflowKind).toBe('live');
  });
});

describe('runMcpHealth attaches kinds (stub transport, no network)', () => {
  const JWT = 'stub-jwt-for-mcp-kind-test-0123456789';
  const env = { name: 'Stub', baseUrl: 'https://ai.sb.amp.vg', isProduction: false };
  const literal = (value: unknown) => ({ expression: { type: 'Literal', value } });
  const graph = (id: number, tool: string) => ({
    activities: [{ type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: literal(id), toolName: literal(tool) } }],
  });
  // Our endpoint lists 3 workflows; the public template tmpl1 is missing from it.
  const graphs: Record<string, unknown> = {
    live1: graph(4, 'good_tool'),
    draft1: graph(4, 'gone_tool'),
    unlisted1: graph(4, 'good_tool'),
  };
  const servers = { company: [{ id: 4, name: 'Healthy MCP' }], org: [], user: [] };
  const tools = { 4: { tools: [{ name: 'good_tool' }] } };
  const folders = {
    'true|false|false|false': [{ definitionId: 'live1' }],
    'true|false|true|false': [],
    'true|false|false|true': [],
    'false|false|false|false': [{ definitionId: 'draft1' }],
    'false|false|true|false': [],
    'false|false|false|true': [],
    'false|true|false|false': [{ definitionId: 'tmpl1' }],
    'false|true|true|false': [],
  };
  const latest: Record<string, unknown> = {
    tmpl1: { name: 'Template One', ...graph(4, 'template_gone') },
  };

  function fullStub() {
    const inner = folderStub(folders);
    const listCalls: unknown[] = [];
    const latestCalls: string[] = [];
    return {
      listCalls,
      latestCalls,
      transport: {
        async post(func: 'getmcpservers' | 'getmcpservertools', body: unknown) {
          if (func === 'getmcpservers') {
            const scope = (body as { scope?: string }).scope ?? 'company';
            return { status: 200, json: (servers as Record<string, unknown[]>)[scope] ?? [] };
          }
          const id = (body as { mcpServerId?: number }).mcpServerId!;
          return { status: 200, json: (tools as Record<number, unknown>)[id] ?? { error: 'x' } };
        },
        async get(path: string) {
          if (path === '/api/elsa-agents/workflow-definitions') {
            return { ok: true, status: 200, json: Object.keys(graphs).map((definitionId) => ({ definitionId, name: definitionId })) };
          }
          const id = decodeURIComponent(path.split('/').pop()!);
          const g = graphs[id];
          return g ? { ok: true, status: 200, json: g } : { ok: false, status: 404, json: null };
        },
        async postWorkflowList(body: unknown) {
          listCalls.push(body);
          return inner.postWorkflowList(body);
        },
        async getLatest(path: string) {
          latestCalls.push(path);
          const m = /by-definition-id\/([^?]+)\?versionOptions=Latest/.exec(path);
          const g = m ? latest[decodeURIComponent(m[1]!)] : undefined;
          return g ? { ok: true, status: 200, json: g } : { ok: false, status: 404, json: null };
        },
      },
    };
  }

  it('labels live, draft, template (via designer Latest) and unlisted steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-kind-run-'));
    const s = fullStub();
    const { runMcpHealth } = await import('../src/modules/mcp/run');
    const r = await runMcpHealth({ environment: env, accounts: [{ key: 'a', jwt: JWT }], outputDir: dir, transport: () => s.transport });
    expect(s.listCalls).toHaveLength(8);
    expect(s.latestCalls).toHaveLength(1);
    expect(s.latestCalls[0]).toContain('tmpl1');
    const byWf = new Map(r.accounts.a!.nodes.map((n) => [n.workflow, n]));
    expect(byWf.get('live1')?.workflowKind).toBe('live');
    expect(byWf.get('draft1')?.workflowKind).toBe('draft');
    expect(byWf.get('draft1')?.state).toBe('TOOL_MISSING: gone_tool');
    expect(byWf.get('Template One')?.workflowKind).toBe('template');
    expect(byWf.get('Template One')?.state).toBe('TOOL_MISSING: template_gone');
    expect(byWf.get('unlisted1')?.workflowKind).toBe('unlisted');
    // Snapshot kept the kinds.
    const prev = loadPrevious(dir, 'ai.sb.amp.vg', 'a');
    expect(prev?.snapshot.nodes.find((n) => n.workflow === 'draft1')?.workflowKind).toBe('draft');
  });

  it('every step reads unknown when the lists fail, and the run says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-kind-fail-'));
    const s = fullStub();
    s.transport.postWorkflowList = async (body: unknown) => {
      s.listCalls.push(body);
      return { status: 500, json: null };
    };
    const lines: string[] = [];
    const { runMcpHealth } = await import('../src/modules/mcp/run');
    const r = await runMcpHealth({
      environment: env, accounts: [{ key: 'a', jwt: JWT }], outputDir: dir, transport: () => s.transport,
      onProgress: (p) => { lines.splice(0, lines.length, ...p.lines); },
    });
    expect(r.accounts.a!.nodes.length).toBeGreaterThan(0);
    for (const n of r.accounts.a!.nodes) expect(n.workflowKind).toBe('unknown');
    expect(s.latestCalls).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/lists could not be read/);
  });

  it('connector-only runs send no list or designer request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-kind-off-'));
    const s = fullStub();
    const { runMcpHealth } = await import('../src/modules/mcp/run');
    const r = await runMcpHealth({ environment: env, accounts: [{ key: 'a', jwt: JWT }], outputDir: dir, transport: () => s.transport, checkWorkflows: false });
    expect(s.listCalls).toHaveLength(0);
    expect(s.latestCalls).toHaveLength(0);
    expect(r.accounts.a!.nodes).toEqual([]);
  });
});
