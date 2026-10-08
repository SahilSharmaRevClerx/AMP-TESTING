import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCredentials } from '../../core/credentials';
import { environmentFrom, HttpError, KEY_RE } from '../../core/http';
import type { LastRun, TestModule } from '../../core/module';
import { OUTPUT_DIR } from '../../core/paths';
import { RequestGate } from '../../core/safety/gate';
import { validateToken } from '../../core/sessions/validate';
import type { Environment } from '../../core/types';
import { AuditLog } from '../../core/util/audit';
import { createLogger } from '../../core/util/logger';
import { forgetSecrets, scrub } from '../../core/util/mask';
import { aiAvailable, aiModelName, buildTriageItems, TRIAGE_CAP, triage } from './ai';
import { McpCancelledError, runMcpHealth, type McpProgress } from './run';
import type { McpResult } from './types';

/**
 * MCP Connector Health: checks the MCP connectors the AIRA workflows use, per account. Read-only.
 * Page: /mcp. API: /api/mcp/…
 */

const log = createLogger('server');
const MCP_FILE = fileURLToPath(new URL('./mcp.html', import.meta.url));
const MCP_DIR = join(OUTPUT_DIR, '_mcp');

/** One MCP run at a time; the page polls it (no SSE). */
interface McpRunState {
  id: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  environment: Environment;
  startedAt: string;
  lines: string[];
  progress: McpProgress | null;
  outcome: { error?: string; result?: McpResult } | null;
  controller: AbortController;
  /** AI review was requested for this run (the page shows an extra stage). */
  ai: boolean;
}

interface McpUserBody {
  key?: string;
  jwt?: string;
}

type Counts = { fix: number; reconnect: number; cantCheck: number; working: number };

export function createMcpModule(): TestModule {
  let mcp: McpRunState | null = null;

  return {
    id: 'mcp',
    card: {
      title: 'MCP Connector Health',
      category: 'Step 3 · Connectors',
      description: 'Checks every MCP connector the AIRA workflows depend on: which are broken, which just need a reconnect, and which workflow nodes call a tool that does not exist.',
      tags: ['jwt per account', 'Read-only', 'Tool lists'],
      icon: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 01-10 0zM12 16v5"/></svg>',
      href: '/mcp',
      order: 3,
    },
    pages: { '/mcp': MCP_FILE, '/mcp.html': MCP_FILE },
    // Page data and history are open like the setter's; the POSTs need the UI header (checked by the app).
    isPublic: (method, path) => method === 'GET' && (path === '/api/mcp/runs/current' || path === '/api/mcp/runs' || /^\/api\/mcp\/runs\/[\w-]+$/.test(path)),
    lastRun: (): LastRun | null => {
      const x = mcpHistory()[0];
      return x ? { startedAt: x.startedAt } : null;
    },

    async handle(ctx) {
      const { method, path, url } = ctx;
      if (!path.startsWith('/api/mcp/')) return false;

      if (method === 'GET' && path === '/api/mcp/runs/current') {
        const from = Number(url.searchParams.get('from') ?? 0);
        return ctx.json(200, { run: mcpPublic(mcp, Number.isFinite(from) ? from : 0) });
      }
      if (method === 'GET' && path === '/api/mcp/runs') return ctx.json(200, { runs: mcpHistory() });

      const one = /^\/api\/mcp\/runs\/([\w-]+)$/.exec(path);
      if (method === 'GET' && one) {
        const dir = join(MCP_DIR, one[1]!);
        const file = join(dir, 'result.json');
        if (!resolve(file).startsWith(MCP_DIR + sep) || !existsSync(file)) throw new HttpError(404, 'No such MCP run');
        return ctx.json(200, { result: JSON.parse(readFileSync(file, 'utf8')) });
      }

      if (method === 'POST' && path === '/api/mcp/check') {
        const { env, users } = mcpSetup(await ctx.body<{ environment?: Environment; users?: McpUserBody[] }>());
        const gate = new RequestGate(env, 300, new AuditLog(join(OUTPUT_DIR, '_ui', 'mcp-checks.jsonl')));
        const out = [];
        for (const u of users) {
          const creds = makeCredentials(u.jwt);
          try {
            const id = await validateToken(gate, u.key, creds);
            out.push(
              id.valid
                ? { key: u.key, ok: true, identity: { name: id.userName ?? u.key, persona: id.persona, company: id.organizationName ?? id.companyName } }
                : { key: u.key, ok: false, error: id.reason ?? 'That jwt did not work.' },
            );
            if (id.valid) log.info('mcp token check ok', { env: env.name, user: u.key, name: id.userName });
            else log.warn('mcp token check failed', { env: env.name, user: u.key, reason: id.reason });
          } finally {
            forgetSecrets([creds.jwt, creds.csrf]);
          }
        }
        return ctx.json(200, { users: out });
      }

      if (method === 'POST' && path === '/api/mcp/plan') {
        const { env, users } = mcpSetup(await ctx.body<{ environment?: Environment; users?: McpUserBody[] }>());
        const first = makeCredentials(users[0]!.jwt);
        try {
          const gate = new RequestGate(env, 300, new AuditLog(join(OUTPUT_DIR, '_ui', 'mcp-checks.jsonl')));
          let reachable = false;
          let count = 0;
          let error: string | undefined;
          try {
            const r = await gate.fetch(users[0]!.key, 'GET', gate.resolve('/api/elsa-agents/workflow-definitions'), first);
            if (r.ok) {
              const j: unknown = await r.json().catch(() => null);
              if (Array.isArray(j)) {
                reachable = true;
                count = j.length;
              } else error = `HTTP ${r.status}`;
            } else error = `HTTP ${r.status}`;
          } catch (e) {
            error = scrub((e as Error).message).slice(0, 120);
          }
          return ctx.json(200, {
            accounts: users.length,
            workflows: reachable ? { reachable: true, count } : { reachable: false, ...(error ? { error } : {}) },
            estimateSeconds: Math.round(10 + users.length * (5 + count * 0.5)),
            ai: aiAvailable() ? { available: true, model: aiModelName() } : { available: false },
          });
        } finally {
          forgetSecrets([first.jwt, first.csrf]);
        }
      }

      if (method === 'POST' && path === '/api/mcp/runs') {
        if (mcp?.status === 'running') throw new HttpError(409, 'An MCP run is already in progress');
        const body = await ctx.body<{ environment?: Environment; users?: McpUserBody[]; ai?: boolean }>();
        const { env, users } = mcpSetup(body);
        const aiRequested = body.ai === true;
        if (aiRequested && !aiAvailable()) {
          throw new HttpError(400, 'AI review needs a Gemini key: set GEMINI_API_KEY and restart the server, or run without AI review.');
        }
        mcp = startMcpRun(env, users, aiRequested);
        return ctx.json(202, { run: mcpPublic(mcp) });
      }

      const cancel = /^\/api\/mcp\/runs\/([\w-]+)\/cancel$/.exec(path);
      if (method === 'POST' && cancel) {
        if (!mcp || mcp.id !== cancel[1] || mcp.status !== 'running') throw new HttpError(404, 'No such active MCP run');
        mcp.controller.abort();
        log.info('mcp cancel requested', { run: mcp.id });
        return ctx.json(200, { run: mcpPublic(mcp) });
      }

      throw new HttpError(404, 'Not found');
    },
  };
}

function mcpSetup(body: { environment?: Environment; users?: McpUserBody[] }): { env: Environment; users: { key: string; jwt: string }[] } {
  const env = environmentFrom({ environment: body.environment });
  const users = (body.users ?? [])
    .filter((u) => u.key && KEY_RE.test(u.key) && u.jwt?.trim())
    .map((u) => ({ key: u.key!, jwt: u.jwt!.trim() }));
  if (!users.length) throw new HttpError(400, 'Paste a jwt for at least one account first (keys use letters, digits and _ only, max 40)');
  return { env, users };
}

function startMcpRun(env: Environment, users: { key: string; jwt: string }[], aiRequested: boolean): McpRunState {
  const id = newMcpRunId(env.name);
  const state: McpRunState = {
    id,
    status: 'running',
    environment: env,
    startedAt: new Date().toISOString(),
    lines: [],
    progress: null,
    outcome: null,
    controller: new AbortController(),
    ai: aiRequested && aiAvailable(),
  };
  log.info('mcp run started', { run: id, env: env.name, accounts: users.map((u) => u.key) });
  const jwts = users.map((u) => u.jwt);
  void runMcpHealth({
    environment: env,
    accounts: users.map((u) => ({ key: u.key, jwt: u.jwt })),
    outputDir: OUTPUT_DIR,
    delayMs: 300,
    signal: state.controller.signal,
    runId: id,
    onProgress: (p) => {
      state.progress = p;
      state.lines = [...p.lines];
    },
  })
    .then(async (result) => {
      if (aiRequested && aiAvailable()) {
        try {
          const items = buildTriageItems(result);
          const aiStart = Date.now();
          const aiSay = (current: string, done: number, total: number): void => {
            const sec = Math.floor((Date.now() - Date.parse(state.startedAt)) / 1000);
            const aiStamp = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
            state.lines = [...state.lines, `${aiStamp}  [ai] ${current}`];
            const prev = state.progress;
            const times = { ...(prev?.stageTimes ?? {}) };
            if (times.report && !times.report.endedAt) times.report = { ...times.report, endedAt: aiStart };
            state.progress = {
              ...(prev ?? {}),
              stage: 'ai',
              stageLabel: 'Writing AI notes',
              current,
              done,
              total,
              lines: state.lines,
              stageTimes: { ...times, ai: { startedAt: aiStart } },
              facts: { ...(prev?.facts ?? {}), aiItems: Math.min(items.length, TRIAGE_CAP) },
            };
          };
          aiSay(`writing notes for ${items.length} item${items.length === 1 ? '' : 's'}…`, 0, Math.max(1, Math.ceil(items.length / 20)));
          const out = await triage(items, undefined, {
            signal: state.controller.signal,
            onProgress: (done, total) => aiSay(done >= total ? 'finishing…' : `batch ${done + 1} of ${total}`, done, total),
          });
          if (out.cancelled || state.controller.signal.aborted) throw new McpCancelledError();
          const byId = new Map(out.notes.map((n) => [n.id, n]));
          for (const key of result.order) {
            const acc = result.accounts[key];
            if (!acc) continue;
            for (const s of acc.servers) {
              const n = byId.get(`server:${s.id}`);
              if (n) s.ai = { diagnosis: n.diagnosis, nextStep: n.nextStep, confidence: n.confidence };
            }
            for (const nd of acc.nodes) {
              const n = byId.get(`node:${nd.workflow}/${nd.server}/${nd.tool}`);
              if (n) nd.ai = { diagnosis: n.diagnosis, nextStep: n.nextStep, confidence: n.confidence };
            }
          }
          log.info('mcp triage attached', { run: id, items: items.length, noted: out.notes.length, model: aiModelName() });
          if (out.error) log.warn('mcp triage incomplete', { run: id, error: out.error });
        } catch (e) {
          if (e instanceof McpCancelledError) throw e;
          log.warn('mcp triage failed', { run: id, error: scrub((e as Error).message).slice(0, 160) });
        }
      }
      state.outcome = { result };
      state.status = 'done';
      try {
        mkdirSync(join(MCP_DIR, id), { recursive: true });
        writeFileSync(join(MCP_DIR, id, 'result.json'), JSON.stringify(result));
        writeFileSync(
          join(MCP_DIR, id, 'summary.json'),
          JSON.stringify({ id, host: result.host, startedAt: state.startedAt, finishedAt: new Date().toISOString(), status: state.status, accounts: result.order.filter((k) => k !== 'combined'), summary: mcpSummaryCounts(result) }),
        );
      } catch {
        /* history is best-effort */
      }
      log.info('mcp run finished', { run: id, status: state.status });
    })
    .catch((e: unknown) => {
      const cancelled = state.controller.signal.aborted || e instanceof McpCancelledError;
      state.status = cancelled ? 'cancelled' : 'failed';
      state.outcome = cancelled ? {} : { error: scrub((e as Error).message ?? 'Unexpected error') };
      try {
        mkdirSync(join(MCP_DIR, id), { recursive: true });
        writeFileSync(
          join(MCP_DIR, id, 'summary.json'),
          JSON.stringify({ id, host: new URL(env.baseUrl).host, startedAt: state.startedAt, finishedAt: new Date().toISOString(), status: state.status, accounts: users.map((u) => u.key), error: state.outcome.error ?? null }),
        );
      } catch {
        /* history is best-effort */
      }
      log.info('mcp run finished', { run: id, status: state.status, error: state.outcome.error });
    })
    .finally(() => {
      forgetSecrets(jwts);
      users.forEach((u) => {
        u.jwt = '';
      });
    });
  return state;
}

function mcpPublic(s: McpRunState | null, from = 0) {
  if (!s) return null;
  const p = s.progress;
  return {
    id: s.id,
    status: s.status,
    ai: s.ai,
    startedAt: p?.startedAt ?? Date.parse(s.startedAt),
    account: p?.account,
    stageTimes: p?.stageTimes,
    facts: p?.facts,
    tally: p?.tally,
    stage: p?.stage ?? 'workflows',
    stageLabel: p?.stageLabel ?? 'Starting…',
    current: p?.current ?? '',
    done: p?.done ?? 0,
    total: p?.total ?? 0,
    lines: s.lines.slice(Math.max(0, from)),
    lineCount: s.lines.length,
    ...(s.outcome ? { outcome: s.outcome } : {}),
  };
}

/** Past-run badges, counted on the combined (best-verdict) tab. */
function mcpSummaryCounts(result: McpResult): Counts {
  const acc = result.accounts.combined ?? Object.values(result.accounts)[0];
  const c = { fix: 0, reconnect: 0, cantCheck: 0, working: 0 };
  for (const s of acc?.servers ?? []) {
    if (s.bucket === 'BROKEN') c.fix += 1;
    else if (s.bucket === 'MAYBE') c.reconnect += 1;
    else if (s.bucket === 'NEEDS_YOU') c.cantCheck += 1;
    else c.working += 1;
  }
  return c;
}

/** Past MCP runs, newest first (max 50). Skips folders without a result file. */
function mcpHistory(): { id: string; host: string | null; startedAt: string; accounts: string[]; summary: Counts }[] {
  if (!existsSync(MCP_DIR)) return [];
  const runs = [];
  for (const d of readdirSync(MCP_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(MCP_DIR, d.name);
    const resultFile = join(dir, 'result.json');
    if (!existsSync(resultFile)) continue;
    try {
      const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
      runs.push({ id: d.name, host: summary.host ?? null, startedAt: summary.startedAt, accounts: summary.accounts ?? [], summary: summary.summary });
      continue;
    } catch {
      /* fall through to result.json */
    }
    try {
      const result = JSON.parse(readFileSync(resultFile, 'utf8')) as McpResult;
      runs.push({
        id: d.name,
        host: result.host ?? null,
        startedAt: result.when,
        accounts: (result.order ?? []).filter((k) => k !== 'combined'),
        summary: mcpSummaryCounts(result),
      });
    } catch {
      /* skip unreadable */
    }
  }
  // The e2e suites run against a fake AMP on 127.0.0.1:<random port> and write here too; like the Pages history, hide them.
  const testers = runs.filter((r) => !/^127\.0\.0\.1:\d+$/.test(String(r.host ?? '')) && !r.id.startsWith('mcp-e2e'));
  return testers.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 50);
}

function newMcpRunId(envName: string): string {
  const slug = envName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
  return `mcp-${slug}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}
