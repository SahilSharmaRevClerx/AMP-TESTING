import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from '../core/credentials';
import { assertFromUi, HttpError, readBody, send } from '../core/http';
import type { Ctx } from '../core/module';
import { HOST, OUTPUT_DIR, PORT, ROOT } from '../core/paths';
import { SafetyError } from '../core/safety/gate';
import { createLogger, getLogLevel, isDebug, since } from '../core/util/logger';
import { scrub } from '../core/util/mask';
import { MODULES } from './registry';

/**
 * The one local server behind `npm start`. It knows nothing about any test: it serves the home
 * catalog and the output folder, applies the security rules, and hands every other request to the
 * registered modules (src/app/registry.ts), each of which lives in src/modules/<name>/.
 */

const log = createLogger('server');
const httpLog = createLogger('http');

// The AI reviews' Gemini settings may live in .env or .env.local (only these names are read; jwts are entered in the page).
for (const file of ['.env.local', '.env']) loadLocalEnv(file, ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_MODEL']);

const HOME_FILE = fileURLToPath(new URL('./home.html', import.meta.url));
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

/** Page path → HTML file, from every module. */
const PAGES = new Map<string, string>();
for (const m of MODULES) for (const [path, file] of Object.entries(m.pages ?? {})) PAGES.set(path, file);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && (path === '/' || path === '/index.html')) return send(res, 200, readFileSync(HOME_FILE, 'utf8'), 'text/html');
  if (method === 'GET' && PAGES.has(path)) return send(res, 200, readFileSync(PAGES.get(path)!, 'utf8'), 'text/html');
  if (method === 'GET' && path.startsWith('/output/')) return serveOutput(path, res);
  if (!path.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

  if (method === 'GET' && path === '/api/modules') return send(res, 200, { modules: catalog() });

  // Everything that is not a module's public read changes state or uses tokens: this UI only.
  if (!MODULES.some((m) => m.isPublic?.(method, path))) assertFromUi(req);

  let body: Promise<unknown> | null = null;
  const ctx: Ctx = {
    req,
    res,
    method,
    path,
    url,
    body: <T>() => (body ??= readBody(req)) as Promise<T>,
    json: (status, payload) => {
      send(res, status, payload);
      return true;
    },
  };
  for (const m of MODULES) if (await m.handle(ctx)) return;
  send(res, 404, { error: 'Not found' });
}

/** The catalog cards, with each module's last run. */
function catalog() {
  return MODULES.filter((m) => m.card)
    .map((m) => ({ id: m.id, ...m.card!, lastRun: safe(() => m.lastRun?.() ?? null) }))
    .sort((a, b) => a.order - b.order);
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch (e) {
    log.warn('catalog: last run could not be read', { error: (e as Error).message });
    return null;
  }
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

/** GETs of pages, reports, history and live progress are routine; only shown with --debug. */
function isRoutine(method: string, path: string): boolean {
  if (method === 'GET' && (path === '/' || PAGES.has(path) || path.startsWith('/output/') || path === '/api/modules')) return true;
  return MODULES.some((m) => m.isRoutine?.(method, path));
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

  // Security headers on everything we serve (tool pages and reports).
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
  log.info(`UI running at ${url}`, { logLevel: getLogLevel(), node: process.version, cwd: ROOT, output: OUTPUT_DIR, modules: MODULES.filter((m) => m.card).map((m) => m.id) });
  log.info('tokens entered in the UI stay in this process memory only; press Ctrl+C to stop');
  if (!isDebug()) log.info('for detailed logs (every page, request and blocked call) start with: npm run start:debug');
  if (!process.argv.includes('--no-open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => undefined);
  }
});
