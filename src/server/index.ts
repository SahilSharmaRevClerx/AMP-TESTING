import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildConfig, loadLocalEnv, makeCredentials } from '../config';
import { parseRulebook, rulebookSummary, selectUserTypes } from '../rulebook/parse';
import { assertSafeEnvironment, RequestGate, SafetyError } from '../safety/gate';
import { duplicateIdentities, validateToken } from '../sessions/validate';
import { executeRun, newRunId, planRun, type Progress, type RunOutcome } from '../run';
import { AuditLog } from '../util/audit';
import { forgetSecrets, scrub } from '../util/mask';
import { createLogger, getLogLevel, isDebug, since } from '../util/logger';
import type { Credentials, Environment, Rulebook, RunConfig } from '../types';
import { checkSuperAdmin } from '../setter/session';
import { aiAvailable, aiModelName, buildTriageItems, TRIAGE_CAP, triage } from '../mcp/ai';
import { McpCancelledError, runMcpHealth, type McpProgress } from '../mcp/run';
import type { McpResult } from '../mcp/types';
import { executeSetter, newSetterRunId, planAll, type SetterOutcome } from '../setter/run';
import { LEVELS } from '../setter/sliders';
import { aiKeySet, aiModel } from '../setter/ai';
import { prepareNavigation } from '../setter/navrun';

const log = createLogger('server');

// The AI review's Gemini settings may live in .env or .env.local (only these names are read; jwts are entered in the page).
for (const file of ['.env.local', '.env']) loadLocalEnv(file, ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_MODEL']);
const httpLog = createLogger('http');

const PORT = Number(process.env.PORT ?? 4545);
const HOST = '127.0.0.1';
const ROOT = process.cwd();
const RULEBOOK_DIR = join(ROOT, 'rulebook');
const OUTPUT_DIR = join(ROOT, 'output');
const DEBUG_DIR = join(ROOT, 'debug');
const UI_FILE = fileURLToPath(new URL('./ui.html', import.meta.url));
const SETTER_FILE = fileURLToPath(new URL('./setter.html', import.meta.url));
const MCP_FILE = fileURLToPath(new URL('./mcp.html', import.meta.url));
const SETTER_DIR = join(OUTPUT_DIR, '_setter');
const MCP_DIR = join(OUTPUT_DIR, '_mcp');
const MAX_BODY = 8 * 1024 * 1024;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

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

/** The Permission Setter's run (one at a time; the UI polls it). */
interface SetterState {
  id: string;
  status: 'running' | 'done' | 'failed';
  apply: boolean;
  lines: string[];
  outcome: SetterOutcome | null;
  controller: AbortController;
  /** Set after a rulebook Apply: lets Pages Testing pick up this run. */
  handoffId?: string;
}
let setter: SetterState | null = null;

/**
 * Permission Setter → Pages Testing handoff: what a finished Apply leaves for the "Verify in Pages
 * Testing" button. Memory only, for HANDOFF_MINUTES. The user jwts in it are never sent back to the
 * page; the Pages wizard only refers to them by handoff id.
 */
interface Handoff {
  id: string;
  expiresAt: number;
  environment: Environment;
  rulebookId: string;
  /** Rulebook columns whose roles were saved (or already matched). */
  columns: string[];
  roles: Record<string, string>;
  setterRunId: string;
  /** Column → that user's jwt, as pasted in the setter. */
  jwts: Map<string, string>;
}
const HANDOFF_MINUTES = 15;
const handoffs = new Map<string, Handoff>();

function getHandoff(id: string | undefined): Handoff | null {
  if (!id) return null;
  const h = handoffs.get(id);
  if (!h) return null;
  if (Date.now() > h.expiresAt) {
    dropHandoff(h.id);
    return null;
  }
  return h;
}

function dropHandoff(id: string): void {
  const h = handoffs.get(id);
  if (!h) return;
  h.jwts.clear();
  handoffs.delete(id);
  log.debug('handoff dropped', { id });
}

interface SetterBody {
  environment?: Environment;
  rulebookId?: string;
  jwt?: string;
  roles?: Record<string, string>;
  /** "Set every slider": one role and a level 0–4, no rulebook. */
  bulk?: { roleName?: string; step?: number };
  apply?: boolean;
  headed?: boolean;
  /** Rulebook column → that user's own jwt: after saving, log in as them and open the rulebook pages. */
  users?: Record<string, string>;
  /** Send results and screenshots to Gemini for a second check. */
  ai?: boolean;
  /** Pause after every step in AMP's role editor, in seconds. */
  stepDelaySec?: number;
  /** Use Navigation Layout for pages role sliders can't hide (default on). */
  navigation?: boolean;
  /** Rulebook column → that column's AMP user (email or name), for Navigation Layout. */
  userHints?: Record<string, string>;
}

/** Column → typed user (email or name), only for the rulebook's columns. */
function userHintsFrom(body: SetterBody, rb: Rulebook): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ut of rb.userTypes) {
    const v = body.userHints?.[ut]?.trim();
    if (v) out[ut] = v.slice(0, 200);
  }
  return out;
}

// ---------------------------------------------------------------- request shapes

interface UserInput {
  key: string;
  label?: string;
  jwt?: string;
  csrf?: string;
  test?: boolean;
  /** Use the jwt this user had in a Permission Setter run (handoff id) instead of a pasted one. */
  handoff?: string;
}

/** The jwt for a user row: pasted, or kept from the Permission Setter handoff. */
function jwtOf(u: UserInput | undefined): string | undefined {
  const pasted = u?.jwt?.trim();
  if (pasted) return pasted;
  if (!u?.handoff) return undefined;
  return getHandoff(u.handoff)?.jwts.get(u.key);
}
interface RunRequest {
  environment: Environment;
  rulebookId: string;
  /** User-type columns the tester confirmed on the rulebook step (default: all detected). */
  selectedUserTypes?: string[];
  users: UserInput[];
  options?: { limit?: number; delayMs?: number; fingerprintThreshold?: number; headed?: boolean; parallelUsers?: number; debugShots?: boolean; pageWaitSec?: number };
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
    const jwt = jwtOf(u);
    if (!jwt) throw new HttpError(400, u?.handoff ? `the jwt kept from the Permission Setter for ${u.label || key} has expired: paste it again` : `jwt missing for ${u?.label || key}`);
    creds.set(key, makeCredentials(jwt, u?.csrf));
  }
  return creds;
}

function configFrom(body: RunRequest, rb: Rulebook): RunConfig {
  // User types and their names come only from the rulebook's column headers.
  const userTypes: Record<string, { label: string }> = {};
  for (const key of rb.userTypes) userTypes[key] = { label: rb.userTypeLabels[key] ?? key };
  const o = body.options ?? {};
  const cfg = buildConfig(
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

  if (method === 'GET' && (path === '/setter' || path === '/setter.html')) {
    return send(res, 200, readFileSync(SETTER_FILE, 'utf8'), 'text/html');
  }

  if (method === 'GET' && (path === '/mcp' || path === '/mcp.html')) {
    return send(res, 200, readFileSync(MCP_FILE, 'utf8'), 'text/html');
  }

  if (method === 'GET' && path.startsWith('/output/')) return serveOutput(path, res);

  if (!path.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

  if (method === 'GET' && path === '/api/rulebooks') {
    const files = existsSync(RULEBOOK_DIR) ? readdirSync(RULEBOOK_DIR).filter((f) => /\.(csv|xlsx)$/i.test(f)) : [];
    return send(res, 200, { files });
  }
  if (method === 'GET' && path === '/api/runs') return send(res, 200, { runs: listRuns() });
  if (method === 'GET' && path === '/api/runs/current') return send(res, 200, { run: publicState(current) });
  if (method === 'GET' && path === '/api/setter/info') {
    // Whether a Gemini key is set for this process (the key itself is never sent to the page).
    return send(res, 200, { aiKey: aiKeySet(), aiModel: aiModel() });
  }
  if (method === 'GET' && path === '/api/setter/runs/current') return send(res, 200, { run: setterState(Number(url.searchParams.get('from') ?? 0)) });
  // MCP Connector Health reads (page data, history) are open like the setter's; its POSTs sit behind assertFromUi below.
  if (method === 'GET' && (path === '/api/mcp/runs/current' || path === '/api/mcp/runs' || /^\/api\/mcp\/runs\/[\w-]+$/.test(path))) {
    return handleMcp(method, path, url, req, res);
  }

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

  const ho = /^\/api\/handoff\/([\w-]+)$/.exec(path);
  if (method === 'GET' && ho) {
    const h = getHandoff(ho[1]);
    if (!h) throw new HttpError(404, 'This hand-off from the Permission Setter has expired. Start the page test from the catalog.');
    const loaded = rulebooks.get(h.rulebookId);
    if (!loaded) throw new HttpError(404, 'The rulebook from the Permission Setter is no longer loaded (was the server restarted?).');
    return send(res, 200, {
      environment: h.environment,
      rulebook: { id: loaded.id, name: loaded.name, summary: rulebookSummary(loaded.rulebook) },
      columns: h.columns,
      roles: h.roles,
      // Which columns have a jwt kept in memory; never the jwt itself.
      jwtFor: [...h.jwts.keys()],
      setterRunId: h.setterRunId,
      expiresAt: new Date(h.expiresAt).toISOString(),
    });
  }

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
    if (bad.length) throw new HttpError(400, `User-type column names are too long (max 40 characters): ${bad.map((b) => rulebook.userTypeLabels[b] ?? b).join(', ')}`);
    const id = randomUUID();
    rulebooks.set(id, { id, name, data, rulebook });
    const summary = rulebookSummary(rulebook);
    log.info('rulebook loaded', { name, source: body.file ? 'saved' : 'upload', bytes: data.length, pages: summary.pages, userTypes: summary.userTypes });
    return send(res, 200, { id, name, summary });
  }

  if (method === 'POST' && path === '/api/tokens/check') {
    const body = (await readBody(req)) as { environment?: Environment; users?: UserInput[] };
    const env = environmentFrom(body);
    const users = (body.users ?? []).filter((u) => u.key && KEY_RE.test(u.key) && jwtOf(u));
    if (!users.length) throw new HttpError(400, 'Paste a jwt for at least one user first');
    const gate = new RequestGate(env, 300, new AuditLog(join(OUTPUT_DIR, '_ui', 'token-checks.jsonl')));
    const results = [];
    for (const u of users) {
      const creds = credsFrom([u], [u.key]);
      const c = creds.get(u.key)!;
      const identity = await validateToken(gate, u.key, c).finally(() => forgetSecrets([c.jwt, c.csrf]));
      results.push({ key: u.key, identity });
      if (identity.valid) log.info('token check ok', { env: env.name, user: u.key, name: identity.userName, persona: identity.persona, siteAdmin: identity.isSiteAdmin, company: identity.companyName, org: identity.organizationName });
      else log.warn('token check failed', { env: env.name, user: u.key, reason: identity.reason });
    }
    // Two rows logged in as the same person: the later row is not usable.
    const labelOf = (key: string) => users.find((x) => x.key === key)?.label || key;
    for (const [dup, first] of duplicateIdentities(results.map((x) => x.identity))) {
      const row = results.find((x) => x.key === dup)!;
      const reason = `same person as ${labelOf(first)} (${row.identity.userName}): paste a jwt from a ${labelOf(dup)} user's own session`;
      row.identity = { ...row.identity, valid: false, reason };
      log.warn('token check: same user on two rows', { env: env.name, user: dup, sameAs: first });
    }
    return send(res, 200, { results });
  }

  if (method === 'POST' && path === '/api/plan') {
    const { cfg, plan, only, notes } = setupFrom((await readBody(req)) as RunRequest);
    return send(res, 200, {
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
    const body = (await readBody(req)) as RunRequest;
    const { loaded, rulebook, cfg, only, plan, notes } = setupFrom(body);
    const creds = credsFrom(body.users ?? [], plan.allTypes);
    startRun(cfg, loaded, rulebook, creds, only, notes, body.options?.limit);
    return send(res, 202, { run: publicState(current) });
  }

  if (method === 'POST' && path.startsWith('/api/setter/')) return handleSetter(path, (await readBody(req)) as SetterBody, res);

  if (path.startsWith('/api/mcp/')) return handleMcp(method, path, url, req, res);

  const cancel = /^\/api\/runs\/([\w-]+)\/cancel$/.exec(path);
  if (method === 'POST' && cancel) {
    if (!current || current.id !== cancel[1] || current.status !== 'running') throw new HttpError(404, 'No such active run');
    current.controller.abort();
    log.info('cancel requested', { run: current.id });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------- permission setter

function setterState(from = 0) {
  if (!setter) return null;
  const o = setter.outcome;
  return {
    id: setter.id,
    status: setter.status,
    apply: setter.apply,
    lines: setter.lines.slice(Math.max(0, from)),
    lineCount: setter.lines.length,
    outcome: o && {
      error: o.error ?? null,
      roles: o.roles.map((r) => ({
        label: r.label,
        roleName: r.roleName,
        status: r.status,
        error: r.error ?? null,
        changed: r.controls.filter((c) => c.changed).length,
        userCheck: r.userCheck ? { pass: r.userCheck.pages.filter((p) => p.verdict === 'PASS').length, total: r.userCheck.pages.length } : null,
        ai: r.ai ? r.ai.verdict : r.aiError ? `error: ${r.aiError}` : null,
      })),
      reportUrl: o.reportFile ? `/output/_setter/${setter.id}/report.html` : null,
      verifyReportUrl: o.verify?.reportUrl ?? null,
      handoffId: setter.handoffId && getHandoff(setter.handoffId) ? setter.handoffId : null,
      handoffMinutes: HANDOFF_MINUTES,
    },
  };
}

/** Rulebook columns → role names, only for columns the rulebook has. */
function setterRoles(body: SetterBody, rb: Rulebook): Record<string, string> {
  const roles: Record<string, string> = {};
  for (const ut of rb.userTypes) {
    const name = body.roles?.[ut]?.trim();
    if (name) roles[ut] = name.slice(0, 200);
  }
  if (!Object.keys(roles).length) throw new HttpError(400, 'Enter the AMP role to set for at least one rulebook column');
  return roles;
}

async function handleSetter(path: string, body: SetterBody, res: ServerResponse): Promise<void> {
  const env = environmentFrom(body);
  if (!body.jwt?.trim()) throw new HttpError(400, "Paste the Super Admin's jwt first");
  const creds = makeCredentials(body.jwt);
  const forget = () => forgetSecrets([creds.jwt, creds.csrf]);

  if (path === '/api/setter/check' || path === '/api/setter/plan') {
    try {
      const gate = new RequestGate(env, 300, new AuditLog(join(OUTPUT_DIR, '_ui', 'setter-checks.jsonl')));
      const admin = await checkSuperAdmin(gate, creds);
      if (path === '/api/setter/check') {
        log.info('setter token check', { env: env.name, name: admin.identity.userName, admin: admin.isAdmin, modules: admin.modules.length });
        return send(res, 200, { identity: admin.identity, isAdmin: admin.isAdmin, reason: admin.reason ?? null, modules: admin.modules.length });
      }
      if (!admin.isAdmin) throw new HttpError(400, admin.reason ?? 'not a Super Admin');
      const rb = getRulebook(body.rulebookId ?? '').rulebook;
      const plans = planAll(rb, setterRoles(body, rb), admin.modules);
      let navigation: unknown = null;
      if (body.navigation !== false) {
        const userCreds = new Map<string, Credentials>();
        for (const ut of Object.keys(body.users ?? {})) if (body.users![ut]?.trim()) userCreds.set(ut, makeCredentials(body.users![ut]!));
        try {
          navigation = await prepareNavigation({ gate, creds, rulebook: rb, plans, modules: admin.modules, hints: userHintsFrom(body, rb), userCreds });
        } catch (e) {
          navigation = { nav: [], columnUsers: [], error: scrub((e as Error).message) };
        } finally {
          forgetSecrets([...userCreds.values()].flatMap((c) => [c.jwt, c.csrf]));
        }
      }
      return send(res, 200, { plans, levels: LEVELS, navigation });
    } finally {
      forget();
    }
  }

  if (path === '/api/setter/runs') {
    const userCreds = new Map<string, Credentials>();
    const forgetAll = () => {
      forget();
      forgetSecrets([...userCreds.values()].flatMap((c) => [c.jwt, c.csrf]));
    };
    let loaded: LoadedRulebook | null = null;
    let roles: Record<string, string> = {};
    let bulk: { roleName: string; step: 0 | 1 | 2 | 3 | 4 } | undefined;
    try {
      if (setter?.status === 'running') throw new HttpError(409, 'A permission run is already in progress');
      if (body.bulk) {
        const roleName = body.bulk.roleName?.trim().slice(0, 200);
        const step = Number(body.bulk.step);
        if (!roleName) throw new HttpError(400, 'Enter the AMP role name');
        if (![0, 1, 2, 3, 4].includes(step)) throw new HttpError(400, 'Choose a level');
        bulk = { roleName, step: step as 0 | 1 | 2 | 3 | 4 };
      } else {
        loaded = getRulebook(body.rulebookId ?? '');
        roles = setterRoles(body, loaded.rulebook);
        for (const ut of Object.keys(roles)) {
          const jwt = body.users?.[ut]?.trim();
          if (!jwt) continue;
          const c = makeCredentials(jwt);
          if (c.jwt === creds.jwt) throw new HttpError(400, `The ${loaded.rulebook.userTypeLabels[ut] ?? ut} jwt is the Super Admin's: paste that user's own jwt (or leave it empty)`);
          userCreds.set(ut, c);
        }
      }
    } catch (e) {
      forgetAll();
      throw e;
    }
    const apply = body.apply === true;
    const id = newSetterRunId(env.name);
    const state: SetterState = { id, status: 'running', apply, lines: [], outcome: null, controller: new AbortController() };
    setter = state;
    log.info('setter run started', { run: id, env: env.name, apply, roles: bulk ? 1 : Object.keys(roles).length, bulk: bulk ? LEVELS[bulk.step] : undefined, verifyUsers: userCreds.size, ai: body.ai === true });
    void executeSetter(
      {
        environment: env,
        rulebook: loaded?.rulebook ?? null,
        rulebookName: loaded?.name ?? '(none: every slider)',
        roles,
        bulk,
        creds,
        apply,
        headless: body.headed !== true,
        stepDelayMs: body.stepDelaySec !== undefined ? clamp(body.stepDelaySec, 0.5, 10) * 1000 : undefined,
        verify: userCreds.size && loaded ? { creds: userCreds, outputDir: OUTPUT_DIR, debugDir: DEBUG_DIR, rulebookSource: { name: loaded.name, data: loaded.data }, waitSec: 5 } : undefined,
        ai: body.ai === true,
        navigation: loaded && body.navigation !== false ? { enabled: true, hints: userHintsFrom(body, loaded.rulebook) } : undefined,
        outputRoot: SETTER_DIR,
        signal: state.controller.signal,
        log: (line) => {
          for (const l of scrub(line).split('\n')) state.lines.push(l);
        },
      },
      id,
    )
      .catch((e: unknown): SetterOutcome => ({ runId: id, outDir: join(SETTER_DIR, id), apply, roles: [], error: scrub((e as Error).message) }))
      .then((outcome) => {
        // Rulebook Apply: leave a hand-off for "Verify in Pages Testing" (columns whose role was saved or already matched).
        const columns = outcome.roles.filter((r) => r.status === 'saved' || r.status === 'no_changes').map((r) => r.userType);
        if (apply && loaded && columns.length) {
          const hid = randomUUID();
          const jwts = new Map<string, string>();
          for (const c of columns) {
            const u = userCreds.get(c);
            if (u) jwts.set(c, u.jwt);
          }
          handoffs.set(hid, { id: hid, expiresAt: Date.now() + HANDOFF_MINUTES * 60_000, environment: env, rulebookId: loaded.id, columns, roles, setterRunId: id, jwts });
          setTimeout(() => dropHandoff(hid), HANDOFF_MINUTES * 60_000).unref();
          state.handoffId = hid;
          log.info('handoff ready for Pages Testing', { run: id, columns: columns.length, jwts: jwts.size, minutes: HANDOFF_MINUTES });
        }
        forgetAll();
        userCreds.clear();
        state.outcome = outcome;
        state.status = outcome.error || outcome.roles.some((r) => r.status === 'failed') ? 'failed' : 'done';
        log.info('setter run finished', { run: id, status: state.status, error: outcome.error });
      });
    return send(res, 202, { run: setterState() });
  }

  forget();
  throw new HttpError(404, 'Not found');
}

// ---------------------------------------------------------------- MCP connector health

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
let mcp: McpRunState | null = null;

interface McpUserBody {
  key?: string;
  jwt?: string;
}

function mcpSetup(body: { environment?: Environment; users?: McpUserBody[] }): { env: Environment; users: { key: string; jwt: string }[] } {
  const env = environmentFrom({ environment: body.environment });
  const users = (body.users ?? [])
    .filter((u) => u.key && KEY_RE.test(u.key) && u.jwt?.trim())
    .map((u) => ({ key: u.key!, jwt: u.jwt!.trim() }));
  if (!users.length) throw new HttpError(400, 'Paste a jwt for at least one account first (keys use letters, digits and _ only, max 40)');
  return { env, users };
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
function mcpSummaryCounts(result: McpResult): { fix: number; reconnect: number; cantCheck: number; working: number } {
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
function mcpHistory(): { id: string; host: string | null; startedAt: string; accounts: string[]; summary: { fix: number; reconnect: number; cantCheck: number; working: number } }[] {
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

async function handleMcp(method: string, path: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (method === 'GET' && path === '/api/mcp/runs/current') {
    const from = Number(url.searchParams.get('from') ?? 0);
    return send(res, 200, { run: mcpPublic(mcp, Number.isFinite(from) ? from : 0) });
  }
  if (method === 'GET' && path === '/api/mcp/runs') return send(res, 200, { runs: mcpHistory() });

  const one = /^\/api\/mcp\/runs\/([\w-]+)$/.exec(path);
  if (method === 'GET' && one) {
    const dir = join(MCP_DIR, one[1]!);
    const file = join(dir, 'result.json');
    if (!resolve(file).startsWith(MCP_DIR + sep) || !existsSync(file)) throw new HttpError(404, 'No such MCP run');
    return send(res, 200, { result: JSON.parse(readFileSync(file, 'utf8')) });
  }

  if (method === 'POST' && path === '/api/mcp/check') {
    const { env, users } = mcpSetup((await readBody(req)) as { environment?: Environment; users?: McpUserBody[] });
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
    return send(res, 200, { users: out });
  }

  if (method === 'POST' && path === '/api/mcp/plan') {
    const { env, users } = mcpSetup((await readBody(req)) as { environment?: Environment; users?: McpUserBody[] });
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
      return send(res, 200, {
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
    const body = (await readBody(req)) as { environment?: Environment; users?: McpUserBody[]; ai?: boolean };
    const { env, users } = mcpSetup(body);
    const aiRequested = body.ai === true;
    if (aiRequested && !aiAvailable()) {
      throw new HttpError(400, 'AI review needs a Gemini key: set GEMINI_API_KEY and restart the server, or run without AI review.');
    }
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
    mcp = state;
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
    return send(res, 202, { run: mcpPublic(state) });
  }

  const cancel = /^\/api\/mcp\/runs\/([\w-]+)\/cancel$/.exec(path);
  if (method === 'POST' && cancel) {
    if (!mcp || mcp.id !== cancel[1] || mcp.status !== 'running') throw new HttpError(404, 'No such active MCP run');
    mcp.controller.abort();
    log.info('mcp cancel requested', { run: mcp.id });
    return send(res, 200, { run: mcpPublic(mcp) });
  }

  throw new HttpError(404, 'Not found');
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

  // Security headers on everything we serve (tool page and reports).
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );

  // DNS-rebinding guard: a website that points its own domain at 127.0.0.1 would arrive with its
  // own Host header. Only answer requests addressed to this server by its local name.
  if (!ALLOWED_HOSTS.has((req.headers.host ?? '').toLowerCase())) {
    failure = { message: `unexpected Host header "${req.headers.host ?? ''}"` };
    return send(res, 403, { error: 'Forbidden' });
  }

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
