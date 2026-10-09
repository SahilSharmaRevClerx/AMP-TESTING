import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { combineAccounts, diffSnapshots, loadPrevious, saveSnapshot, type McpSnapshot } from '../src/modules/mcp/snapshot';
import type { McpServerRow } from '../src/modules/mcp/types';

const row = (id: number, state: McpServerRow['state'], bucket: McpServerRow['bucket'], toolNames: string[] = []): McpServerRow => ({
  id, name: `s${id}`, state, bucket, tools: toolNames.length, toolNames, detail: '', hint: '',
});
const snap = (label: string, servers: McpServerRow[], when = '2026-10-06T06:00:00.000Z'): McpSnapshot => ({
  base: 'https://ai.sb.amp.vg', host: 'ai.sb.amp.vg', label, when, servers, nodes: [],
});

describe('snapshots (keyed by host + label)', () => {
  it('first run says so instead of diffing', () => {
    const d = diffSnapshots(null, snap('default', [row(4, 'OK', 'HEALTHY', ['a'])]));
    expect(d).toMatchObject({ firstRun: true, regressed: 0, fixed: 0, serverChanges: [], toolChanges: [] });
  });
  it('a second user never diffs against the first user', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-snap-'));
    saveSnapshot(dir, snap('default', [row(4, 'OK', 'HEALTHY')]));
    expect(loadPrevious(dir, 'ai.sb.amp.vg', 'admin')).toBeNull();
    expect(loadPrevious(dir, 'ai.sb.amp.vg', 'default')!.snapshot.label).toBe('default');
  });
  it('reports state flips with regressed/fixed counts and tool added/removed', () => {
    const prev = snap('default', [row(4, 'OK', 'HEALTHY', ['a', 'b']), row(5, 'OAUTH_EXPIRED', 'MAYBE')]);
    const cur = snap('default', [row(4, 'DEAD_HOST', 'BROKEN', ['a', 'c']), row(5, 'OK', 'HEALTHY', ['x'])]);
    const d = diffSnapshots(prev, cur);
    expect(d.firstRun).toBe(false);
    expect(d.serverChanges).toHaveLength(2);
    expect(d.regressed).toBe(1);
    expect(d.fixed).toBe(1);
    expect(d.toolChanges).toEqual([{ id: 4, name: 's4', added: ['c'], removed: ['b'] }]);
  });
});

describe('rules version (a rule change is never shown as a connector change)', () => {
  it('different versions: no state flips, but new/gone connectors and tool changes are still reported', () => {
    const prev = { ...snap('default', [row(4, 'OK', 'HEALTHY', ['a', 'b']), row(5, 'FORBIDDEN', 'MAYBE'), row(6, 'OK', 'HEALTHY', ['z'])]), rulesVersion: 'v1' };
    const cur = { ...snap('default', [row(4, 'OK', 'HEALTHY', ['a', 'c']), row(5, 'FORBIDDEN', 'BROKEN'), row(7, 'OK', 'HEALTHY', ['n'])]), rulesVersion: 'v2' };
    const d = diffSnapshots(prev, cur);
    expect(d.rulesChanged).toEqual({ from: 'v1', to: 'v2' });
    expect(d.serverChanges.find((c) => c.id === 5)).toBeUndefined();
    expect(d.serverChanges.find((c) => c.id === 4)).toMatchObject({ added: ['c'], removed: ['b'] });
    expect(d.serverChanges.find((c) => c.id === 6)).toMatchObject({ to: '(gone)' });
    expect(d.serverChanges.find((c) => c.id === 7)).toMatchObject({ from: '(new)' });
  });
  it('same version still reports flips; a file without a version counts as an older version', () => {
    const a = { ...snap('default', [row(5, 'OK', 'HEALTHY')]), rulesVersion: 'v1' };
    const b = { ...snap('default', [row(5, 'DEAD_HOST', 'BROKEN')]), rulesVersion: 'v1' };
    expect(diffSnapshots(a, b).rulesChanged).toBeUndefined();
    expect(diffSnapshots(a, b).serverChanges).toHaveLength(1);
    const old = snap('default', [row(5, 'OK', 'HEALTHY')]);
    expect(diffSnapshots(old, b).rulesChanged).toEqual({ from: '0', to: 'v1' });
  });
});

describe('scope switch (connectors only vs with workflows)', () => {
  const hidden = (id: number): McpServerRow => ({ ...row(id, 'NOT_VISIBLE', 'NEEDS_YOU'), name: '(not visible)' });
  it('a connector known only from workflows is not a change when the scope differs between runs', () => {
    const prev = { ...snap('default', [row(4, 'OK', 'HEALTHY', ['a'])]), workflowsChecked: false };
    const cur = { ...snap('default', [row(4, 'OK', 'HEALTHY', ['a']), hidden(99)]), workflowsChecked: true };
    expect(diffSnapshots(prev, cur).serverChanges).toEqual([]);
    expect(diffSnapshots(cur, prev).serverChanges).toEqual([]);
  });
  it('same scope: a workflow-only connector appearing is still a change; visible connectors always count', () => {
    const a = { ...snap('default', [row(4, 'OK', 'HEALTHY', ['a'])]), workflowsChecked: true };
    const b = { ...snap('default', [row(4, 'DEAD_HOST', 'BROKEN', ['a']), hidden(99)]), workflowsChecked: true };
    expect(diffSnapshots(a, b).serverChanges.map((c) => c.id).sort()).toEqual([4, 99]);
    const c = { ...snap('default', [row(4, 'DEAD_HOST', 'BROKEN', ['a'])]), workflowsChecked: false };
    expect(diffSnapshots(a, c).serverChanges.map((x) => x.id)).toEqual([4]);
  });
});

describe('combineAccounts (best verdict wins)', () => {
  it('order HEALTHY, BROKEN, MAYBE, NEEDS_YOU', () => {
    const accounts = {
      a: { title: 'a', sub: '', servers: [row(1, 'NOT_CONNECTED', 'NEEDS_YOU')], nodes: [] },
      b: { title: 'b', sub: '', servers: [row(1, 'OAUTH_EXPIRED', 'MAYBE')], nodes: [] },
      c: { title: 'c', sub: '', servers: [row(1, 'DEAD_HOST', 'BROKEN')], nodes: [] },
      d: { title: 'd', sub: '', servers: [row(1, 'OK', 'HEALTHY', ['t'])], nodes: [] },
    };
    expect(combineAccounts(accounts, ['a', 'b', 'c', 'd']).servers[0]!.state).toBe('OK');
    expect(combineAccounts(accounts, ['a', 'b', 'c']).servers[0]!.state).toBe('DEAD_HOST');
    expect(combineAccounts(accounts, ['a', 'b']).servers[0]!.state).toBe('OAUTH_EXPIRED');
  });
});
