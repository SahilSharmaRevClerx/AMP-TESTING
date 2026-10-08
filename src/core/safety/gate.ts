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
      if (url.pathname.toLowerCase() !== '/services/api.ashx') return 'POST only allowed to /services/api.ashx';
      const funcs = apiFuncsFromUrl(url);
      if (funcs.length !== 1 || !TOOL_API_ALLOWLIST.has(funcs[0]!)) return `api ${funcs.join(',')} is not allow-listed`;
      return null;
    }
    return `method ${method} not allowed`;
  }
}
