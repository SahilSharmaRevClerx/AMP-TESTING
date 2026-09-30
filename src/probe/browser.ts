import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from 'playwright';
import { apiFuncsFromUrl, decideBrowserRequest, isApiEndpoint } from '../safety/gate';
import type { AuditLog } from '../util/audit';
import type { ApiCall, Credentials, PageEvidence, RunConfig } from '../types';
import { isLoginPath, normalizeRoute, slug, urlPath } from '../util/route';
import { scrub } from '../util/mask';
import { createLogger, since } from '../util/logger';

const log = createLogger('browser');
const STATIC_EXT = /\.(js|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|otf|mp4|webm)$/i;

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
  private readonly baseHost: string;
  private readonly baseOrigin: string;

  constructor(
    private readonly cfg: RunConfig,
    private readonly audit: AuditLog,
    private readonly userType: string,
    private readonly shotDir: string,
  ) {
    const u = new URL(cfg.environment.baseUrl);
    this.baseHost = u.host.toLowerCase();
    this.baseOrigin = u.origin;
    mkdirSync(shotDir, { recursive: true });
  }

  /** Starts the browser, sets the user's cookies and loads the AMP shell. Returns an error string on failure. */
  async open(creds: Credentials): Promise<string | null> {
    const started = Date.now();
    this.browser = await chromium.launch({ headless: this.cfg.headless });
    log.debug('chromium launched', { user: this.userType, headless: this.cfg.headless, version: this.browser.version(), ms: since(started) });
    this.context = await this.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false });
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

  private async loadShell(): Promise<string | null> {
    const page = this.page!;
    const started = Date.now();
    const target = this.baseOrigin + this.cfg.shellPath;
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
   * Waits until the page stops changing (slow widgets, async dashboards) instead of a fixed delay:
   * samples the number of elements and the amount of text until two samples in a row are equal.
   */
  private async waitUntilStable(page: Page): Promise<void> {
    const deadline = Date.now() + Math.min(8000, this.cfg.pageTimeoutMs);
    let last = '';
    let same = 0;
    while (Date.now() < deadline) {
      const sig = (await page.evaluate(STABLE_SIG).catch(() => '')) as string;
      same = sig === last ? same + 1 : 0;
      if (same >= 2) return;
      last = sig;
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
    const ev = await this.probe(BASELINE_ROUTE, { screenshot: false });
    const stayed = urlPath(ev.finalUrl) === urlPath(this.baseOrigin + this.cfg.shellPath) && !ev.error;
    this.baseline = stayed ? ev : null;
    log.debug('frame baseline', { user: this.userType, kept: stayed, elements: ev.tokens.length, apis: ev.apiCalls.map((a) => a.func) });
  }

  /** Opens one hash route the way a user would and collects evidence. */
  async probe(route: string, opts: { screenshot?: boolean } = {}): Promise<PageEvidence> {
    const page = this.page!;
    const started = Date.now();
    const norm = normalizeRoute(route);
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

    this.collector = c;
    let error: string | undefined;
    try {
      await page.evaluate((h) => {
        window.location.hash = h;
      }, norm);
      await page
        .waitForResponse((r) => urlPath(r.url()).startsWith(c.fragmentPath), { timeout: Math.min(8000, this.cfg.pageTimeoutMs) })
        .catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: this.cfg.pageTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout(Math.min(this.cfg.settleMs, 500));
      await this.waitUntilStable(page);
    } catch (e) {
      error = scrub((e as Error).message).split('\n')[0];
    }

    let dom: DomSnapshot = { noAccessMarker: false, denialText: '', errorText: '', textLength: 0, tokens: [], title: '' };
    try {
      dom = (await page.evaluate(COLLECT_DOM)) as DomSnapshot;
    } catch (e) {
      error ??= `could not read page: ${scrub((e as Error).message).split('\n')[0]}`;
    }

    let screenshot: string | null = opts.screenshot === false ? null : join(this.shotDir, `${slug(norm)}.png`);
    if (screenshot) {
      try {
        await page.screenshot({ path: screenshot, fullPage: false });
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
  textLength: number;
  tokens: string[];
  title: string;
}

/** A route that exists on no AMP build: opening it renders only the AMP frame. */
export const BASELINE_ROUTE = '__permission_test_frame_only__';

/** Cheap page signature used to wait until the page stops changing. */
const STABLE_SIG = `(() => document.querySelectorAll('[id],h1,h2,h3,h4,table,canvas,svg,img,li').length + ':' + Math.round(((document.body && document.body.innerText) || '').length / 50))()`;

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
  const tokens = new Set();
  let noAccessMarker = false, denialText = '', errorText = '', textLength = 0;
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
    if ((!denialText || !errorText) && doc.body) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = (node.nodeValue || '').replace(/\\s+/g, ' ').trim();
        if (t.length < 4 || t.length > 200) continue;
        const isDenial = !denialText && denial.test(t);
        const isFailure = !errorText && failure.test(t);
        if (!isDenial && !isFailure) continue;
        const parent = node.parentElement;
        if (!parent || !visible(parent) || parent.closest('script,style,noscript,nav,[role=navigation]')) continue;
        if (isDenial) denialText = t.slice(0, 120);
        else errorText = t.slice(0, 120);
        if (denialText && errorText) break;
      }
    }
  });
  return { noAccessMarker, denialText, errorText, textLength, tokens: Array.from(tokens), title: document.title };
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
