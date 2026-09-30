import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildConfig, makeCredentials } from '../config';
import { parseRulebook, rulebookSummary, withAllowAllColumn } from '../rulebook/parse';
import { assertSafeEnvironment, RequestGate, SafetyError } from '../safety/gate';
import { validateToken } from '../sessions/validate';
import { executeRun, newRunId, planRun, type Progress, type RunOutcome } from '../run';
import { AuditLog } from '../util/audit';
import { registerSecret, scrub } from '../util/mask';
import { createLogger, getLogLevel, isDebug, since } from '../util/logger';
import type { Credentials, Environment, Rulebook, RunConfig } from '../types';

const log = createLogger('server');
const httpLog = createLogger('http');

const PORT = Number(process.env.PORT ?? 4545);
const HOST = '127.0.0.1';
const ROOT = process.cwd();
const RULEBOOK_DIR = join(ROOT, 'rulebook');
const OUTPUT_DIR = join(ROOT, 'output');
const UI_FILE = fileURLToPath(new URL('./ui.html', import.meta.url));
const MAX_BODY = 8 * 1024 * 1024;

// ---------------------------------------------------------------- state (memory only)

interface LoadedRulebook {
  id: string;
  name: string;
  data: Buffer;
  rulebook: Rulebook;
}
const rulebooks = new Map<string, LoadedRulebook>();

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
let current: RunState | null = null;

// ---------------------------------------------------------------- request shapes

interface UserInput {
  key: string;
  label?: string;
  jwt?: string;
  csrf?: string;
  test?: boolean;
}
interface RunRequest {
  environment: Environment;
  rulebookId: string;
  calibrationKey: string;
  users: UserInput[];
  options?: { limit?: number; delayMs?: number; fingerprintThreshold?: number; headed?: boolean };
}

// ---------------------------------------------------------------- helpers

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        fail(new HttpError(400, 'Body must be JSON'));
      }
    });
    req.on('error', fail);
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Only this UI may call the API: a custom header forces a CORS preflight (which we never allow),
 * and a present Origin must be this server. Stops other websites from driving the tool.
 */
function assertFromUi(req: IncomingMessage): void {
  if (req.headers['x-amp-ui'] !== '1') throw new HttpError(403, 'Missing UI header');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) {
    throw new HttpError(403, 'Cross-origin request refused');
  }
}

const KEY_RE = /^[a-z0-9_]{1,40}$/;

function environmentFrom(body: { environment?: Environment }): Environment {
  const env = body.environment;
  if (!env?.baseUrl) throw new HttpError(400, 'Base URL is required');
  let url: URL;
  try {
    url = new URL(env.baseUrl.trim());
  } catch {
    throw new HttpError(400, 'Base URL is not a valid URL');
  }
  const out: Environment = {
    name: (env.name ?? '').trim() || url.host,
    baseUrl: url.origin,
    isProduction: env.isProduction === true,
    allowProduction: env.allowProduction === true,
  };
  assertSafeEnvironment(out);
  return out;
}

function credsFrom(users: UserInput[], keys: string[]): Map<string, Credentials> {
  const creds = new Map<string, Credentials>();
  for (const key of keys) {
    const u = users.find((x) => x.key === key);
    const jwt = u?.jwt?.trim();
    if (!jwt) throw new HttpError(400, `jwt missing for ${u?.label || key}`);
    creds.set(key, makeCredentials(jwt, u?.csrf));
  }
  return creds;
}

/** The reference user is used only when its jwt was entered. */
function referenceKey(body: RunRequest): string | null {
  const key = body.calibrationKey?.trim();
  if (!key) return null;
  if (!KEY_RE.test(key)) throw new HttpError(400, 'Reference user key must be lowercase letters, digits or _');
  const u = body.users?.find((x) => x.key === key);
  return u?.jwt?.trim() ? key : null;
}

function configFrom(body: RunRequest, rb: Rulebook): RunConfig {
  const calibrationKey = referenceKey(body);
  const userTypes: Record<string, { label: string }> = {};
  for (const key of new Set([...(calibrationKey ? [calibrationKey] : []), ...rb.userTypes])) {
    const u = body.users.find((x) => x.key === key);
    userTypes[key] = { label: u?.label?.trim() || key };
  }
  const o = body.options ?? {};
  const cfg = buildConfig(
    {
      environment: environmentFrom(body),
      rulebook: '(uploaded)',
      calibrationUserType: calibrationKey,
      userTypes,
      outputDir: OUTPUT_DIR,
      headless: o.headed !== true,
      ...(o.delayMs !== undefined ? { delayMs: clamp(o.delayMs, 200, 5000) } : {}),
      ...(o.fingerprintThreshold !== undefined ? { fingerprintThreshold: clamp(o.fingerprintThreshold, 0.2, 1) } : {}),
    },
    'request',
  );
  return cfg;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number(n) || lo));
}

function getRulebook(id: string): LoadedRulebook {
  const rb = rulebooks.get(id);
  if (!rb) throw new HttpError(400, 'Rulebook not loaded; select or upload it again');
  return rb;
}

/** Rulebook user types the tester ticked. */
function onlyFrom(body: RunRequest, rb: Rulebook): string[] {
  const only = rb.userTypes.filter((ut) => body.users?.find((u) => u.key === ut)?.test === true);
  if (only.length === 0) throw new HttpError(400, 'Tick at least one user type to test (paste its tokens to tick it)');
  return only;
}

/**
 * Everything a plan or run needs from a request. When the reference Site Admin is ticked for testing
 * but the rulebook has no column for it, it is expected to see every page.
 */
function setupFrom(body: RunRequest) {
  const loaded = getRulebook(body.rulebookId);
  let rulebook = loaded.rulebook;
  const notes: string[] = [];
  const ref = referenceKey(body);
  const refTested = ref !== null && body.users?.find((u) => u.key === ref)?.test === true;
  if (refTested && !rulebook.userTypes.includes(ref)) {
    rulebook = withAllowAllColumn(rulebook, ref);
    const label = body.users.find((u) => u.key === ref)?.label || ref;
    notes.push(`The rulebook has no column for ${label}, so ${label} is expected to see every page (a Site Admin with MFA has access to every module in AMP).`);
  }
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

// ---------------------------------------------------------------- run history

function listRuns() {
  if (!existsSync(OUTPUT_DIR)) return [];
  const runs = [];
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

// ---------------------------------------------------------------- routes

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return send(res, 200, readFileSync(UI_FILE, 'utf8'), 'text/html');
  }

  if (method === 'GET' && path.startsWith('/output/')) return serveOutput(path, res);

  if (!path.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

  if (method === 'GET' && path === '/api/rulebooks') {
    const files = existsSync(RULEBOOK_DIR) ? readdirSync(RULEBOOK_DIR).filter((f) => /\.(csv|xlsx)$/i.test(f)) : [];
    return send(res, 200, { files });
  }
  if (method === 'GET' && path === '/api/runs') return send(res, 200, { runs: listRuns() });
  if (method === 'GET' && path === '/api/runs/current') return send(res, 200, { run: publicState(current) });

  const events = /^\/api\/runs\/([\w-]+)\/events$/.exec(path);
  if (method === 'GET' && events) {
    if (!current || current.id !== events[1]) return send(res, 404, { error: 'No such active run' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: init\ndata: ${JSON.stringify({ lines: current.lines, state: publicState(current) })}\n\n`);
    const state = current;
    state.listeners.add(res);
    req.on('close', () => state.listeners.delete(res));
    return;
  }

  // Everything below changes state or uses tokens: UI only.
  assertFromUi(req);

  if (method === 'POST' && path === '/api/rulebooks/parse') {
    const body = (await readBody(req)) as { file?: string; name?: string; contentBase64?: string };
    let name: string;
    let data: Buffer;
    if (body.file) {
      const file = resolve(RULEBOOK_DIR, body.file);
      if (!file.startsWith(RULEBOOK_DIR + sep) || !existsSync(file)) throw new HttpError(400, 'Unknown rulebook file');
      name = body.file;
      data = readFileSync(file);
    } else if (body.name && body.contentBase64) {
      name = body.name.replace(/[^\w.\- ]/g, '_');
      data = Buffer.from(body.contentBase64, 'base64');
    } else throw new HttpError(400, 'Choose a rulebook file');
    let rulebook: Rulebook;
    try {
      rulebook = await parseRulebook(name, data);
    } catch (e) {
      throw new HttpError(400, `Could not read rulebook: ${(e as Error).message}`);
    }
    const bad = rulebook.userTypes.filter((ut) => !KEY_RE.test(ut));
    if (bad.length) throw new HttpError(400, `User type columns must be lowercase letters, digits or _: ${bad.join(', ')}`);
    const id = randomUUID();
    rulebooks.set(id, { id, name, data, rulebook });
    const summary = rulebookSummary(rulebook);
    log.info('rulebook loaded', { name, source: body.file ? 'saved' : 'upload', bytes: data.length, pages: summary.pages, userTypes: summary.userTypes });
    return send(res, 200, { id, name, summary });
  }

  if (method === 'POST' && path === '/api/tokens/check') {
    const body = (await readBody(req)) as { environment?: Environment; users?: UserInput[] };
    const env = environmentFrom(body);
    const users = (body.users ?? []).filter((u) => u.key && KEY_RE.test(u.key) && u.jwt?.trim());
    if (!users.length) throw new HttpError(400, 'Paste a jwt for at least one user first');
    const gate = new RequestGate(env, 300, new AuditLog(join(OUTPUT_DIR, '_ui', 'token-checks.jsonl')));
    const results = [];
    for (const u of users) {
      const creds = credsFrom([u], [u.key]);
      const identity = await validateToken(gate, u.key, creds.get(u.key)!);
      results.push({ key: u.key, identity });
      if (identity.valid) log.info('token check ok', { env: env.name, user: u.key, name: identity.userName, persona: identity.persona, siteAdmin: identity.isSiteAdmin, company: identity.companyName, org: identity.organizationName });
      else log.warn('token check failed', { env: env.name, user: u.key, reason: identity.reason });
    }
    return send(res, 200, { results });
  }

  if (method === 'POST' && path === '/api/plan') {
    const { cfg, plan, only, notes } = setupFrom((await readBody(req)) as RunRequest);
    return send(res, 200, {
      environment: cfg.environment,
      userTypes: plan.allTypes,
      tested: only,
      reference: cfg.calibrationUserType,
      notes,
      pages: plan.pages.map((p) => ({ route: p.route, label: p.label })),
      pageOpens: plan.pageOpens,
      estimatedMinutes: plan.estimatedMinutes,
    });
  }

  if (method === 'POST' && path === '/api/runs') {
    if (current?.status === 'running') throw new HttpError(409, 'A run is already in progress');
    const body = (await readBody(req)) as RunRequest;
    const { loaded, rulebook, cfg, only, plan, notes } = setupFrom(body);
    const creds = credsFrom(body.users ?? [], plan.allTypes);
    startRun(cfg, loaded, rulebook, creds, only, notes, body.options?.limit);
    return send(res, 202, { run: publicState(current) });
  }

  const cancel = /^\/api\/runs\/([\w-]+)\/cancel$/.exec(path);
  if (method === 'POST' && cancel) {
    if (!current || current.id !== cancel[1] || current.status !== 'running') throw new HttpError(404, 'No such active run');
    current.controller.abort();
    log.info('cancel requested', { run: current.id });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

function startRun(
  cfg: RunConfig,
  rb: LoadedRulebook,
  rulebook: Rulebook,
  creds: Map<string, Credentials>,
  only: string[],
  notes: string[],
  limit?: number,
): void {
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
  current = state;

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
      creds.clear(); // tokens are not kept after the run
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
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.png': 'image/png',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.jsonl': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function serveOutput(path: string, res: ServerResponse): void {
  const file = resolve(OUTPUT_DIR, decodeURIComponent(path.slice('/output/'.length)));
  if (!file.startsWith(OUTPUT_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
}

// ---------------------------------------------------------------- start

/** GETs of the page, reports, history and the live event stream are routine; only shown with --debug. */
function isRoutine(method: string, path: string): boolean {
  return method === 'GET' && (path === '/' || path.startsWith('/output/') || path === '/api/runs' || path === '/api/runs/current' || path === '/api/rulebooks' || path.endsWith('/events'));
}

const server = createServer((req, res) => {
  const started = Date.now();
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0]!;
  let failure: { message: string; err?: unknown } | null = null;

  res.on('finish', () => {
    const fields = { method, path, status: res.statusCode, ms: since(started), error: failure?.message };
    if (res.statusCode >= 500) httpLog.error('request failed', failure?.err, fields);
    else if (res.statusCode >= 400) httpLog.warn('request rejected', fields);
    else if (isRoutine(method, path)) httpLog.debug('request', fields);
    else httpLog.info('request', fields);
  });

  handle(req, res).catch((e: unknown) => {
    const status = e instanceof HttpError ? e.status : e instanceof SafetyError ? 400 : 500;
    const message = scrub((e as Error).message ?? 'Unexpected error');
    failure = { message, err: status >= 500 ? e : undefined };
    if (!res.headersSent) send(res, status, { error: message });
    else res.end();
  });
});

process.on('unhandledRejection', (e) => log.error('unhandled promise rejection', e));
process.on('uncaughtException', (e) => log.error('uncaught exception', e));

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') log.error(`port ${PORT} is already in use - is the tool already running in another terminal? Stop it or set PORT=<other>`);
  else log.error('server error', e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  log.info(`UI running at ${url}`, { logLevel: getLogLevel(), node: process.version, cwd: ROOT, output: OUTPUT_DIR });
  log.info('tokens entered in the UI stay in this process memory only; press Ctrl+C to stop');
  if (!isDebug()) log.info('for detailed logs (every page, request and blocked call) start with: npm run start:debug');
  if (!process.argv.includes('--no-open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => undefined);
  }
});
