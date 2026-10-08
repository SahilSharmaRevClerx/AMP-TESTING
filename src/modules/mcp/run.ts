/**
 * MCP Connector Health (P08, Phase 0): read-only orchestration.
 * Per account label: workflows -> servers per scope (company|org|user) ->
 * live tool list per server (concurrency 2), all through RequestGate.
 * No tool calls, no LLM. Progress events for the page; cancel via AbortSignal
 * like the Pages engine. jwts are registered with core/util/mask.ts on entry and
 * forgotten afterwards. Per non-working server a raw-answer file (status,
 * scrubbed error text, timestamp, label) is written under output/.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliOptions } from '../../core/cli-options';
import { loadSiteConfig } from '../../core/config-file';
import { makeCredentials } from '../../core/credentials';
import { RequestGate } from '../../core/safety/gate';
import type { Credentials, Environment } from '../../core/types';
import { AuditLog } from '../../core/util/audit';
import { runLimited } from '../../core/util/limit';
import { cleanJwt, forgetSecrets, scrub } from '../../core/util/mask';
import { createLogger } from '../../core/util/logger';
import { unwrapResponse, toolInfoOf } from './classify';
import { classifyNode, classifyServerResponse, RULES_VERSION, toolSchemasOf } from './classify';
import { extractMcpNodes, type McpNode } from './nodes';
import { combineAccounts, diffSnapshots, hostOf, loadPrevious, saveSnapshot } from './snapshot';
import type { McpAccountResult, McpNodeRow, McpResult, McpServerRow } from './types';

const log = createLogger('mcp');

/**
 * Which HTTP route form the MCP reads use. The T1 live proof
 * (notes/repro-muse/mcp-route-proof.ts) is still pending from the user, so
 * this stays on 'api.ashx' — the form the gate allowlist already permits
 * (P08 T2). Switching to 'api-path' needs the proof AND a narrow gate rule;
 * do not change this constant without both.
 */
export const MCP_ROUTE_FORM: 'api.ashx' | 'api-path' = 'api.ashx';

const API_PATH_NAMES = { getmcpservers: 'GetMCPServers', getmcpservertools: 'GetMCPServerTools' } as const;

export type McpStage = 'workflows' | 'servers' | 'tools' | 'report' | 'ai';

export interface McpStageTime {
  startedAt: number;
  endedAt?: number;
}

/** Running count of connectors sorted so far (same four groups as the results page). */
export interface McpTally {
  fix: number;
  reconnect: number;
  cantCheck: number;
  working: number;
  checked: number;
}

export interface McpProgress {
  stage: McpStage;
  stageLabel: string;
  current: string;
  done: number;
  total: number;
  lines: string[];
  /** Additive detail for the Run screen: ms since epoch the run started. */
  startedAt?: number;
  /** Which account this progress belongs to (1-based index). */
  account?: { key: string; index: number; count: number };
  /** When each stage of the current account started and ended (ms since epoch). */
  stageTimes?: Partial<Record<McpStage, McpStageTime>>;
  /** Counts found so far, for the stage list ("225 workflows · 88 steps · 317 connectors"). */
  facts?: { workflows?: number; nodes?: number; servers?: number; aiItems?: number };
  tally?: McpTally;
}

export interface McpAccountInput {
  /** Repo user-type key (packet: labels = user types), e.g. "admin". */
  key: string;
  jwt: string;
  /** Shown on the account tab, e.g. "Admin". */
  title?: string;
}

export interface McpRunInput {
  environment: Environment;
  accounts: McpAccountInput[];
  outputDir: string;
  delayMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: McpProgress) => void;
  /** Server-assigned id so run files land where the routes expect. */
  runId?: string;
  /** Test-only: stub AMP answers per account key. Production always uses RequestGate. */
  transport?: (accountKey: string) => McpTransport;
}

export class McpCancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'McpCancelledError';
  }
}

interface VisibleServer {
  id: number;
  name: string;
}

function checkCancel(signal?: AbortSignal): void {
  if (signal?.aborted) throw new McpCancelledError();
}

/** Wait before the one retry of a momentary failure (env override is for tests). */
function retryDelayMs(): number {
  const v = process.env.MCP_RETRY_DELAY_MS;
  return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : 5000;
}

async function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    checkCancel(signal);
    await new Promise((r) => setTimeout(r, Math.min(200, Math.max(0, end - Date.now()))));
  }
  checkCancel(signal);
}

function asList(j: unknown): unknown[] {
  const u = unwrapResponse(j);
  if (Array.isArray(u)) return u;
  if (u && typeof u === 'object' && Array.isArray((u as { items?: unknown }).items)) return (u as { items: unknown[] }).items;
  return [];
}

async function postApi(t: McpTransport, func: 'getmcpservers' | 'getmcpservertools', body: unknown): Promise<{ status: number; json: unknown }> {
  return t.post(func, body);
}

async function getJson(t: McpTransport, path: string): Promise<{ ok: boolean; status: number; json: unknown }> {
  return t.get(path);
}

/** AMP-call layer. Production uses RequestGate; tests inject a stub so no test touches a real network. */
export interface McpTransport {
  post(func: 'getmcpservers' | 'getmcpservertools', body: unknown): Promise<{ status: number; json: unknown }>;
  get(path: string): Promise<{ ok: boolean; status: number; json: unknown }>;
}

function gateTransport(gate: RequestGate, userType: string, creds: Credentials): McpTransport {
  const pathFor = (func: 'getmcpservers' | 'getmcpservertools'): string =>
    MCP_ROUTE_FORM === 'api-path' ? `/api/${API_PATH_NAMES[func]}` : `/services/api.ashx?func=${func}`;
  return {
    async post(func, body) {
      const res = await gate.fetch(userType, 'POST', gate.resolve(pathFor(func)), creds, body);
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
    async get(path) {
      const res = await gate.fetch(userType, 'GET', gate.resolve(path), creds);
      if (!res.ok) return { ok: false, status: res.status, json: null };
      try {
        return { ok: true, status: res.status, json: await res.json() };
      } catch {
        return { ok: false, status: res.status, json: null };
      }
    },
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';
}

function runIdOf(envName: string): string {
  return `mcp-${slug(envName)}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}

/**
 * Runs the read-only health check for every account and returns the P09
 * API contract's Result. Tested with an injectable gate factory so no test
 * touches a real network (see tests/e2e fake AMP / unit fakes).
 */
export async function runMcpHealth(input: McpRunInput): Promise<McpResult> {
  const delayMs = input.delayMs ?? 300;
  const host = hostOf(input.environment.baseUrl);
  const runId = input.runId ?? runIdOf(input.environment.name);
  const rawDir = join(input.outputDir, '_mcp', runId, 'raw');
  const audit = new AuditLog(join(input.outputDir, '_mcp', runId, 'audit.jsonl'));
  const gate = new RequestGate(input.environment, delayMs, audit);
  const lines: string[] = [];
  const startedAt = Date.now();
  let acct = { key: '', index: 0, count: input.accounts.length };
  let stageTimes: Partial<Record<McpStage, McpStageTime>> = {};
  let facts: NonNullable<McpProgress['facts']> = {};
  let tally: McpTally = { fix: 0, reconnect: 0, cantCheck: 0, working: 0, checked: 0 };
  let lastStage: McpStage | null = null;
  const emit = (stage: McpStage, stageLabel: string, current: string, done: number, total: number, finished = false): void => {
    const now = Date.now();
    if (stage !== lastStage) {
      const prev = lastStage ? stageTimes[lastStage] : undefined;
      if (prev && !prev.endedAt) prev.endedAt = now;
      stageTimes[stage] = { startedAt: now };
      lastStage = stage;
    }
    if (finished && stageTimes[stage]) stageTimes[stage]!.endedAt = now;
    input.onProgress?.({
      stage, stageLabel, current, done, total, lines: [...lines],
      startedAt, account: { ...acct },
      stageTimes: Object.fromEntries(Object.entries(stageTimes).map(([k, v]) => [k, { ...v }])) as Partial<Record<McpStage, McpStageTime>>,
      facts: { ...facts }, tally: { ...tally },
    });
  };
  const stamp = (): string => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const say = (line: string): void => {
    lines.push(`${stamp()}  ${scrub(line)}`);
    log.info(scrub(line));
  };

  const creds = new Map<string, Credentials>();
  try {
    for (const a of input.accounts) creds.set(a.key, makeCredentials(a.jwt));

    const accounts: Record<string, McpAccountResult> = {};
    const changes: Record<string, McpResult['changes'][string]> = {};
    const firstRun: Record<string, boolean> = {};
    const rulesChanged: Record<string, { from: string; to: string }> = {};
    let webRequestNodes = 0;

    for (const a of input.accounts) {
      checkCancel(input.signal);
      const c = creds.get(a.key)!;
      const t = input.transport ? input.transport(a.key) : gateTransport(gate, a.key, c);
      const title = a.title?.trim() || a.key;
      acct = { key: a.key, index: acct.index + 1, count: input.accounts.length };
      stageTimes = {};
      facts = {};
      tally = { fix: 0, reconnect: 0, cantCheck: 0, working: 0, checked: 0 };
      lastStage = null;

      // ---- 1. workflows -> MCP nodes -------------------------------------
      emit('workflows', 'Reading workflows', title, 0, 1);
      say(`[${a.key}] Reading the workflow list…`);
      let defs: { definitionId: string; name: string }[] = [];
      let workflowsReachable = true;
      try {
        const r = await getJson(t, '/api/elsa-agents/workflow-definitions');
        if (!r.ok || !Array.isArray(r.json)) workflowsReachable = false;
        else defs = (r.json as { definitionId?: unknown; name?: unknown }[]).filter(
          (d): d is { definitionId: string; name: string } => typeof d?.definitionId === 'string' && typeof d?.name === 'string',
        );
      } catch (e) {
        workflowsReachable = false;
        say(`[${a.key}] workflow list failed: ${scrub((e as Error).message).slice(0, 120)}`);
      }
      const extracted: McpNode[] = [];
      if (workflowsReachable) {
        say(`[${a.key}] Found ${defs.length} workflows; reading each one for connector steps…`);
        facts.workflows = defs.length;
        let done = 0;
        const perWorkflow = await runLimited(defs, 4, async (d) => {
          checkCancel(input.signal);
          try {
            const r = await getJson(t, `/api/elsa-agents/workflow-definitions/${encodeURIComponent(d.definitionId)}`);
            if (r.ok) {
              const ex = extractMcpNodes(r.json, typeof d.name === 'string' ? d.name : d.definitionId);
              webRequestNodes += ex.webRequestNodes;
              return ex.nodes;
            }
          } catch {
            /* skip one bad definition, like the script */
          }
          return [] as McpNode[];
        });
        for (const list of perWorkflow) {
          extracted.push(...list);
          done += 1;
          emit('workflows', 'Reading workflows', `${done}/${defs.length}`, done, defs.length);
        }
        say(`[${a.key}] Found ${extracted.length} workflow steps that call a connector`);
        facts.nodes = extracted.length;
      } else {
        say(`[${a.key}] WARNING: the workflow list could not be read. Connector checks still run, but workflow steps will not be checked.`);
      }

      // ---- 2. visible servers per scope ----------------------------------
      emit('servers', 'Listing connectors', title, 0, 1);
      const visible = new Map<number, VisibleServer>();
      for (const scope of ['company', 'org', 'user']) {
        checkCancel(input.signal);
        try {
          const r = await postApi(t, 'getmcpservers', { scope });
          if (r.status !== 200) {
            say(`[${a.key}] scope=${scope}: HTTP ${r.status}`);
            continue;
          }
          for (const s of asList(r.json)) {
            const rec = s as { id?: unknown; name?: unknown };
            if (rec && rec.id !== undefined && rec.id !== null && rec.id !== '') {
              const id = Number(rec.id);
              if (Number.isFinite(id)) visible.set(id, { id, name: typeof rec.name === 'string' ? rec.name : `server ${id}` });
            }
          }
        } catch (e) {
          say(`[${a.key}] scope=${scope} failed: ${scrub((e as Error).message).slice(0, 120)}`);
        }
      }
      say(`[${a.key}] ${visible.size} connectors are visible to this account`);
      facts.servers = visible.size;

      // ---- 3. live tool list per server (concurrency 2) -------------------
      const wanted = new Set<number>([...visible.keys()]);
      for (const n of extracted) if (typeof n.serverId === 'number' && Number.isFinite(n.serverId)) wanted.add(n.serverId);
      const ids = [...wanted].sort((x, y) => x - y);
      say(`[${a.key}] Asking AMP to connect to ${ids.length} connectors and list their tools (the slowest part)…`);
      emit('tools', 'Asking AMP to connect', `${title}: 0/${ids.length}`, 0, ids.length);
      const byId = new Map<number, { status: number; json: unknown }>();
      let toolDone = 0;
      let retried = 0;
      await runLimited(ids, 2, async (id) => {
        checkCancel(input.signal);
        try {
          let got = await postApi(t, 'getmcpservertools', { mcpServerId: id });
          // One retry for answers that are often momentary (getmcpservertools reaches the connector every time, no cache).
          const first = classifyServerResponse(got.status, got.json, visible.has(id)).state;
          if (first === 'UNREACHABLE' || first === 'RATE_LIMITED') {
            await sleepCancellable(retryDelayMs(), input.signal);
            got = await postApi(t, 'getmcpservertools', { mcpServerId: id });
            retried += 1;
          }
          byId.set(id, got);
        } catch (e) {
          if (e instanceof McpCancelledError) throw e;
          byId.set(id, { status: 0, json: { error: `Request to AMP failed: ${scrub((e as Error).message).slice(0, 120)}` } });
        }
        toolDone += 1;
        const got = byId.get(id)!;
        const bucket = classifyServerResponse(got.status, got.json, visible.has(id)).bucket;
        tally.checked += 1;
        if (bucket === 'BROKEN') tally.fix += 1;
        else if (bucket === 'MAYBE') tally.reconnect += 1;
        else if (bucket === 'NEEDS_YOU') tally.cantCheck += 1;
        else tally.working += 1;
        if (toolDone % 25 === 0 && toolDone < ids.length) say(`[${a.key}] ${toolDone} of ${ids.length} asked · ${tally.working} working, ${tally.fix} need a fix, ${tally.reconnect} to reconnect, ${tally.cantCheck} can't be checked`);
        emit('tools', 'Asking AMP to connect', `${title}: ${toolDone}/${ids.length}`, toolDone, ids.length);
      });

      if (retried) say(`[${a.key}] ${retried} connector${retried === 1 ? '' : 's'} answered "unreachable" or "rate limited" and ${retried === 1 ? 'was' : 'were'} asked once more.`);

      // ---- 4. classify ------------------------------------------------------
      say(`[${a.key}] All ${ids.length} connectors answered. Sorting the results…`);
      emit('report', 'Writing results', title, 0, 1);
      mkdirSync(rawDir, { recursive: true });
      const when = new Date().toISOString();
      const servers: McpServerRow[] = ids.map((id) => {
        const r = byId.get(id)!;
        const v = classifyServerResponse(r.status, r.json, visible.has(id));
        const row: McpServerRow = {
          id,
          name: visible.get(id)?.name ?? '(not visible)',
          state: v.state,
          bucket: v.bucket,
          tools: v.toolNames.length,
          toolNames: [...v.toolNames].sort(),
          detail: v.detail.slice(0, 140),
          hint: v.hint,
          certainty: v.certainty,
          httpStatus: r.status,
          toolSchemas: toolSchemasOf(r.json),
          toolInfo: toolInfoOf(r.json),
        };
        if (v.bucket !== 'HEALTHY') {
          const file = join(rawDir, `${a.key}-${id}.json`);
          try {
            writeFileSync(file, JSON.stringify({ serverId: id, serverName: row.name, label: a.key, when, status: r.status, state: v.state, errorText: scrub(v.detail).slice(0, 500) }, null, 1));
            row.rawUrl = `/output/_mcp/${runId}/raw/${a.key}-${id}.json`;
          } catch {
            /* raw answers are best-effort */
          }
        }
        return row;
      });
      const byServer = new Map<number, McpServerRow>(servers.map((s) => [s.id, s]));
      const nodes: McpNodeRow[] = extracted.map((n) =>
        classifyNode(
          { workflow: n.workflow, tool: n.tool, toolNames: n.toolNames, serverId: n.serverId, nonLiteral: n.nonLiteral },
          typeof n.serverId === 'number' ? byServer.get(n.serverId) : undefined,
        ),
      );
      const healthy = servers.filter((s) => s.bucket === 'HEALTHY').length;
      const sub = workflowsReachable ? `${defs.length} workflows, ${extracted.length} nodes` : 'workflows unreachable, nodes not checked';
      const account: McpAccountResult = {
        title,
        sub,
        servers,
        nodes,
        ...(healthy < servers.length * 0.25 && servers.length > 0
          ? { limitedNote: `This account has ${healthy} of ${servers.length} connectors working; results are limited. Add an account that has connected more of them.` }
          : {}),
      };
      accounts[a.key] = account;

      // ---- 5. snapshot + diff (same host + label only) ----------------------
      // Snapshots only need states and tool names for the diff; keep tool descriptions out of them.
      const cur = { base: input.environment.baseUrl, host, label: a.key, when, servers: servers.map(({ toolInfo: _toolInfo, ...rest }) => rest), nodes, rulesVersion: RULES_VERSION };
      const prev = loadPrevious(input.outputDir, host, a.key);
      saveSnapshot(input.outputDir, cur);
      const d = diffSnapshots(prev?.snapshot ?? null, cur);
      firstRun[a.key] = d.firstRun;
      changes[a.key] = d.serverChanges;
      if (d.rulesChanged) {
        rulesChanged[a.key] = d.rulesChanged;
        say(`[${a.key}] The sorting rules changed since the last run, so status changes were not compared (new and removed connectors and tool changes still are).`);
      }
      say(`[${a.key}] Done: ${healthy} of ${servers.length} connectors working · ${d.firstRun ? 'first run for this account, nothing to compare yet' : `${d.serverChanges.length} changed since the last run`}`);
    }

    const order = input.accounts.map((a) => a.key);
    accounts.combined = combineAccounts(accounts, order);
    emit('report', 'Done', '', 1, 1, true);
    return { host, when: new Date().toISOString(), order: [...order, 'combined'], accounts, changes, firstRun, rulesChanged, rulesVersion: RULES_VERSION, notCovered: { webRequestNodes } };
  } finally {
    forgetSecrets([...creds.values()].flatMap((c) => [c.jwt, c.csrf]));
    creds.clear();
    log.debug('mcp tokens cleared from memory');
  }
}

// ---------------------------------------------------------------- CLI command

const ACCOUNT_KEY_RE = /^[a-z0-9_]{1,40}$/;

/**
 * `npm run mcp -- --config run.config.json --account admin=<jwt-file> [--delay-ms N] [--dry-run]`.
 * jwts come from FILES only; a jwt value on the command line is never accepted
 * (there is no flag that takes one). Numeric args are validated, never coerced
 * silently. Exit 0 = ran clean, 2 = something needs a fix, 1 = error (thrown).
 */
export async function commandMcp(opts: Pick<CliOptions, 'configFile' | 'account' | 'delayMs' | 'dryRun'>): Promise<number> {
  const cfg = loadSiteConfig(opts.configFile ?? 'run.config.json');
  const specs = opts.account ?? [];
  if (!specs.length) throw new Error('Pass at least one --account <key>=<jwt-file> (a jwt value is never accepted on the command line)');
  const accounts: McpAccountInput[] = specs.map((spec) => {
    const eq = spec.indexOf('=');
    if (eq <= 0) throw new Error(`--account needs <key>=<jwt-file>, got ${JSON.stringify(spec).slice(0, 60)}`);
    const key = spec.slice(0, eq).trim();
    const file = spec.slice(eq + 1).trim();
    if (!ACCOUNT_KEY_RE.test(key)) throw new Error(`--account key "${key.slice(0, 60)}" must match /^[a-z0-9_]{1,40}$/`);
    if (!file) throw new Error(`--account ${key} needs a jwt file path`);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      throw new Error(`--account ${key}: cannot read jwt file ${file.slice(0, 120)}`);
    }
    const jwt = cleanJwt(raw);
    if (!jwt) throw new Error(`--account ${key}: jwt file is empty`);
    return { key, jwt };
  });
  // 500 ms when the config file sets none: what the shared run config defaulted to before.
  const delayMs = opts.delayMs ?? cfg.delayMs ?? 500;
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 30000) {
    throw new Error(`--delay-ms must be a number in 0..30000 (got ${String(opts.delayMs).slice(0, 40)})`);
  }
  if (opts.dryRun) {
    console.log(`DRY RUN — no requests will be made.\nEnvironment: ${cfg.environment.name} (${cfg.environment.baseUrl})`);
    console.log(`Accounts: ${accounts.map((a) => a.key).join(', ')}`);
    console.log('Planned: workflow list, visible servers per scope (company|org|user), live tool list per server, snapshot + diff.');
    return 0;
  }
  console.log(`MCP health check against ${cfg.environment.name} (${cfg.environment.baseUrl})`);
  let lastStage = '';
  const result = await runMcpHealth({
    environment: cfg.environment,
    accounts,
    outputDir: cfg.outputDir,
    delayMs,
    onProgress: (p) => {
      if (p.stage !== lastStage) {
        lastStage = p.stage;
        console.log(`  ${p.stageLabel}…`);
      }
    },
  });
  for (const key of result.order) {
    const a = result.accounts[key]!;
    let fix = 0;
    let recon = 0;
    let cant = 0;
    let ok = 0;
    for (const s of a.servers) {
      if (s.bucket === 'BROKEN') fix += 1;
      else if (s.bucket === 'MAYBE') recon += 1;
      else if (s.bucket === 'NEEDS_YOU') cant += 1;
      else ok += 1;
    }
    console.log(`  [${key}] ${a.servers.length} connectors: ${fix} need a fix · ${recon} need reconnecting · ${cant} can't be checked with this account · ${ok} working`);
  }
  console.log(`Output: ${join(cfg.outputDir, '_mcp')} (snapshots, raw answers, audit)`);
  const needsFix = Object.values(result.accounts).some(
    (a) => a.servers.some((s) => s.bucket === 'BROKEN') || a.nodes.some((n) => n.bucket === 'BROKEN'),
  );
  return needsFix ? 2 : 0;
}
