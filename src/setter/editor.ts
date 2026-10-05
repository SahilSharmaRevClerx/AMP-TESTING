import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { apiFuncsFromUrl, decideSetterRequest, isApiEndpoint, SETTER_WRITE_API } from '../safety/gate';
import type { AuditLog } from '../util/audit';
import type { Credentials } from '../types';
import { isLoginPath, urlPath } from '../util/route';
import { scrub } from '../util/mask';
import { createLogger } from '../util/logger';
import type { Grid } from './sliders';

const log = createLogger('setter');
const USER = 'super_admin';

/** What the role editor showed for one role: slider steps (0–4) and Advanced checkboxes. */
export interface RoleValues {
  media: Record<string, number>;
  system: Record<string, number>;
  features: Record<string, boolean>;
  /** Rows AMP hides for this company (e.g. Learning Management without a course catalog). */
  hidden: string[];
  /** Row names as the editor shows them, keyed "media:32". */
  labels: Record<string, string>;
}

export interface EditorOptions {
  baseUrl: string;
  headless: boolean;
  timeoutMs: number;
  /** Let the browser call SaveRole. Off = preview: sliders move on screen, nothing is saved. */
  allowSave: boolean;
  /** Pause after every step (tab switch, slider move, save) so AMP's page keeps up. */
  stepDelayMs: number;
}

/** Default pause between steps: slow enough for AMP's role editor on a dev server to keep up. */
export const DEFAULT_STEP_DELAY_MS = 1500;

/**
 * Drives AMP's own role editor as the Super Admin: Setup → Roles → open a role → move its sliders
 * → Save. Same screens and the same SaveRole call a person would make, so AMP's own rules apply.
 */
export class RoleEditor {
  private browser?: Browser;
  private page?: Page;
  private readonly origin: string;
  private readonly host: string;

  constructor(
    private readonly opts: EditorOptions,
    private readonly audit: AuditLog,
  ) {
    const u = new URL(opts.baseUrl);
    this.origin = u.origin;
    this.host = u.host.toLowerCase();
  }

  async open(creds: Credentials): Promise<void> {
    this.browser = await chromium.launch({ headless: this.opts.headless });
    const context = await this.browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([
      { name: 'jwt', value: creds.jwt, url: this.origin, httpOnly: true, sameSite: 'Lax' },
      { name: 'X-CSRF-Token', value: creds.csrf, url: this.origin, sameSite: 'Lax' },
    ]);
    await context.route('**/*', async (route) => {
      const req = route.request();
      const d = decideSetterRequest(req.method(), req.url(), this.host, this.opts.allowSave);
      if (!d.allowed) {
        this.audit.write({ source: 'browser', userType: USER, method: req.method(), url: req.url(), decision: 'blocked', reason: d.reason });
        log.debug('browser request blocked', { method: req.method(), url: req.url().slice(0, 120), reason: d.reason });
        await route.abort('blockedbyclient');
        return;
      }
      if (req.method() !== 'GET') this.audit.write({ source: 'browser', userType: USER, method: req.method(), url: req.url(), decision: 'allowed', reason: d.reason });
      await route.continue();
    });
    this.page = await context.newPage();
  }

  /**
   * Opens Setup → Roles fresh. Going to #setup/roles from AMP's own page is only a hash change, so the
   * previous role's editor (a modal) would stay open on top and block the next click: leave the page
   * first so AMP loads again from scratch.
   */
  async gotoRoles(): Promise<void> {
    const page = this.page!;
    await page.goto('about:blank');
    await page.goto(`${this.origin}/#setup/roles`, { waitUntil: 'domcontentloaded', timeout: this.opts.timeoutMs });
    if (isLoginPath(urlPath(page.url()))) throw new Error('AMP sent the Super Admin to the login page: the jwt expired or was logged out');
    await page.waitForSelector('tr[data-recordid][data-name]', { state: 'attached', timeout: this.opts.timeoutMs }).catch(() => {
      throw new Error('the Roles list did not load (is this user a Super Admin?)');
    });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await this.pause();
  }

  /** Clicks the role in the Roles list (searching for it if it isn't on the first page) and waits for its sliders. */
  async openRole(name: string): Promise<void> {
    const page = this.page!;
    await this.gotoRoles();
    let row = await this.findRow(name);
    if (!row) {
      const search = page.locator('.header-search input:visible').first();
      if (await search.count()) {
        await search.fill(name);
        await search.press('Enter');
        await page.waitForTimeout(1500);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
        row = await this.findRow(name);
      }
    }
    if (!row) {
      const names = await page.$$eval('tr[data-recordid][data-name]', (trs) => trs.map((t) => t.getAttribute('data-name') ?? ''));
      throw new Error(`role "${name}" not found in Setup → Roles (seen: ${names.slice(0, 15).join(', ') || 'none'})`);
    }
    if (row.locked) throw new Error(`role "${name}" is locked in AMP; unlock it in Setup → Roles first`);

    await page.locator(`tr[data-recordid="${row.id}"] td[data-action="view"]`).first().click();
    // Both slider grids load when the role opens; wait until they are built (jQuery UI adds .ui-slider).
    for (const grid of ['media', 'system']) {
      await page.waitForSelector(`[name="slider"][id^="${grid}gridrecorditem"].ui-slider`, { state: 'attached', timeout: this.opts.timeoutMs }).catch(() => {
        throw new Error(`the role editor did not show its ${grid === 'media' ? 'Marketing Functions' : 'Operations'} sliders`);
      });
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    // Sliders are built after the grids' data arrives; give the editor time to finish drawing.
    await this.pause(2);
  }

  private async pause(times = 1): Promise<void> {
    await this.page!.waitForTimeout(this.opts.stepDelayMs * times);
  }

  private async findRow(name: string): Promise<{ id: string; locked: boolean } | null> {
    return this.page!.$$eval(
      'tr[data-recordid][data-name]',
      (trs, want) => {
        const t = trs.find((x) => (x.getAttribute('data-name') ?? '').trim().toLowerCase() === want);
        return t ? { id: t.getAttribute('data-recordid') ?? '', locked: t.getAttribute('data-islocked') === '1' } : null;
      },
      name.trim().toLowerCase(),
    );
  }

  /** Current slider steps and Advanced checkboxes of the open role. */
  async read(): Promise<RoleValues> {
    return this.page!.evaluate(() => {
      const $ = (window as unknown as { jQuery: (s: unknown) => { slider: (m: string) => number } }).jQuery;
      const out = { media: {} as Record<string, number>, system: {} as Record<string, number>, features: {} as Record<string, boolean>, hidden: [] as string[], labels: {} as Record<string, string> };
      for (const grid of ['media', 'system'] as const) {
        document.querySelectorAll<HTMLElement>(`[name="slider"][id^="${grid}gridrecorditem"].ui-slider`).forEach((el) => {
          const id = el.getAttribute('recordid') ?? el.id.replace(`${grid}gridrecorditem`, '');
          out[grid][id] = (Number($(el).slider('value')) - 1) / 2;
          const row = document.getElementById(`${grid}gridrecorditem${id}_row1`);
          if (row && row.style.display === 'none') out.hidden.push(`${grid}:${id}`);
          const name = row?.querySelector('td')?.textContent?.trim();
          if (name) out.labels[`${grid}:${id}`] = name;
        });
      }
      document.querySelectorAll<HTMLInputElement>('#featuresDiv input.settings-check').forEach((c) => {
        out.features[c.getAttribute('optionid') ?? c.id] = c.checked;
      });
      return out;
    });
  }

  /**
   * Moves one slider to a step (0 = NA … 4 = Delete) on its own tab, waits, and checks it moved.
   * Retries once if AMP's page didn't take the change.
   */
  async setSlider(grid: Grid, id: number, step: number): Promise<void> {
    const page = this.page!;
    await this.showTab(grid);
    await this.scrollTo(grid, id);
    const sel = `#${grid}gridrecorditem${id}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ok = await page.evaluate(
        ({ sel, value }) => {
          const $ = (window as unknown as { jQuery: (s: string) => { length: number; slider: (m: string, v?: number) => number } }).jQuery;
          const el = $(sel);
          if (!el.length) return false;
          // Same as dragging the handle: the slider's change handler updates the role being edited.
          el.slider('value', value);
          return true;
        },
        { sel, value: step * 2 + 1 },
      );
      if (!ok) throw new Error(`slider ${sel} not found in the role editor`);
      await this.pause();
      if ((await this.sliderStep(grid, id)) === step) return;
      log.debug('slider did not take the value, retrying', { grid, id, step, attempt });
    }
    throw new Error(`slider ${sel} did not move to step ${step}`);
  }

  private async sliderStep(grid: Grid, id: number): Promise<number | null> {
    return this.page!.evaluate((sel) => {
      const $ = (window as unknown as { jQuery: (s: string) => { length: number; slider: (m: string) => number } }).jQuery;
      const el = $(sel);
      return el.length ? (Number(el.slider('value')) - 1) / 2 : null;
    }, `#${grid}gridrecorditem${id}`);
  }

  /**
   * One screenshot of a whole tab of the role editor (every row, not just what fits on screen).
   * AMP shows the editor in a scrolling modal, so for the shot the modal and its scroll boxes are
   * let out to full height and the browser window is made as tall as the content; both are put
   * back afterwards. Rows in `outline` (keys like "media:32", "feature:32") get an orange outline.
   */
  async shotTab(dir: string, name: string, tab: Grid | 'features', outline: string[] = []): Promise<string | null> {
    const page = this.page!;
    await this.showTab(tab);
    const anchor = tab === 'features' ? '#featuresDiv' : `[name="slider"][id^="${tab}gridrecorditem"]`;
    const height = await page.evaluate(
      ({ anchor, outline }) => {
        const el = document.querySelector(anchor);
        if (!el) return 0;
        // No named inner functions here: the TypeScript runner would wrap them in a helper the page doesn't have.
        const todo: [HTMLElement, Record<string, string>][] = [];
        for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
          const cs = getComputedStyle(n);
          const styles: Record<string, string> = {};
          if (/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflow)) Object.assign(styles, { overflow: 'visible', 'overflow-y': 'visible' });
          if (cs.maxHeight !== 'none') styles['max-height'] = 'none';
          if (n.scrollHeight > n.clientHeight + 2) styles.height = 'auto';
          if (cs.position === 'fixed') Object.assign(styles, { position: 'absolute', bottom: 'auto' });
          if (Object.keys(styles).length) todo.push([n, styles]);
        }
        for (const key of outline) {
          const [grid, id] = key.split(':');
          const rows =
            grid === 'feature'
              ? [document.querySelector(`#featuresDiv input.settings-check[optionid="${id}"]`)?.closest('.settings-line')]
              : [document.getElementById(`${grid}gridrecorditem${id}_row1`), document.getElementById(`${grid}gridrecorditem${id}_row2`)];
          for (const r of rows) if (r instanceof HTMLElement) todo.push([r, { outline: '3px solid #e8590c', 'outline-offset': '-3px' }]);
        }
        for (const [n, styles] of todo) {
          if (!('ptSaved' in n.dataset)) n.dataset.ptSaved = n.getAttribute('style') ?? '';
          for (const [k, v] of Object.entries(styles)) n.style.setProperty(k, v, 'important');
        }
        window.scrollTo(0, 0);
        return Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
      },
      { anchor, outline },
    );
    const size = page.viewportSize() ?? { width: 1440, height: 900 };
    if (height > size.height) await page.setViewportSize({ width: size.width, height: Math.min(height + 40, 12000) });
    await page.waitForTimeout(400);
    let file: string | null = null;
    try {
      mkdirSync(dir, { recursive: true });
      file = join(dir, name);
      await page.screenshot({ path: file, fullPage: true });
    } catch {
      file = null;
    }
    await page.setViewportSize(size);
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('[data-pt-saved]').forEach((n) => {
        const was = n.dataset.ptSaved ?? '';
        if (was) n.setAttribute('style', was);
        else n.removeAttribute('style');
        delete n.dataset.ptSaved;
      });
    });
    return file;
  }

  /** Ticks an Advanced-tab checkbox. */
  async setFeature(id: number, on: boolean): Promise<void> {
    const page = this.page!;
    await this.showTab('features');
    const box = page.locator(`#featuresDiv input.settings-check[optionid="${id}"]`).first();
    if (!(await box.count())) throw new Error(`Advanced option ${id} not found in the role editor`);
    // The real checkbox is hidden behind AMP's styled one; set it the way its label click would.
    await box.evaluate((el, v) => {
      const c = el as HTMLInputElement;
      if (c.checked !== v) {
        c.checked = v;
        // jQuery handlers (AMP's included) listen through addEventListener, so a native event reaches them.
        c.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, on);
    await this.pause();
    if ((await box.isChecked()) !== on) throw new Error(`Advanced option ${id} did not change`);
  }

  /** Clicks the role editor's Save and waits for AMP's answer. */
  async save(): Promise<void> {
    const page = this.page!;
    const answer = page.waitForResponse(
      (r) => {
        try {
          const u = new URL(r.url());
          return isApiEndpoint(u) && apiFuncsFromUrl(u)[0] === SETTER_WRITE_API;
        } catch {
          return false;
        }
      },
      { timeout: this.opts.timeoutMs },
    );
    await this.pause();
    await page.locator('a[data-action-name="save"]:visible').first().click();
    const res = await answer.catch(() => {
      throw new Error('AMP did not answer the role save in time');
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* checked below */
    }
    const status = (body as { status?: unknown })?.status;
    if (res.status() !== 200 || (typeof status === 'number' && status !== 0)) {
      const msg = JSON.stringify((body as { result?: unknown })?.result ?? body ?? '').slice(0, 200);
      throw new Error(`AMP refused the role save (HTTP ${res.status()}, status ${String(status)}): ${scrub(msg)}`);
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await this.pause(2);
  }

  async screenshot(dir: string, name: string): Promise<string | null> {
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, name);
      await this.page!.screenshot({ path: file });
      return file;
    } catch {
      return null;
    }
  }

  /** Scrolls a slider row into view (for screenshots). */
  async scrollTo(grid: Grid, id: number): Promise<void> {
    await this.page!.locator(`#${grid}gridrecorditem${id}`).first().scrollIntoViewIfNeeded().catch(() => undefined);
    await this.page!.waitForTimeout(Math.min(500, this.opts.stepDelayMs));
  }

  /** Shows a tab of the open role (for screenshots). */
  async showTab(grid: Grid | 'features'): Promise<void> {
    const sel = grid === 'features' ? 'li.feature_tab a' : `#${grid}_tab a`;
    await this.page!.locator(sel).first().click().catch(() => undefined);
    await this.pause();
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
  }
}
