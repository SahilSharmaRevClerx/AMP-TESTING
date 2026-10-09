/**
 * MCP workflow-kind labels end to end (P14 T5): the REAL server against the
 * fake AMP, through the real page, with "Also check workflow steps" on.
 * Fake AMP holds: w1 published (live), w2 draft-only, w3 a public template
 * our endpoint does not list (read via the designer Latest endpoint), w4 in
 * no UI list (unlisted). Run 1 asserts the tags, the default Live filter,
 * the live-only totals and the template note. Run 2 flips the fake AMP into
 * "failing list" mode and asserts every step reads Unknown. Screenshots go to
 * notes/demo/p14/ (git-ignored, light and dark). Only synthetic fake-AMP jwts.
 * Run: npm run e2e:mcp-kind
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startFakeAmp, TOKENS } from './fake-amp';
import { scanMcpOutputs } from './leak-scan';

const PORT = 4607;
const UI = `http://127.0.0.1:${PORT}`;
const ROOT = process.cwd();
const OUTPUT_DIR = join(ROOT, 'output');
const SHOTS = join(ROOT, 'notes', 'demo', 'p14');
const SHOTS15 = join(ROOT, 'notes', 'demo', 'p15');
const JWT_ADMIN = TOKENS.site_admin.jwt;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function currentRun(base: string): Promise<{ id: string; status: string } | null> {
  const r = (await (await fetch(`${base}/api/mcp/runs/current?from=0`)).json()) as { run: { id: string; status: string } | null };
  return r.run;
}

async function waitNextRunDone(base: string, beforeId: string | null, timeoutMs = 90000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const run = await currentRun(base);
    if (run && run.id !== beforeId && run.status !== 'running') return;
    if (Date.now() - t0 > timeoutMs) throw new Error('next MCP run did not finish in time');
    await wait(500);
  }
}

async function main(): Promise<number> {
  const failures: string[] = [];
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(SHOTS15, { recursive: true });
  const { server: amp, baseUrl: ampUrl } = await startFakeAmp();
  let ui: ChildProcess | null = null;
  let uiOut = '';
  const browser = await chromium.launch();
  try {
    ui = spawn(process.execPath, ['--import', 'tsx', 'src/app/server.ts', '--no-open'], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ui.stdout?.on('data', (d) => { uiOut += d; });
    ui.stderr?.on('data', (d) => { uiOut += d; });
    for (let i = 0; i < 100 && !uiOut.includes('running at'); i++) await wait(100);
    if (!uiOut.includes('running at')) throw new Error(`UI server did not start:\n${uiOut}`);

    const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, acceptDownloads: true });
    page.on('pageerror', (err) => failures.push(`page script error: ${err.message}`));
    const shot = (name: string, full = false) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: full });
    // textContent (not innerText): rows inside closed groups still count.
    const viewText = () => page.evaluate(() => document.getElementById('view')?.textContent ?? '');
    const bodyText = () => page.evaluate(() => document.body.innerText);
    const tabs = async (): Promise<string[]> => (await page.locator('#tabs button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());

    await page.goto(`${UI}/mcp`);
    await page.fill('#env-url', ampUrl);
    await page.click('#next-1');
    await page.fill('#key-1', 'admin');
    await page.fill('#jwt-1', JWT_ADMIN);
    await page.click('#btn-check');
    await page.waitForFunction(() => (document.getElementById('users-msg')?.textContent ?? '').length > 0);
    await page.click('#next-2');
    await page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').length > 0);
    await page.click('#opt-wf');
    await page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').includes('3 workflows'));
    await page.click('#next-3');
    await page.click('#btn-run');
    await waitNextRunDone(UI, null);
    await page.waitForFunction(() => (document.getElementById('summary')?.textContent ?? '').length > 0, null, { timeout: 60000 });

    // The stage list shows the extra read in plain words.
    const stages = await page.evaluate(() => document.getElementById('stlist')?.innerText ?? '');
    if (!stages.includes('lists read')) failures.push(`stage list does not show the extra read: ${stages.slice(0, 200)}`);
    const logText = await page.evaluate(() => document.getElementById('log')?.innerText ?? '');
    if (!logText.includes('Read 8 workflow lists')) failures.push(`log does not show the 8 list reads: ${logText.slice(0, 200)}`);

    // Nodes tab badge counts live steps only.
    const t1 = await tabs();
    if (!t1.some((t) => /^Workflow nodes\s*3$/.test(t))) failures.push(`nodes tab badge should count 3 live steps: ${t1.join(' | ')}`);

    await page.click('[data-tab="nodes"]');
    // Default filter is Live: only WF Orders steps show, tagged Live.
    let vt = await viewText();
    for (const want of ['WF Orders', 'Live', 'missing_tool']) {
      if (!vt.includes(want)) failures.push(`default Live view missing: ${want}`);
    }
    for (const hidden of ['WF Support', 'Template Zoho', 'WF Archive']) {
      if (vt.includes(hidden)) failures.push(`default Live view should hide ${hidden}`);
    }
    // Filter chips with counts.
    for (const want of ['Live 3', 'Draft only 2', 'Template 2', 'Not in lists 1']) {
      if (!vt.includes(want)) failures.push(`kind chip missing: ${want}`);
    }
    // Live-only headlines plus the template notes.
    const body1 = await bodyText();
    if (!body1.includes('1 live step calls a missing tool')) failures.push('live-only missing-tool headline missing');
    if (!body1.includes('1 template step also calls a missing tool, not counted above')) failures.push('template note missing');
    if (!body1.includes('1 live step may be missing required arguments')) failures.push('live-only argument headline missing');
    if (!body1.includes('1 template step may also be missing required arguments, not counted above')) failures.push('template argument note missing');
    await shot('1-nodes-live');

    // Template filter: the shared template read through the designer endpoint.
    await page.click('[data-kind="template"]');
    vt = await viewText();
    if (!vt.includes('Template Zoho') || !vt.includes('template_gone') || !vt.includes('Template')) {
      failures.push(`template filter wrong: ${vt.slice(0, 200)}`);
    }
    // Draft filter.
    await page.click('[data-kind="draft"]');
    vt = await viewText();
    if (!vt.includes('WF Support') || !vt.includes('Draft only')) failures.push(`draft filter wrong: ${vt.slice(0, 200)}`);
    // Unlisted filter: plain wording, not an error.
    await page.click('[data-kind="unlisted"]');
    vt = await viewText();
    if (!vt.includes('WF Archive') || !vt.includes('Not in lists')) failures.push(`unlisted filter wrong: ${vt.slice(0, 200)}`);
    const bodyU = await bodyText();
    if (!bodyU.includes('Not in this account')) failures.push('unlisted explanation missing the account wording');
    // All: everything including the run-time step.
    await page.click('[data-kind="ALL"]');
    vt = await viewText();
    for (const want of ['WF Orders', 'WF Support', 'Template Zoho', 'WF Archive', 'run time', 'Missing required: query']) {
      if (!vt.includes(want)) failures.push(`All view missing: ${want}`);
    }
    await shot('2-nodes-all', true);
    // Dark mode.
    await page.click('#theme');
    await wait(300);
    await shot('3-nodes-dark', true);
    await page.click('#theme');
    await wait(300);

    // CSV carries the kind.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-csv')]);
    const csvPath = join(SHOTS, 'kinds.csv');
    await dl.saveAs(csvPath);
    const csv = readFileSync(csvPath, 'utf8');
    for (const want of ['Kind', 'Live', 'Template', 'Draft only', 'Not in lists', 'Argument check', 'Missing required: query']) {
      if (!csv.includes(want)) failures.push(`CSV missing kind/argument column/word: ${want}`);
    }

    // Combined tab merges kinds with Live first.
    await page.click('[data-acct="combined"]');
    await page.click('[data-tab="nodes"]');
    const combined = await viewText();
    if (!combined.includes('WF Orders') || !combined.includes('Live')) failures.push('combined tab missing the live step');

    // P15 screenshots (fake AMP only): a service-account failure row, then a
    // step carrying the argument note.
    const shot15 = (name: string, full = false) => page.screenshot({ path: join(SHOTS15, `${name}.png`), fullPage: full });
    await page.click('[data-acct="admin"]');
    await page.click('[data-tab="servers"]');
    const serversView = await viewText();
    if (!serversView.includes('Service account refused')) failures.push('service-account failure row missing on servers tab');
    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#view tr.row'));
      const target = rows.find((r) => (r.textContent ?? '').includes('ServiceAcct'));
      target?.scrollIntoView({ block: 'center' });
    });
    await shot15('1-svc-row');
    await page.click('[data-tab="nodes"]');
    await page.click('[data-kind="ALL"]');
    await shot15('3-arg-note', true);

    // Run 2: the lists fail -> every step reads Unknown and the run says so.
    await fetch(`${ampUrl}/test/kinds-fail`, { method: 'POST', body: JSON.stringify({ fail: true }) });
    try {
      await page.click('[data-acct="admin"]');
      await page.click('#btn-again');
      await page.fill('#key-1', 'admin');
      await page.fill('#jwt-1', JWT_ADMIN);
      await page.click('#next-2');
      // Step first, then plan text: plan-words still holds run 1's text until
      // the token check passes (stale-text race).
      await page.waitForSelector('#step-3:not([hidden])', { timeout: 20000 });
      await page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').length > 0);
      await page.click('#opt-wf');
      await page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').includes('3 workflows'));
      await page.click('#next-3');
      const beforeId = (await currentRun(UI))?.id ?? null;
      await page.click('#btn-run');
      await waitNextRunDone(UI, beforeId);
      await page.waitForFunction(() => (document.getElementById('summary')?.textContent ?? '').length > 0, null, { timeout: 60000 });
      await page.click('[data-tab="nodes"]');
      const unknownView = await viewText();
      if (!unknownView.includes('Unknown 6')) failures.push(`failing list should label all 6 steps Unknown: ${unknownView.slice(0, 200)}`);
      const log2 = await page.evaluate(() => document.getElementById('log')?.innerText ?? '');
      if (!log2.includes('lists could not be read')) failures.push('failing-list run does not say so in the log');
    } finally {
      await fetch(`${ampUrl}/test/kinds-fail`, { method: 'POST', body: JSON.stringify({ fail: false }) });
    }

    const hits = scanMcpOutputs(OUTPUT_DIR, [JWT_ADMIN]);
    if (hits.length) failures.push(`leak-scan hits: ${hits.join('; ')}`);
    await page.close();
  } catch (e) {
    failures.push(`test crashed: ${(e as Error).message}`);
  } finally {
    await browser.close();
    ui?.kill();
    amp.close();
  }
  if (uiOut.includes(JWT_ADMIN)) failures.push('jwt found in the server log');
  if (failures.length) {
    console.error(`mcp-kind-e2e FAILURES:\n- ${failures.join('\n- ')}`);
    return 1;
  }
  console.log('mcp-kind-e2e: all checks passed (tags, Live default, live-only totals, unknown on failure)');
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
