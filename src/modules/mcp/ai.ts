/**
 * MCP Connector Health (P11): AI triage of results we already have.
 * READ-ONLY explanations only. The AI never approves or triggers anything
 * (it is not told it can call tools), and no live tool-call path exists.
 *
 * DATA RULE (user-approved, fixed): to Gemini goes ONLY the fields assembled
 * by buildTriageItems below — connector name, numeric id, our state as plain
 * words, scrubbed AMP error text (<= 400 chars), HTTP status, tool NAMES and
 * tool input-schema field names/types, and for TOOL_MISSING nodes the workflow
 * name + wanted tool + the server's tool names. NEVER: any jwt/key/header,
 * URL query strings, tool-call return values, other workflow names, connector
 * URLs (hosts only if already inside the error text), user/company names.
 * Key handling, model env and error mapping are shared in src/core/ai/gemini.ts.
 */
import type { GoogleGenAI } from '@google/genai';
import { aiErrorMessage, aiKeySet, aiModel, newAiClient } from '../../core/ai/gemini';
import { scrub } from '../../core/util/mask';
import { createLogger } from '../../core/util/logger';
import { bucketRank } from './classify';
import type { McpBucket, McpNodeRow, McpResult, McpServerRow } from './types';

const log = createLogger('mcp-ai');

/** Max items per Gemini call. */
export const TRIAGE_BATCH = 20;
/** Max items triaged per run; Fix-needed (BROKEN) items go first. */
export const TRIAGE_CAP = 60;
/** Per-call timeout; a timeout becomes one plain message, never a broken run. */
export const TRIAGE_TIMEOUT_MS = 60000;
const ERROR_MAX = 400;
const NAME_MAX = 200;

export function aiAvailable(): boolean {
  return aiKeySet();
}

/** Model name for display/logs. The key itself is never exposed. */
export function aiModelName(): string {
  return aiModel();
}

export interface TriageNote {
  /** Server row id ("server:<n>") or node key. Matches TriageItem.key. */
  id: string;
  diagnosis: string;
  nextStep: string;
  confidence: 'high' | 'medium' | 'low';
}

/** How many problems got an AI note (additive on the result; absent when AI was off). */
export interface AiCoverage {
  noted: number;
  eligible: number;
  cap: number;
}

export function aiCoverageOf(eligible: number, noted: number, cap: number = TRIAGE_CAP): AiCoverage {
  return { noted, eligible, cap };
}

/** Plain-words coverage line for the page, tickets and CSV. Empty when AI was off. */
export function aiCoverageLine(cov: AiCoverage | undefined | null): string {
  if (!cov) return '';
  if (cov.eligible <= 0) return 'AI review ran: nothing needed a note.';
  if (cov.noted >= cov.eligible) return `AI wrote notes for all ${cov.eligible} problem${cov.eligible === 1 ? '' : 's'}.`;
  return `AI wrote notes for ${cov.noted} of ${cov.eligible} problems. The rest were not sent (limit ${cov.cap} per run, worst first).`;
}

export interface TriageToolFields {
  name: string;
  fields: { name: string; type: string }[];
}

export interface TriageItem {
  key: string;
  kind: 'server' | 'node';
  bucket: McpBucket;
  name: string;
  serverId?: number;
  stateWords: string;
  httpStatus?: number;
  errorText?: string;
  toolNames?: string[];
  toolFields?: TriageToolFields[];
  node?: { workflow: string; wantedTool: string; serverToolNames: string[] };
}

const GROUP_WORDS: Record<McpBucket, string> = {
  BROKEN: 'Fix needed',
  MAYBE: 'Reconnect, then recheck',
  NEEDS_YOU: "Can't check with this account",
  HEALTHY: 'Working',
};

const REASON_WORDS: Record<string, string> = {
  KEY_REJECTED: 'API key rejected',
  DEAD_HOST: 'Server address no longer exists',
  URL_404: 'Address not found (404)',
  REDIRECT: 'Address redirects elsewhere',
  HTML_NOT_MCP: 'Address is a web page, not an MCP server',
  UNREACHABLE: 'Server not responding',
  UNKNOWN_ERROR: 'Unrecognised error',
  NO_TOOLS: 'Connected but offers no tools',
  OAUTH_EXPIRED: 'Login expired or refused',
  FORBIDDEN: 'Login lacks permission',
  RATE_LIMITED: 'Too many requests, retry later',
  API_ERROR: 'AMP call failed',
  MISCONFIGURED: 'Connector is misconfigured',
  SERVICE_ACCOUNT_REFUSED: 'Service account refused',
  NOT_CONNECTED: "You haven't connected this one",
  NOT_VISIBLE: "This account can't see this connector",
  OK: 'Connected, tools came back',
  NOT_CHECKED: 'Connector picked at run time, not checked',
};

function reasonWords(state: string): string {
  if (state.startsWith('TOOL_MISSING')) return "Workflow calls a tool this connector doesn't have";
  if (state.startsWith('SERVER_')) return `Its connector: ${(REASON_WORDS[state.slice(7)] ?? 'not checked').toLowerCase()}`;
  return REASON_WORDS[state] ?? 'Not checked';
}

function stateWordsFor(bucket: McpBucket, state: string): string {
  return `${GROUP_WORDS[bucket]} — ${reasonWords(state)}`;
}

/**
 * Removes everything the DATA RULE forbids, before a value enters the prompt:
 * registered secrets (jwt), emails, URL query strings, header-shaped secret
 * lines (api keys, bearer tokens), long opaque blobs. Truncates to max.
 */
export function sanitizeForPrompt(value: string, max: number): string {
  let out = scrub(value);
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  out = out.replace(/\?[^\s"'<>]*/g, '');
  // Header-shaped secret lines (api keys, bearer tokens, passwords): matched
  // anywhere, not just at line start, since error text is flattened to one line.
  out = out.replace(/(x-api-key|api[_-]?key|authorization|bearer|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*\S+/gi, '$1: [key]');
  out = out.replace(/(?<![A-Za-z0-9-_])[A-Za-z0-9-_]{32,}(?![A-Za-z0-9-_])/g, '[key]');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/**
 * The non-working items worth triaging: every non-healthy server plus the
 * TOOL_MISSING nodes (their wanted-vs-have mismatch is new information;
 * SERVER_* nodes repeat their server's verdict and are skipped).
 */
export function buildTriageItems(result: McpResult): TriageItem[] {
  const items: TriageItem[] = [];
  for (const key of result.order) {
    if (key === 'combined') continue;
    const acc = result.accounts[key];
    if (!acc) continue;
    for (const s of acc.servers) {
      if (s.bucket === 'HEALTHY') continue;
      items.push({
        key: `server:${s.id}`,
        kind: 'server',
        bucket: s.bucket,
        name: s.name,
        serverId: s.id,
        stateWords: stateWordsFor(s.bucket, s.state),
        httpStatus: s.httpStatus,
        errorText: s.detail,
        toolNames: s.toolNames,
        toolFields: s.toolSchemas,
      });
    }
    const byServer = new Map(acc.servers.map((s) => [s.id, s]));
    for (const n of acc.nodes) {
      if (!n.state.startsWith('TOOL_MISSING')) continue;
      const serverRow = typeof n.server === 'number' ? byServer.get(n.server) : undefined;
      items.push({
        key: `node:${n.workflow}/${n.server}/${n.tool}`,
        kind: 'node',
        bucket: n.bucket,
        name: `${n.workflow} / ${n.tool}`,
        serverId: typeof n.server === 'number' ? n.server : undefined,
        stateWords: stateWordsFor(n.bucket, n.state),
        node: {
          workflow: n.workflow,
          wantedTool: n.tool,
          serverToolNames: serverRow?.toolNames ?? [],
        },
      });
    }
  }
  return items;
}

/**
 * Builds the EXACT prompt string (one function, unit-tested). Only DATA-RULE
 * fields enter, every value sanitized; the model is told to use only the
 * given facts, to say "not enough information" rather than guess, and that it
 * cannot call tools. It must return JSON only: no instructions, no links.
 */
export function buildTriagePrompt(items: TriageItem[]): string {
  const lines = [
    'You triage MCP connector health-check results. Use ONLY the facts given below.',
    'If the facts do not let you decide, say "not enough information" rather than guess.',
    'You cannot call tools or take any action: only write the requested notes.',
    'Do not include instructions, links, or anything not asked for.',
    '',
    'One item per block. "status" is our verdict in plain words. "AMP said" is the',
    'exact error text from the connector. "tools" are the tool names that came back;',
    '"tool fields" are input-schema field names and types (never values).',
    '',
    '<items>',
  ];
  for (const it of items) {
    const name = sanitizeForPrompt(it.name, NAME_MAX);
    lines.push(`- id: ${it.key}`);
    if (it.kind === 'server') {
      lines.push(`  connector: "${name}" (#${it.serverId ?? '?'})`);
      lines.push(`  status: ${sanitizeForPrompt(it.stateWords, NAME_MAX)}${it.httpStatus ? ` (HTTP ${it.httpStatus})` : ''}`);
      if (it.errorText) lines.push(`  AMP said: "${sanitizeForPrompt(it.errorText, ERROR_MAX)}"`);
      const tools = (it.toolNames ?? []).slice(0, 40);
      lines.push(tools.length ? `  tools (${tools.length}): ${tools.map((t) => sanitizeForPrompt(t, 80)).join(', ')}` : '  tools (0): none came back');
      for (const tf of (it.toolFields ?? []).slice(0, 40)) {
        const fields = tf.fields.slice(0, 30).map((f) => `${sanitizeForPrompt(f.name, 60)}: ${sanitizeForPrompt(f.type, 40)}`);
        if (fields.length) lines.push(`  tool fields: ${sanitizeForPrompt(tf.name, 80)}(${fields.join(', ')})`);
      }
    } else {
      lines.push(`  workflow node: "${name}"`);
      lines.push(`  status: ${sanitizeForPrompt(it.stateWords, NAME_MAX)}`);
      lines.push(`  workflow: "${sanitizeForPrompt(it.node?.workflow ?? '', NAME_MAX)}"`);
      lines.push(`  wanted tool: "${sanitizeForPrompt(it.node?.wantedTool ?? '', 80)}"`);
      const have = (it.node?.serverToolNames ?? []).slice(0, 40);
      lines.push(have.length ? `  server has: ${have.map((t) => sanitizeForPrompt(t, 80)).join(', ')}` : '  server has: no tools');
    }
  }
  lines.push(
    '</items>',
    '',
    'Return ONLY a JSON array, no code fences, one entry per item you can judge:',
    '[{"id":"...","diagnosis":"one or two plain sentences","nextStep":"one sentence","confidence":"high|medium|low"}]',
    'Skip items you cannot judge. Plain words only.',
  );
  return lines.join('\n');
}

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((ok, fail) => {
    // Cancel must not wait for Gemini: settle at once when the caller aborts.
    if (signal) {
      if (signal.aborted) return fail(new Error('cancelled'));
      signal.addEventListener('abort', () => { if (timer) clearTimeout(timer); fail(new Error('cancelled')); }, { once: true });
    }
    timer = setTimeout(() => fail(new Error(`Gemini call timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        if (timer) clearTimeout(timer);
        ok(v);
      },
      (e) => {
        if (timer) clearTimeout(timer);
        fail(e);
      },
    );
  });
}

function parseNotes(text: string): TriageNote[] {
  const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(clean.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: TriageNote[] = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.diagnosis !== 'string' || typeof r.nextStep !== 'string') continue;
    if (r.confidence !== 'high' && r.confidence !== 'medium' && r.confidence !== 'low') continue;
    out.push({
      id: r.id.slice(0, 200),
      diagnosis: r.diagnosis.slice(0, 500),
      nextStep: r.nextStep.slice(0, 500),
      confidence: r.confidence,
    });
  }
  return out;
}

export interface TriageOutcome {
  notes: TriageNote[];
  /** Set when some or all batches failed: one plain message, never a throw. */
  error?: string;
  /** True when the caller's abort signal fired; notes gathered so far are returned but the caller should treat the run as cancelled. */
  cancelled?: boolean;
}

/**
 * Triages items through Gemini: Fix-needed first, at most `cap` items in
 * batches of `TRIAGE_BATCH`. A failed batch is skipped (other batches still
 * run); when nothing usable comes back the outcome carries one plain message.
 * Never throws for API/parse/timeout failures. Uses a stubbed client in tests.
 */
export async function triage(
  items: TriageItem[],
  client: GoogleGenAI = newAiClient(),
  opts: { cap?: number; timeoutMs?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<TriageOutcome> {
  if (!items.length) return { notes: [] };
  const signal = opts.signal;
  if (signal?.aborted) return { notes: [], cancelled: true };
  const cap = opts.cap ?? TRIAGE_CAP;
  const timeoutMs = opts.timeoutMs ?? TRIAGE_TIMEOUT_MS;
  const picked = [...items].sort((a, b) => bucketRank(a.bucket) - bucketRank(b.bucket)).slice(0, Math.max(0, cap));
  if (!picked.length) return { notes: [] };
  const model = aiModel();
  const notes: TriageNote[] = [];
  let failed = 0;
  let lastError = '';
  const batches = Math.ceil(picked.length / TRIAGE_BATCH);
  opts.onProgress?.(0, batches);
  for (let i = 0; i < picked.length; i += TRIAGE_BATCH) {
    if (signal?.aborted) return { notes, cancelled: true };
    const batch = picked.slice(i, i + TRIAGE_BATCH);
    try {
      const response = await withTimeout(
        client.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: buildTriagePrompt(batch) }] }],
          config: { temperature: 0, responseMimeType: 'application/json', ...(signal ? { abortSignal: signal } : {}) },
        }),
        timeoutMs,
        signal,
      );
      const text = response.text;
      if (!text) throw new Error('Gemini returned no answer');
      const parsed = parseNotes(text);
      if (!parsed.length) throw new Error('Gemini returned no usable notes');
      const wanted = new Set(batch.map((b) => b.key));
      for (const n of parsed) if (wanted.has(n.id)) notes.push(n);
    } catch (e) {
      if (signal?.aborted) return { notes, cancelled: true };
      failed += 1;
      lastError = aiErrorMessage(e);
      log.warn('triage batch failed', { batch: `${i / TRIAGE_BATCH + 1}`, error: lastError });
    }
    opts.onProgress?.(Math.floor(i / TRIAGE_BATCH) + 1, batches);
  }
  log.info('triage done', { items: picked.length, noted: notes.length, failed, model });
  if (!notes.length) return { notes, error: lastError || 'the AI triage did not return usable notes.' };
  return notes.length < picked.length || failed > 0 ? { notes, error: lastError } : { notes };
}

export type { McpNodeRow, McpServerRow };
