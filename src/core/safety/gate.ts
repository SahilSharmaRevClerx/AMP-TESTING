import type { AuditLog } from '../util/audit';
import type { Credentials, Environment } from '../types';
import { createLogger, since } from '../util/logger';

const log = createLogger('gate');

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyError';
  }
}

/**
 * The only AMP APIs the tool itself may call directly (all read-only). The Navigation Layout module
 * list is used by the Permission Setter: only Site/Super Admins may call it. The getmcpservers /
 * getmcpservertools pair is used by the MCP Connector Health module (P08, Phase 0, read-only):
 * listing servers this user can see, then asking AMP to connect live and list each server's tools.
 * NOTE (P08 T1 pending): the live route proof (notes/repro-muse/mcp-route-proof.ts) has not been
 * run by the user yet. These names are allow-listed for POST /services/api.ashx?func= only. If the
 * proof shows AMP does not serve them via api.ashx, a follow-up packet may add a narrow rule for
 * POST /api/<these two names>; nothing else is loosened here.
 */
export const TOOL_API_ALLOWLIST = new Set(['getpermissiondataforuser', 'getmodulesfornavigationlayout', 'getmodulesettingdata', 'getmcpservers', 'getmcpservertools']);

/** The one POST /api/<FuncName> path the tool itself may call (P14 workflow-kind labels, read-only). */
const WORKFLOW_LIST_PATH = /^\/api\/GetAIAutomationWorkflows$/i;

/**
 * Body fields the workflow-list read may send. type + the four tab flags are
 * required (the server reads omitted flags as false, so the reader always
 * sends them); grid paging/sort keys are optional; the rest is the UI's own
 * envelope, read by GetJsonGridOptions or ignored. Anything else is refused.
 */
const WORKFLOW_LIST_BODY_KEYS = new Set([
  'type', 'ispublished', 'ispublic', 'hascategory', 'isagentic',
  'page', 'pagesize', 'sort', 'ascending', 'search', 'filters', 'condition', 'format',
  'startdate', 'enddate', 'folder',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Shape check for POST /api/GetAIAutomationWorkflows bodies. Returns null
 * when the body is the narrow read the MCP module needs, else a reason.
 * Called by RequestGate.fetch before sending (see checkToolRequest for the
 * path half); unit-tested directly in tests/gate.test.ts.
 */
export function checkWorkflowListBody(body: unknown): string | null {
  if (!isRecord(body)) return 'workflow list body must be an object';
  for (const k of Object.keys(body)) {
    if (!WORKFLOW_LIST_BODY_KEYS.has(k.toLowerCase())) return `workflow list body has unexpected field ${k.slice(0, 40)}`;
  }
  if (typeof body.type !== 'string' || body.type.toLowerCase() !== 'definitions') return 'workflow list type must be "definitions"';
  for (const f of ['isPublished', 'isPublic', 'hasCategory', 'isAgentic']) {
    if (typeof (body as Record<string, unknown>)[f] !== 'boolean') return `workflow list field ${f} must be a boolean`;
  }
  const num = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isFinite(v));
  if (!num(body.page) || !num(body.Page) || !num(body.pageSize) || !num(body.PageSize)) return 'workflow list paging must be numeric';
  const ps = [body.pageSize, body.PageSize].filter((v): v is number => typeof v === 'number');
  if (ps.some((v) => v < 1 || v > 1000)) return 'workflow list pageSize must be within 1..1000';
  if (body.sort !== undefined && typeof body.sort !== 'string') return 'workflow list sort must be a string';
  if (body.ascending !== undefined && typeof body.ascending !== 'boolean') return 'workflow list ascending must be a boolean';
  if (body.search !== undefined && typeof body.search !== 'string') return 'workflow list search must be a string';
  if (body.filters !== undefined && !Array.isArray(body.filters)) return 'workflow list filters must be an array';
  if (body.condition !== undefined && typeof body.condition !== 'boolean') return 'workflow list condition must be a boolean';
  if (body.format !== undefined && typeof body.format !== 'number') return 'workflow list format must be numeric';
  return null;
}

/** API name prefixes that only read data. Anything else is treated as a write. */
const READ_PREFIX = /^(get|load|check|has|is|can|search|find|fetch|list|count|view|lookup|preview|verify)/;
/** Read-looking names that also write, e.g. getoraddfilter, getandsavetwiliocallrecord. */
const HIDDEN_WRITE = /(oradd|andsave|orsave|andupdate|orupdate|anddelete|andcreate|orcreate|andsend|andset)/;
/** Never let the browser end the session or leave via logout. */
const LOGOUT = /(logout|logoff|signout)/i;

export function isReadOnlyApiFunc(func: string): boolean {
  const f = func.trim().toLowerCase();
  return f.length > 0 && READ_PREFIX.test(f) && !HIDDEN_WRITE.test(f);
}

/** Deployed AMP pages call APIs as POST /api/<FuncName> (e.g. /api/GetProfileDetails). */
const API_PATH = /^\/api\/([A-Za-z0-9_]+)\/?$/;

/**
 * API names from an AMP API URL: /api/<FuncName>, or /services/api.ashx?func=a,b
 * (the server joins repeated "func" params with commas).
 */
export function apiFuncsFromUrl(url: URL): string[] {
  const m = API_PATH.exec(url.pathname);
  if (m) return [m[1]!.toLowerCase()];
  return url.searchParams
    .getAll('func')
    .flatMap((v) => v.split(','))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

export function isApiEndpoint(url: URL): boolean {
  return url.pathname.toLowerCase() === '/services/api.ashx' || API_PATH.test(url.pathname);
}

export interface Decision {
  allowed: boolean;
  reason: string;
}

/**
 * Policy for requests the AMP page makes by itself while loading in the browser.
 * GETs load the page (allowed). POSTs are only allowed to api.ashx for read-only APIs.
 * Everything else (writes, uploads, logout, non-GET to other hosts) is blocked.
 */
export function decideBrowserRequest(method: string, rawUrl: string, baseHost: string): Decision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'unparseable url' };
  }
  if (LOGOUT.test(url.pathname) || LOGOUT.test(url.search)) return { allowed: false, reason: 'logout' };

  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return { allowed: true, reason: 'read method' };

  if (url.host.toLowerCase() !== baseHost) return { allowed: false, reason: `non-GET to external host ${url.host}` };

  if (isApiEndpoint(url)) {
    const funcs = apiFuncsFromUrl(url);
    if (funcs.length === 0) return { allowed: false, reason: 'api call without func' };
    const writes = funcs.filter((f) => !isReadOnlyApiFunc(f));
    if (writes.length > 0) return { allowed: false, reason: `write api: ${writes.join(',')}` };
    return { allowed: true, reason: 'read-only api' };
  }
  return { allowed: false, reason: `${m} to non-api endpoint ${url.pathname}` };
}

/** Refuses production unless explicitly overridden. */
export function assertSafeEnvironment(env: Environment): void {
  if (env.isProduction && !env.allowProduction) {
    throw new SafetyError(
      `Environment "${env.name}" is marked as production. Set "allowProduction": true only if you are sure.`,
    );
  }
  const u = new URL(env.baseUrl);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new SafetyError(`Refusing non-HTTPS base URL for a remote host: ${env.baseUrl}`);
  }
}

export function cookieHeader(creds: Credentials): string {
  return `jwt=${creds.jwt}; X-CSRF-Token=${creds.csrf}`;
}

/**
 * The single gate for requests the tool itself makes (token check, menu read).
 * Enforces: base host only, GET for pages, POST only to allow-listed APIs, throttling, audit.
 */
export class RequestGate {
  private readonly base: URL;
  private lastRequestAt = 0;

  constructor(
    env: Environment,
    private readonly delayMs: number,
    private readonly audit: AuditLog,
  ) {
    assertSafeEnvironment(env);
    this.base = new URL(env.baseUrl);
  }

  get baseHost(): string {
    return this.base.host.toLowerCase();
  }

  get baseUrl(): string {
    return this.base.origin;
  }

  resolve(path: string): URL {
    return new URL(path, this.base.origin);
  }

  async fetch(
    userType: string,
    method: 'GET' | 'POST',
    url: URL,
    creds: Credentials,
    body?: unknown,
  ): Promise<Response> {
    const reason = this.checkToolRequest(method, url);
    if (reason) {
      this.audit.write({ source: 'tool', userType, method, url: url.href, decision: 'blocked', reason });
      log.warn('tool request blocked', { user: userType, method, path: url.pathname + url.search, reason });
      throw new SafetyError(`Blocked ${method} ${url.href}: ${reason}`);
    }
    if (method === 'POST' && WORKFLOW_LIST_PATH.test(url.pathname)) {
      const bodyReason = checkWorkflowListBody(body);
      if (bodyReason) {
        this.audit.write({ source: 'tool', userType, method, url: url.href, decision: 'blocked', reason: bodyReason });
        log.warn('tool request blocked', { user: userType, method, path: url.pathname + url.search, reason: bodyReason });
        throw new SafetyError(`Blocked ${method} ${url.href}: ${bodyReason}`);
      }
    }
    const started = Date.now();

    const wait = this.lastRequestAt + this.delayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();

    const headers: Record<string, string> = {
      Cookie: cookieHeader(creds),
      'X-CSRF-Token': creds.csrf,
      'User-Agent': 'amp-permission-testing/0.1',
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        redirect: 'manual',
      });
    } catch (e) {
      log.warn('tool request failed', { user: userType, method, path: url.pathname + url.search, ms: since(started), error: (e as Error).message });
      throw e;
    }
    this.audit.write({ source: 'tool', userType, method, url: url.href, decision: 'allowed', status: res.status });
    log.debug('tool request', {
      user: userType,
      method,
      path: url.pathname + url.search,
      status: res.status,
      location: res.headers.get('location') ?? undefined,
      ms: since(started),
    });
    return res;
  }

  /** Returns a reason string if the request is not allowed, otherwise null. */
  checkToolRequest(method: string, url: URL): string | null {
    if (url.host.toLowerCase() !== this.baseHost) return `host ${url.host} is not the configured environment`;
    if (method === 'GET') {
      if (isApiEndpoint(url)) return 'GET to api endpoint is not used by the tool';
      if (LOGOUT.test(url.pathname)) return 'logout';
      return null;
    }
    if (method === 'POST') {
      if (url.pathname.toLowerCase() !== '/services/api.ashx') {
        // The single narrow exception: the read-only workflow-list POST the MCP
        // module's workflow-kind labels need (P14). The body shape is checked in
        // fetch(); a write-like name never matches this path.
        if (WORKFLOW_LIST_PATH.test(url.pathname)) return null;
        return 'POST only allowed to /services/api.ashx';
      }
      const funcs = apiFuncsFromUrl(url);
      if (funcs.length !== 1 || !TOOL_API_ALLOWLIST.has(funcs[0]!)) return `api ${funcs.join(',')} is not allow-listed`;
      return null;
    }
    return `method ${method} not allowed`;
  }
}
