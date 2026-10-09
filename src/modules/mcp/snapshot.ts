/**
 * MCP Connector Health (P08, Phase 0): run snapshots under output/.
 * One snapshot per host + account label. A label is one repo user type, so a
 * second user NEVER diffs against the first user's run: previous runs are
 * looked up by (host, label) only, and a first run says so instead of
 * diffing. Reports state changes and tools added/removed.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bucketRank } from './classify';
import { betterKind } from './kinds';
import type { McpAccountResult, McpNodeRow, McpServerRow, McpStateChange, McpToolChange } from './types';

export interface McpSnapshot {
  base: string;
  host: string;
  label: string;
  when: string;
  servers: McpServerRow[];
  nodes: McpNodeRow[];
  /** Classification rules version the states were produced with; absent in older files. */
  rulesVersion?: string;
  /** Whether workflows were read in this run (absent = yes, older files). It decides which connectors the run could know about. */
  workflowsChecked?: boolean;
}

export interface McpDiff {
  firstRun: boolean;
  /** Set when the two runs used different rules: state flips are not reported, only added/gone connectors and tool changes. */
  rulesChanged?: { from: string; to: string };
  previousWhen?: string;
  serverChanges: McpStateChange[];
  toolChanges: McpToolChange[];
  regressed: number;
  fixed: number;
}

const safe = (s: string): string => s.replace(/[^\w.-]/g, '_');

export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

export function snapshotDir(outputDir: string): string {
  return join(outputDir, '_mcp', 'history');
}

function prefixFor(host: string, label: string): string {
  return `${safe(host)}__${safe(label)}__`;
}

export function snapshotPath(outputDir: string, host: string, label: string, when: string): string {
  return join(snapshotDir(outputDir), `${prefixFor(host, label)}${when.replace(/[:.]/g, '-')}.json`);
}

/** Latest saved snapshot for this host + label, or null on a first run. */
export function loadPrevious(outputDir: string, host: string, label: string): { when: string; file: string; snapshot: McpSnapshot } | null {
  let files: string[] = [];
  try {
    files = readdirSync(snapshotDir(outputDir)).filter((f) => f.startsWith(prefixFor(host, label)) && f.endsWith('.json')).sort();
  } catch {
    return null;
  }
  const file = files.pop();
  if (!file) return null;
  try {
    const snapshot = JSON.parse(readFileSync(join(snapshotDir(outputDir), file), 'utf8')) as McpSnapshot;
    return { when: snapshot.when, file, snapshot };
  } catch {
    return null;
  }
}

export function saveSnapshot(outputDir: string, snap: McpSnapshot): string {
  mkdirSync(snapshotDir(outputDir), { recursive: true });
  const path = snapshotPath(outputDir, snap.host, snap.label, snap.when);
  writeFileSync(path, JSON.stringify(snap, null, 1));
  return path;
}

/** State flips + tools added/removed vs the previous run of the same host + label.
 * from/to are BUCKETS (like the results mockup's changes tab renders them);
 * regressed/fixed are counted on OK states (a flip out of / into OK). */
export function diffSnapshots(prev: McpSnapshot | null, cur: McpSnapshot): McpDiff {
  if (!prev) return { firstRun: true, serverChanges: [], toolChanges: [], regressed: 0, fixed: 0 };
  const from = prev.rulesVersion ?? '0';
  const to = cur.rulesVersion ?? '0';
  const rulesChanged = from !== to ? { from, to } : undefined;
  // A connector the account cannot list is only known because a workflow step names it. When one run read the
  // workflows and the other did not, such connectors appear or vanish because of the scope, not because they changed.
  const scopeChanged = (prev.workflowsChecked ?? true) !== (cur.workflowsChecked ?? true);
  const workflowOnly = (s: McpServerRow): boolean => scopeChanged && s.name === '(not visible)';
  const serverChanges: McpStateChange[] = [];
  const pm = new Map(prev.servers.map((s) => [s.id, s]));
  const cm = new Map(cur.servers.map((s) => [s.id, s]));
  for (const s of cur.servers) {
    const p = pm.get(s.id);
    if (workflowOnly(s) || (p && workflowOnly(p))) continue;
    if (!p) serverChanges.push({ what: 'server', id: s.id, name: s.name, from: '(new)', to: s.bucket, added: [], removed: [] });
    else if (!rulesChanged && (p.state !== s.state || p.bucket !== s.bucket)) {
      serverChanges.push({ what: 'server', id: s.id, name: s.name, from: p.bucket, to: s.bucket, added: [], removed: [] });
    }
  }
  for (const p of prev.servers) {
    if (workflowOnly(p)) continue;
    if (!cm.has(p.id)) serverChanges.push({ what: 'server', id: p.id, name: p.name, from: p.bucket, to: '(gone)', added: [], removed: [] });
  }
  const pt = new Map(prev.servers.map((s) => [s.id, new Set(s.toolNames ?? [])]));
  const toolChanges: McpToolChange[] = [];
  for (const s of cur.servers) {
    const old = pt.get(s.id);
    if (!old || old.size === 0 || s.toolNames.length === 0) continue;
    const added = s.toolNames.filter((t) => !old.has(t));
    const removed = [...old].filter((t) => !s.toolNames.includes(t));
    if (added.length || removed.length) toolChanges.push({ id: s.id, name: s.name, added, removed });
  }
  // One entry per changed connector (the P09 contract's Change): state flips
  // carry their tool deltas, and tool-only changes appear with from == to.
  const toolsOf = new Map(toolChanges.map((t) => [t.id, t]));
  const merged: McpStateChange[] = serverChanges.map((c) => ({
    ...c,
    added: toolsOf.get(c.id)?.added ?? [],
    removed: toolsOf.get(c.id)?.removed ?? [],
  }));
  for (const t of toolChanges) {
    if (!merged.some((c) => c.id === t.id)) {
      const s = cur.servers.find((x) => x.id === t.id)!;
      merged.push({ what: 'server', id: t.id, name: t.name, from: s.bucket, to: s.bucket, added: t.added, removed: t.removed });
    }
  }
  const regressed = merged.filter((c) => {
    const p = pm.get(c.id);
    const n = cm.get(c.id);
    return p && n && p.state === 'OK' && n.state !== 'OK';
  }).length;
  const fixed = merged.filter((c) => {
    const p = pm.get(c.id);
    const n = cm.get(c.id);
    return p && n && p.state !== 'OK' && n.state === 'OK';
  }).length;
  return { firstRun: false, previousWhen: prev.when, ...(rulesChanged ? { rulesChanged } : {}), serverChanges: merged, toolChanges, regressed, fixed };
}

/**
 * Best-verdict merge across account labels: per server id and per node key,
 * the entry with the best bucket wins. Order: HEALTHY, BROKEN, MAYBE, NEEDS_YOU.
 * Ties keep the entry with more tools (like the results mockup).
 */
export function combineAccounts(accounts: Record<string, McpAccountResult>, order: string[]): McpAccountResult {
  const bestServer = new Map<number, McpServerRow>();
  for (const key of order) {
    const acc = accounts[key];
    if (!acc) continue;
    for (const s of acc.servers) {
      const cur = bestServer.get(s.id);
      if (!cur || bucketRank(s.bucket) < bucketRank(cur.bucket) || (s.bucket === cur.bucket && s.tools > cur.tools)) bestServer.set(s.id, s);
    }
  }
  const nodeKey = (n: McpNodeRow): string => `${n.workflow}|${n.server}|${n.tool}`;
  const bestNode = new Map<string, McpNodeRow>();
  for (const key of order) {
    const acc = accounts[key];
    if (!acc) continue;
    for (const n of acc.nodes) {
      const k = nodeKey(n);
      const cur = bestNode.get(k);
      if (!cur) {
        bestNode.set(k, n);
        continue;
      }
      // Health first (best bucket wins, as for servers); the shown kind is the
      // most informative one seen for the step (Live, Template, Draft only,
      // Not in AMP's lists, Unknown), even when it came from another account.
      const kind = !cur.workflowKind ? n.workflowKind : !n.workflowKind ? cur.workflowKind : betterKind(cur.workflowKind, n.workflowKind);
      const winner = bucketRank(n.bucket) < bucketRank(cur.bucket) ? n : cur;
      bestNode.set(k, kind === winner.workflowKind ? winner : { ...winner, workflowKind: kind });
    }
  }
  return {
    title: 'Combined',
    sub: `best of ${order.filter((k) => accounts[k]).join(', ')}`,
    servers: [...bestServer.values()].sort((a, b) => a.id - b.id),
    nodes: [...bestNode.values()],
  };
}
