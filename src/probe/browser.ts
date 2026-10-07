import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page, Request, Response } from 'playwright';
import { startBrowser } from './launch';
import { apiFuncsFromUrl, decideBrowserRequest, isApiEndpoint } from '../safety/gate';
import type { AuditLog } from '../util/audit';
import type { ApiCall, Credentials, PageEvidence, RunConfig } from '../types';
import { isLoginPath, normalizeRoute, slug, urlPath } from '../util/route';
import { scrub } from '../util/mask';
import { createLogger, since } from '../util/logger';

const log = createLogger('browser');
const STATIC_EXT = /\.(js|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|otf|mp4|webm)$/i;
/** Requests that stay open by design (push channels); never waited for. */
const LONG_LIVED = /signalr|\/hubs?\/|negotiate|longpoll|\/poll\b|eventsource|\/sse\b/i;
/** Debug screenshots while waiting are taken at most this often. */
const DEBUG_SHOT_EVERY_MS = 2000;

interface WaitResult {
  stillLoading: boolean;
  log: string[];
}

interface Collector {
  fragmentPath: string;
  fragmentStatus: number | null;
  fragmentRedirect: string | null;
  apiCalls: Promise<ApiCall | null>[];
  blocked: string[];
  pageErrors: string[];
}

/** Opens AMP pages as one user in a real (headless) browser and records what the user sees. */
export class BrowserProbe {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private collector: Collector | null = null;
  /** AMP requests (own host, not static files) that have started and not finished yet. */
  private readonly pending = new Map<Request, number>();
  private readonly baseHost: string;
  private readonly baseOrigin: string;

  constructor(
    private readonly cfg: RunConfig,
    private readonly audit: AuditLog,
    private readonly userType: string,
    private readonly shotDir: string,
    /** Step-by-step screenshots per page go here (null = off). */
    private readonly debugDir: string | null = null,
  ) {
    const u = new URL(cfg.environment.baseUrl);
    this.baseHost = u.host.toLowerCase();
    this.baseOrigin = u.origin;
    mkdirSync(shotDir, { recursive: true });
    if (debugDir) mkdirSync(debugDir, { recursive: true });
  }

  /** Starts the browser, sets the user's cookies and loads the AMP shell. Returns an error string on failure. */
  async open(creds: Credentials): Promise<string | null> {
    const started = Date.now();
    const { browser, context } = await startBrowser({
      headless: this.cfg.headless,
      context: { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false },
      who: this.userType,
    });
    this.browser = browser;
    this.context = context;
    log.debug('chromium launched', { user: this.userType, headless: this.cfg.headless, version: this.browser.version(), ms: since(started) });
    // The jwt is HttpOnly (as AMP sets it): scripts on the page, including third-party ones
    // loaded by AMP pages, cannot read it; it is only sent to this exact host.
    // The CSRF cookie must stay readable: AMP's own JavaScript copies it into the X-CSRF-Token header.
    await this.context.addCookies([
      { name: 'jwt', value: creds.jwt, url: this.baseOrigin, httpOnly: true, sameSite: 'Lax' },
      { name: 'X-CSRF-Token', value: creds.csrf, url: this.baseOrigin, sameSite: 'Lax' },
    ]);

    // Every request the page makes passes the safety policy first.
    await this.context.route('**/*', async (route) => {
      const req = route.request();
      const d = decideBrowserRequest(req.method(), req.url(), this.baseHost);
      const isOwnHost = safeHost(req.url()) === this.baseHost;
      if (!d.allowed) {
        this.audit.write({ source: 'browser', userType: this.userType, method: req.method(), url: req.url(), decision: 'blocked', reason: d.reason });
        this.collector?.blocked.push(`${req.method()} ${shortUrl(req.url())} (${d.reason})`);
        log.debug('browser request blocked', { user: this.userType, method: req.method(), url: shortUrl(req.url()), host: isOwnHost ? undefined : safeHost(req.url()), reason: d.reason });
        await route.abort('blockedbyclient');
        return;
      }
      if (isOwnHost && !STATIC_EXT.test(safePath(req.url()))) {
        this.audit.write({ source: 'browser', userType: this.userType, method: req.method(), url: req.url(), decision: 'allowed' });
      }
      await route.continue();
    });

    this.page = await this.context.newPage();
    this.page.on('response', (res) => this.onResponse(res));
    this.page.on('request', (req) => this.onRequest(req));
    this.page.on('requestfinished', (req) => this.pending.delete(req));
    this.page.on('requestfailed', (req) => this.pending.delete(req));
    this.page.on('pageerror', (err) => {
      this.collector?.pageErrors.push(scrub(err.message).slice(0, 300));
      log.debug('AMP page script error', { user: this.userType, error: err.message.slice(0, 200) });
    });
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') log.debug('AMP console error', { user: this.userType, text: msg.text().slice(0, 200) });
    });

    const err = await this.loadShell();
    if (err) return err;
    await this.captureBaseline();
    return null;
  }

  /**
   * Loads AMP's main page directly on the frame-only route. Opening "/" would make AMP load the
   * user's default dashboard (~25 widget requests); on a slow server every page after it then waits
   * behind those requests.
   */
  private async loadShell(): Promise<string | null> {
    const page = this.page!;
    const started = Date.now();
    const target = `${this.baseOrigin}${this.cfg.shellPath}#${BASELINE_ROUTE}`;
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.cfg.pageTimeoutMs });
      await page.waitForLoadState('networkidle', { timeout: this.cfg.pageTimeoutMs }).catch(() => undefined);
    } catch (e) {
      const reason = `could not load AMP main page: ${scrub((e as Error).message).split('\n')[0]}`;
      log.warn('main page load failed', { user: this.userType, url: target, ms: since(started), reason });
      return reason;
    }
    const path = urlPath(page.url());
    if (isLoginPath(path)) {
      log.warn('main page sent user to login - token expired or wrong', { user: this.userType, landed: path, ms: since(started) });
      return `redirected to ${path} - token expired or wrong`;
    }
    log.debug('main page loaded', { user: this.userType, landed: page.url(), ms: since(started) });
    return null;
  }

  private onRequest(req: Request): void {
    const url = req.url();
    if (safeHost(url) === this.baseHost && !STATIC_EXT.test(safePath(url)) && !LONG_LIVED.test(url)) this.pending.set(req, Date.now());
    const c = this.collector;
    if (!c) return;
    const from = req.redirectedFrom();
    if (from && urlPath(from.url()).startsWith(c.fragmentPath) && !c.fragmentRedirect) {
      c.fragmentRedirect = urlPath(req.url());
    }
  }

  private onResponse(res: Response): void {
    const c = this.collector;
    if (!c) return;
    const url = res.url();
    if (safeHost(url) !== this.baseHost) return;
    const path = urlPath(url);

    if (c.fragmentStatus === null && (path === c.fragmentPath || path.startsWith(c.fragmentPath + '/'))) {
      c.fragmentStatus = res.status();
      if (res.status() >= 300 && res.status() < 400) {
        const loc = res.headers()['location'];
        if (loc) c.fragmentRedirect = urlPath(new URL(loc, url).href);
      }
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (isApiEndpoint(parsed)) {
      const funcs = apiFuncsFromUrl(parsed);
      c.apiCalls.push(readApiCall(res, funcs.join(',')));
    }
  }

  /**
   * Waits (up to half the page time limit, max 15 s) until AMP requests still running from earlier
   * pages have finished. Returns a log line when it had to wait, else null.
   */
  private async drainPending(page: Page): Promise<string | null> {
    const started = Date.now();
    // Forget requests that never reported back (e.g. cut off by a full navigation).
    for (const [req, at] of this.pending) if (started - at > 2 * this.cfg.pageTimeoutMs) this.pending.delete(req);
    const before = this.pending.size;
    if (!before) return null;
    const max = Math.min(15000, this.cfg.pageTimeoutMs / 2);
    while (this.pending.size && Date.now() - started < max) await page.waitForTimeout(250);
    const left = this.pending.size;
    return `before opening: waited ${((Date.now() - started) / 1000).toFixed(1)}s for ${before} request(s) from the previous page to finish${left ? `, ${left} still running (${this.pendingSince(0).slice(0, 3).join(', ')})` : ''}`;
  }

  /** Short paths of AMP requests started since `since` that are still running. */
  private pendingSince(since: number): string[] {
    return [...this.pending].filter(([, at]) => at >= since).map(([req]) => shortUrl(req.url()).split('?')[0]!);
  }

  /**
   * Waits until the page has finished loading instead of a fixed delay. Loaded means all three:
   * the page stopped changing (elements and text the same for 3 samples, ~0.8 s), none of the AMP
   * requests started for this page is still running, and no loading spinner / "Loading..." text is
   * visible outside the AMP frame. Slow dev servers can take 25 s for one page, so the limit is
   * pageTimeoutMs. A spinner that stays while nothing changes for ~4 s and no request runs is
   * treated as decoration. Saves a debug screenshot every ~2 s when debugging is on.
   */
  private async waitForPage(page: Page, since: number, debug: string | null): Promise<WaitResult> {
    const deadline = since + this.cfg.pageTimeoutMs;
    const log: string[] = [];
    let last = '';
    let same = 0;
    let lastShot = 0;
    let shots = 0;
    await page.waitForTimeout(Math.min(this.cfg.settleMs, 500));
    for (;;) {
      const s = (await page.evaluate(STABLE_SIG).catch(() => ({ sig: '', loader: '' }))) as { sig: string; loader: string };
      const pending = this.pendingSince(since);
      same = s.sig === last ? same + 1 : 0;
      last = s.sig;
      const t = ((Date.now() - since) / 1000).toFixed(1);
      log.push(`${t}s elements:text=${s.sig} running=${pending.length}${pending.length ? ` (${pending.slice(0, 3).join(', ')})` : ''} spinner=${s.loader || 'none'}`);
      if (debug && Date.now() - lastShot >= DEBUG_SHOT_EVERY_MS) {
        lastShot = Date.now();
        shots++;
        await page.screenshot({ path: join(debug, `${String(shots).padStart(2, '0')}-at-${t}s.png`) }).catch(() => undefined);
      }
      const quiet = pending.length === 0;
      if (same >= 2 && quiet && !s.loader) {
        log.push(`loaded after ${t}s`);
        return { stillLoading: false, log };
      }
      if (same >= 10 && quiet) {
        log.push(`spinner "${s.loader}" still visible but nothing changed for 4 s and no request is running: treated as loaded (${t}s)`);
        return { stillLoading: false, log };
      }
      if (Date.now() >= deadline) {
        log.push(`time limit (${this.cfg.pageTimeoutMs / 1000}s) reached${quiet ? '' : `, ${pending.length} request(s) still running`}${s.loader ? `, spinner still visible` : ''}`);
        return { stillLoading: !quiet || !!s.loader, log };
      }
      await page.waitForTimeout(400);
    }
  }

  /** What this user's AMP frame looks like with no page loaded (menu, header, notifications). */
  baseline: PageEvidence | null = null;

  /**
   * Opens a route that does not exist, so only the AMP frame renders. Everything on it is "frame",
   * not page content. Kept only if the browser stayed on the AMP main page.
   */
  async captureBaseline(): Promise<void> {
    const ev = await this.probe(BASELINE_ROUTE, { screenshot: false, debugName: '00-frame-only' });
    const stayed = urlPath(ev.finalUrl) === urlPath(this.baseOrigin + this.cfg.shellPath) && !ev.error;
    this.baseline = stayed ? ev : null;
    log.debug('frame baseline', { user: this.userType, kept: stayed, elements: ev.tokens.length, apis: ev.apiCalls.map((a) => a.func) });
  }

  /**
   * Opens one hash route the way a user would and collects evidence.
   * `debugName` names this page's folder of step-by-step screenshots (when debugging is on).
   */
  async probe(route: string, opts: { screenshot?: boolean; debugName?: string } = {}): Promise<PageEvidence> {
    const page = this.page!;
    const started = Date.now();
    const norm = normalizeRoute(route);
    const debug = this.debugDir && opts.debugName ? join(this.debugDir, opts.debugName) : null;
    if (debug) mkdirSync(debug, { recursive: true });
    const c: Collector = {
      fragmentPath: '/' + norm,
      fragmentStatus: null,
      fragmentRedirect: null,
      apiCalls: [],
      blocked: [],
      pageErrors: [],
    };

    // If a previous page navigated away from the shell (e.g. full redirect to /noaccess), reload it.
    const shellPath = urlPath(this.baseOrigin + this.cfg.shellPath);
    if (urlPath(page.url()) !== shellPath) {
      const err = await this.loadShell();
      if (err) return emptyEvidence(norm, page.url(), started, err);
    }

    // Let requests from the previous page finish first, so this page doesn't queue behind them.
    const drain = await this.drainPending(page);

    this.collector = c;
    let error: string | undefined;
    let wait: WaitResult = { stillLoading: false, log: [] };
    const navStarted = Date.now();
    try {
      await page.evaluate((h) => {
        window.location.hash = h;
      }, norm);
      wait = await this.waitForPage(page, navStarted, debug);
      if (drain) wait.log.unshift(drain);
    } catch (e) {
      error = scrub((e as Error).message).split('\n')[0];
    }

    let dom: DomSnapshot = { noAccessMarker: false, denialText: '', errorText: '', emptyText: '', notFoundText: '', textLength: 0, tokens: [], title: '' };
    try {
      dom = (await page.evaluate(COLLECT_DOM)) as DomSnapshot;
    } catch (e) {
      error ??= `could not read page: ${scrub((e as Error).message).split('\n')[0]}`;
    }

    // One screenshot of what the decision is based on: kept with the report, and copied to the debug folder.
    let screenshot: string | null = opts.screenshot === false ? null : join(this.shotDir, `${slug(norm)}.png`);
    if (screenshot || debug) {
      try {
        const png = await page.screenshot({ fullPage: false });
        if (screenshot) writeFileSync(screenshot, png);
        if (debug) writeFileSync(join(debug, `final-decided-on-this-${((Date.now() - navStarted) / 1000).toFixed(1)}s.png`), png);
      } catch {
        screenshot = null;
      }
    }

    this.collector = null;
    const apiCalls = (await Promise.all(c.apiCalls)).filter((a): a is ApiCall => a !== null);

    return {
      route: norm,
      finalUrl: page.url(),
      fragmentStatus: c.fragmentStatus,
      fragmentRedirect: c.fragmentRedirect,
      noAccessMarker: dom.noAccessMarker,
      denialText: dom.denialText || undefined,
      errorText: dom.errorText || undefined,
      emptyText: dom.emptyText || undefined,
      notFoundText: dom.notFoundText || undefined,
      stillLoading: wait.stillLoading || undefined,
      waitLog: wait.log,
      debugDir: debug,
      apiCalls,
      blockedRequests: c.blocked,
      pageErrors: c.pageErrors,
      textLength: dom.textLength,
      tokens: dom.tokens,
      title: dom.title,
      screenshot,
      error,
      durationMs: Date.now() - started,
    };
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }
}

interface DomSnapshot {
  noAccessMarker: boolean;
  denialText: string;
  errorText: string;
  emptyText: string;
  notFoundText: string;
  textLength: number;
  tokens: string[];
  title: string;
}

/** A route that exists on no AMP build: opening it renders only the AMP frame. */
export const BASELINE_ROUTE = '__permission_test_frame_only__';

/**
 * Cheap page signature used to wait until the page stops changing, plus the first visible loading
 * indicator outside the AMP frame (spinner/loader/loading classes, fa-spin, aria-busy, progressbar,
 * or a short "Loading..." text), or '' when there is none.
 */
const STABLE_SIG = `(() => {
  const sig = document.querySelectorAll('[id],h1,h2,h3,h4,table,canvas,svg,img,li').length + ':' + Math.round(((document.body && document.body.innerText) || '').length / 50);
  const frame = 'nav,header,[role=navigation],#top-banner,#left-panel,#navigation,#walkme-player';
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  let loader = '';
  const els = document.querySelectorAll('[class*="spinner" i],[class*="loader" i],[class*="loading" i],.fa-spin,[aria-busy="true"],[role="progressbar"]');
  for (const el of els) {
    if (el === document.body || el === document.documentElement || el.closest(frame) || !shown(el)) continue;
    loader = String(typeof el.className === 'string' && el.className ? el.className : el.tagName).trim().slice(0, 40);
    break;
  }
  if (!loader && document.body) {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = (n.nodeValue || '').trim();
      if (t.length > 20 || !/^(loading|please wait)\\b/i.test(t)) continue;
      const p = n.parentElement;
      if (p && !p.closest(frame) && shown(p)) { loader = 'text: ' + t; break; }
    }
  }
  return { sig, loader };
})()`;

/**
 * Runs inside the page. Kept as a plain string because tsx/esbuild inject helpers
 * (e.g. __name) into compiled functions, which do not exist in the browser.
 * `.error-text-2` is the element on AMP's no-access page (navin/public/noaccess.cshtml).
 */
const COLLECT_DOM = `(() => {
  const visible = (el) => {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    const s = el.ownerDocument.defaultView.getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  // The page itself plus any same-origin iframes (embedded dashboards/reports).
  const docs = [document];
  document.querySelectorAll('iframe').forEach((f) => { try { if (f.contentDocument && f.contentDocument.body) docs.push(f.contentDocument); } catch (e) {} });

  const dynamicId = /\\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}|^ui-id-|^select2-|^ext-gen/i;
  // Short on-screen messages that mean "you may not see this page".
  const denial = /(you (do not|don't|dont) have (the )?(access|permission|rights?|privileges?)|access (is )?denied|permission denied|not authori[sz]ed|unauthori[sz]ed access|insufficient (privileges|permissions|rights)|no access to (this|the) (page|module|feature|section))/i;
  // Short on-screen messages that mean "the page failed" (not a permission answer by itself).
  const failure = /(something went wrong|an (unexpected )?error (has )?occurred|unexpected error|internal server error|error 500|server error|failed to load|could not be loaded|unable to load)/i;
  // The page's own "nothing here yet" message: the page rendered, it just has no rows.
  const empty = /^(no (data|records?|results?|items?|entries|rows|contacts|accounts|files|assets|playbooks|users)( (found|available|yet|to (show|display)))?|there (is|are) no (data|records?|items?|results?)\\b.*|nothing (to (show|display)|here)( yet)?|no .{1,40} (found|yet|available))[.!]?$/i;
  // AMP's own "page not found" screen (navin/public/error-404-v5.cshtml: "Looks like you're lost / ERROR CODE: 404").
  const notFound = /^(looks like you(’|'|)re lost|error code:? ?404|404 (page )?not found|page not found|the page you (are|were) looking for (does not|doesn't|could not))/i;
  const tokens = new Set();
  let noAccessMarker = false, denialText = '', errorText = '', emptyText = '', notFoundText = '', textLength = 0;
  docs.forEach((doc) => {
    doc.querySelectorAll('[id]').forEach((el) => {
      if (el.id && !dynamicId.test(el.id) && visible(el)) tokens.add('id:' + el.id);
    });
    doc.querySelectorAll('h1,h2,h3,h4,.page-title,.breadcrumb li:last-child').forEach((el) => {
      const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (t && t.length <= 80 && visible(el)) tokens.add('h:' + t.toLowerCase());
    });
    const marker = doc.querySelector('.error-text-2');
    if (marker && visible(marker)) noAccessMarker = true;
    textLength += ((doc.body && doc.body.innerText) || '').length;
    if ((!denialText || !errorText || !emptyText) && doc.body) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = (node.nodeValue || '').replace(/\\s+/g, ' ').trim();
        if (t.length < 4 || t.length > 200) continue;
        const isDenial = !denialText && denial.test(t);
        const isFailure = !errorText && failure.test(t);
        const isEmpty = !emptyText && t.length <= 120 && empty.test(t);
        const isNotFound = !notFoundText && t.length <= 120 && notFound.test(t);
        if (!isDenial && !isFailure && !isEmpty && !isNotFound) continue;
        const parent = node.parentElement;
        if (!parent || !visible(parent) || parent.closest('script,style,noscript,nav,[role=navigation]')) continue;
        if (isDenial) denialText = t.slice(0, 120);
        else if (isFailure) errorText = t.slice(0, 120);
        else if (isEmpty) emptyText = t.slice(0, 120);
        else notFoundText = t.slice(0, 120);
        if (denialText && errorText && emptyText && notFoundText) break;
      }
    }
  });
  return { noAccessMarker, denialText, errorText, emptyText, notFoundText, textLength, tokens: Array.from(tokens), title: document.title };
})()`;

async function readApiCall(res: Response, func: string): Promise<ApiCall | null> {
  const httpStatus = res.status();
  let apiStatus: number | null = null;
  let denied = httpStatus === 401;
  let hasData = false;
  try {
    const body = (await res.json()) as { status?: unknown; result?: unknown };
    if (typeof body.status === 'number') apiStatus = body.status;
    const r = body.result;
    if (r === 'Not authorized.') denied = true;
    const isErrorShape = !!r && typeof r === 'object' && 'code' in r && 'message' in r && Object.keys(r).length <= 3;
    if (isErrorShape) {
      const msg = String((r as { message: unknown }).message).toLowerCase();
      if (/access|permission|authori[sz]|not allowed/.test(msg)) denied = true;
    }
    hasData = httpStatus < 400 && !denied && !isErrorShape && hasPayload(r);
  } catch {
    // non-JSON (e.g. XML result) - keep http status only
  }
  return { func, httpStatus, apiStatus, denied, hasData };
}

/** True when an API result carries data (a non-empty list, or an object with non-empty values). */
function hasPayload(v: unknown, depth = 0): boolean {
  if (v === null || v === undefined || v === '' || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') {
    if (depth > 2) return true;
    return Object.values(v as Record<string, unknown>).some((x) => hasPayload(x, depth + 1));
  }
  return typeof v === 'number' ? true : String(v).length > 0;
}

function emptyEvidence(route: string, finalUrl: string, started: number, error: string): PageEvidence {
  return {
    route,
    finalUrl,
    fragmentStatus: null,
    fragmentRedirect: null,
    noAccessMarker: false,
    apiCalls: [],
    blockedRequests: [],
    pageErrors: [],
    textLength: 0,
    tokens: [],
    title: '',
    screenshot: null,
    error,
    durationMs: Date.now() - started,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}
function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
