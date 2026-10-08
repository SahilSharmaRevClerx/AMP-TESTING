import type { ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clamp, environmentFrom, HttpError } from '../../core/http';
import type { LastRun, TestModule } from '../../core/module';
import { DEBUG_DIR, OUTPUT_DIR } from '../../core/paths';
import { selectUserTypes } from '../../core/rulebook/parse';
import { getRulebook, type LoadedRulebook } from '../../core/rulebooks';
import type { Credentials, Environment, Rulebook } from '../../core/types';
import { credsFrom, type UserInput } from '../../core/users';
import { createLogger } from '../../core/util/logger';
import { forgetSecrets, scrub } from '../../core/util/mask';
import { buildConfig } from './config';
import { executeRun, newRunId, planRun, type Progress, type RunOutcome } from './run';
import type { RunConfig, Verdict } from './types';

/**
 * AMP Pages Testing: opens every rulebook page as each user type and checks it against the
 * rulebook. Read-only. Page: /pages. API: /api/plan, /api/runs…
 */

const log = createLogger('server');
const UI_FILE = fileURLToPath(new URL('./ui.html', import.meta.url));

interface RunRequest {
  environment: Environment;
  rulebookId: string;
  /** User-type columns the tester confirmed on the rulebook step (default: all detected). */
  selectedUserTypes?: string[];
  users: UserInput[];
  options?: { limit?: number; delayMs?: number; fingerprintThreshold?: number; headed?: boolean; parallelUsers?: number; debugShots?: boolean; pageWaitSec?: number };
}

interface RunState {
  id: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  environment: Environment;
  startedAt: string;
  lines: string[];
  progress: Progress | null;
  outcome: RunOutcome | null;
  controller: AbortController;
  listeners: Set<ServerResponse>;
}

export function createPagesModule(): TestModule {
  /** One run at a time; the page follows it over server-sent events. */
  let current: RunState | null = null;

  return {
    id: 'pages',
    card: {
      title: 'AMP Pages Testing',
      category: 'Step 2 · Verify',
      description: 'Checks which pages each user type can open on an AMP site, against your rulebook, with screenshot proof for every result.',
      tags: ['Rulebook', 'jwt per user', 'Screenshots'],
      icon: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M9.5 14.5l1.8 1.8 3.5-3.6"/></svg>',
      href: '/pages',
      order: 2,
    },
    pages: { '/pages': UI_FILE, '/pages.html': UI_FILE },
    isPublic: (method, path) => method === 'GET' && (path === '/api/runs' || path === '/api/runs/current' || /^\/api\/runs\/[\w-]+\/events$/.test(path)),
    isRoutine: (method, path) => method === 'GET' && (path === '/api/runs' || path === '/api/runs/current' || path.endsWith('/events')),
    lastRun,

    async handle(ctx) {
      const { method, path, req, res } = ctx;

      if (method === 'GET' && path === '/api/runs') return ctx.json(200, { runs: listRuns() });
      if (method === 'GET' && path === '/api/runs/current') return ctx.json(200, { run: publicState(current) });

      const events = /^\/api\/runs\/([\w-]+)\/events$/.exec(path);
      if (method === 'GET' && events) {
        if (!current || current.id !== events[1]) return ctx.json(404, { error: 'No such active run' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: init\ndata: ${JSON.stringify({ lines: current.lines, state: publicState(current) })}\n\n`);
        const state = current;
        state.listeners.add(res);
        req.on('close', () => state.listeners.delete(res));
        return true;
      }

      if (method === 'POST' && path === '/api/plan') {
        const { cfg, plan, only, notes } = setupFrom(await ctx.body<RunRequest>());
        return ctx.json(200, {
          environment: cfg.environment,
          userTypes: plan.allTypes,
          tested: only,
          notes,
          pages: plan.pages.map((p) => ({ route: p.route, label: p.label })),
          pageOpens: plan.pageOpens,
          estimatedMinutes: plan.estimatedMinutes,
          parallelUsers: Math.min(cfg.parallelUsers, plan.testedTypes.length),
        });
      }

      if (method === 'POST' && path === '/api/runs') {
        if (current?.status === 'running') throw new HttpError(409, 'A run is already in progress');
        const body = await ctx.body<RunRequest>();
        const { loaded, rulebook, cfg, only, plan, notes } = setupFrom(body);
        const creds = credsFrom(body.users ?? [], plan.allTypes);
        current = startRun(cfg, loaded, rulebook, creds, only, notes, body.options?.limit);
        return ctx.json(202, { run: publicState(current) });
      }

      const cancel = /^\/api\/runs\/([\w-]+)\/cancel$/.exec(path);
      if (method === 'POST' && cancel) {
        if (!current || current.id !== cancel[1] || current.status !== 'running') throw new HttpError(404, 'No such active run');
        current.controller.abort();
        log.info('cancel requested', { run: current.id });
        return ctx.json(200, { ok: true });
      }

      return false;
    },
  };
}

function configFrom(body: RunRequest, rb: Rulebook): RunConfig {
  // User types and their names come only from the rulebook's column headers.
  const userTypes: Record<string, { label: string }> = {};
  for (const key of rb.userTypes) userTypes[key] = { label: rb.userTypeLabels[key] ?? key };
  const o = body.options ?? {};
  return buildConfig(
    {
      environment: environmentFrom(body),
      rulebook: '(uploaded)',
      calibrationUserType: null,
      userTypes,
      outputDir: OUTPUT_DIR,
      debugDir: DEBUG_DIR,
      debugShots: o.debugShots !== false,
      headless: o.headed !== true,
      ...(o.delayMs !== undefined ? { delayMs: clamp(o.delayMs, 200, 5000) } : {}),
      ...(o.fingerprintThreshold !== undefined ? { fingerprintThreshold: clamp(o.fingerprintThreshold, 0.2, 1) } : {}),
      ...(o.parallelUsers !== undefined ? { parallelUsers: o.parallelUsers } : {}),
      ...(o.pageWaitSec !== undefined ? { pageTimeoutMs: clamp(o.pageWaitSec, 10, 120) * 1000 } : {}),
    },
    'request',
  );
}

/** Rulebook user types the tester ticked. */
function onlyFrom(body: RunRequest, rb: Rulebook): string[] {
  const only = rb.userTypes.filter((ut) => body.users?.find((u) => u.key === ut)?.test === true);
  if (only.length === 0) throw new HttpError(400, 'Tick at least one user type to test (paste its tokens to tick it)');
  return only;
}

/** Everything a plan or run needs from a request. */
function setupFrom(body: RunRequest) {
  const loaded = getRulebook(body.rulebookId);
  let rulebook: Rulebook;
  try {
    rulebook = selectUserTypes(loaded.rulebook, body.selectedUserTypes);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const notes: string[] = [];
  const cfg = configFrom(body, rulebook);
  const only = onlyFrom(body, rulebook);
  const plan = planRun(cfg, rulebook, only, body.options?.limit);
  return { loaded, rulebook, cfg, only, plan, notes };
}

function broadcast(state: RunState, event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const l of state.listeners) l.write(msg);
}

function publicState(s: RunState | null) {
  if (!s) return null;
  return {
    id: s.id,
    status: s.status,
    environment: { name: s.environment.name, baseUrl: s.environment.baseUrl },
    startedAt: s.startedAt,
    progress: s.progress,
    outcome: s.outcome && { code: s.outcome.code, error: s.outcome.error, summary: s.outcome.summary, reportUrl: s.outcome.reportFile ? `/output/${s.id}/report.html` : null },
  };
}

function startRun(cfg: RunConfig, rb: LoadedRulebook, rulebook: Rulebook, creds: Map<string, Credentials>, only: string[], notes: string[], limit?: number): RunState {
  const id = newRunId(cfg.environment.name);
  const state: RunState = {
    id,
    status: 'running',
    environment: cfg.environment,
    startedAt: new Date().toISOString(),
    lines: [],
    progress: null,
    outcome: null,
    controller: new AbortController(),
    listeners: new Set(),
  };

  const runLog = createLogger('run-log');
  const pushLine = (line: string) => {
    for (const l of scrub(line).split('\n')) {
      state.lines.push(l);
      broadcast(state, 'log', l);
      // The tester-facing log (what the UI shows) is mirrored to the terminal in debug mode only;
      // the structured [run] lines cover the same events at info level.
      if (l.trim()) runLog.debug(l.trim());
    }
    if (state.lines.length > 5000) state.lines.splice(0, state.lines.length - 5000);
  };

  void executeRun(
    {
      cfg,
      rulebook,
      rulebookSource: { name: rb.name, data: rb.data },
      creds,
      only,
      limit,
      notes,
      signal: state.controller.signal,
      reporter: {
        log: pushLine,
        progress: (p) => {
          state.progress = p;
          broadcast(state, 'progress', p);
        },
      },
    },
    id,
  )
    .catch((e: unknown) => {
      log.error('run failed unexpectedly', e, { run: id });
      return { code: 1, runId: id, outDir: join(OUTPUT_DIR, id), error: scrub((e as Error).message), summary: {} } as RunOutcome;
    })
    .then((outcome) => {
      // Tokens are not kept after the run, not even in the masking list.
      forgetSecrets([...creds.values()].flatMap((c) => [c.jwt, c.csrf]));
      creds.clear();
      log.debug('tokens cleared from memory', { run: id });
      state.outcome = outcome;
      state.status = outcome.code === 130 ? 'cancelled' : outcome.error ? 'failed' : 'done';
      try {
        mkdirSync(outcome.outDir, { recursive: true });
        writeFileSync(
          join(outcome.outDir, 'summary.json'),
          JSON.stringify({
            runId: id,
            environment: { name: cfg.environment.name, baseUrl: cfg.environment.baseUrl },
            rulebook: rb.name,
            startedAt: state.startedAt,
            finishedAt: new Date().toISOString(),
            status: state.status,
            code: outcome.code,
            error: outcome.error ?? null,
            summary: outcome.summary,
            reportUrl: outcome.reportFile ? `/output/${id}/report.html` : null,
          }),
        );
      } catch {
        /* history is best-effort */
      }
      broadcast(state, 'done', publicState(state));
    });
  return state;
}

// ---------------------------------------------------------------- run history

interface PastRun {
  runId: string;
  environment: { name: string; baseUrl: string } | null;
  startedAt: string;
  code: number | null;
  summary: Record<string, Partial<Record<Verdict, number>>> | null;
  reportUrl: string;
  status?: string;
}

function listRuns(): PastRun[] {
  if (!existsSync(OUTPUT_DIR)) return [];
  const runs: PastRun[] = [];
  for (const d of readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_') || d.name.startsWith('e2e-')) continue;
    const dir = join(OUTPUT_DIR, d.name);
    const summaryFile = join(dir, 'summary.json');
    if (existsSync(summaryFile)) {
      try {
        runs.push(JSON.parse(readFileSync(summaryFile, 'utf8')));
        continue;
      } catch {
        /* fall through */
      }
    }
    if (existsSync(join(dir, 'report.html'))) {
      runs.push({ runId: d.name, environment: null, startedAt: statSync(dir).mtime.toISOString(), code: null, summary: null, reportUrl: `/output/${d.name}/report.html` });
    }
  }
  return runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 50);
}

/** The newest run, with failed / review / passed totals across its user types. */
function lastRun(): LastRun | null {
  const x = listRuns()[0];
  if (!x) return null;
  if (!x.summary) return { startedAt: x.startedAt };
  const counts = { fail: 0, review: 0, pass: 0 };
  for (const byVerdict of Object.values(x.summary)) {
    for (const [v, n] of Object.entries(byVerdict)) {
      if (v.startsWith('FAIL')) counts.fail += n ?? 0;
      else if (v === 'REVIEW') counts.review += n ?? 0;
      else if (v === 'PASS') counts.pass += n ?? 0;
    }
  }
  return { startedAt: x.startedAt, counts };
}
