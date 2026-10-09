/**
 * MCP end to end (P10 T7): the REAL server against the fake AMP, driven
 * through the real page: Site -> Accounts -> Plan -> Run -> Results.
 * Asserts plain summary counts, the dead-host and wrong-tool rows, raw-answer
 * files that are scrubbed, "changes" on a second run, and no jwt anywhere
 * (storage, URL, output/_mcp, server log). Only synthetic fake-AMP jwts.
 * Run: npm run e2e:mcp-run
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startFakeAmp, TOKENS } from './fake-amp';
import { scanMcpOutputs } from './leak-scan';

const PORT = 4602;
const UI = `http://127.0.0.1:${PORT}`;
const ROOT = process.cwd();
const OUTPUT_DIR = join(ROOT, 'output');
const JWT_ADMIN = TOKENS.site_admin.jwt;
const JWT_PARTNER = TOKENS.partner_sales.jwt;

const ENUMS = ['UNKNOWN_ERROR', 'BROKEN', 'NEEDS_YOU', 'DEAD_HOST', 'TOOL_MISSING', 'KEY_REJECTED', 'NOT_CONNECTED', 'NOT_VISIBLE', 'OAUTH_EXPIRED', 'URL_404', 'REDIRECT', 'HTML_NOT_MCP', 'UNREACHABLE', 'RATE_LIMITED', 'FORBIDDEN', 'NO_TOOLS', 'API_ERROR', 'MISCONFIGURED', 'NOT_CHECKED', 'SERVER_'];

function rawFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name.endsWith('.json')) out.push(p);
    }
  };
  const walkRaw = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (!name.isDirectory()) continue;
      if (name.name === 'raw') walk(p);
      else walkRaw(p);
    }
  };
  walkRaw(join(OUTPUT_DIR, '_mcp'));
  return out;
}

async function currentRun(base: string): Promise<{ id: string; status: string } | null> {
  const r = (await (await fetch(`${base}/api/mcp/runs/current?from=0`)).json()) as { run: { id: string; status: string } | null };
  return r.run;
}

let lastSeenRun: { id: string; status: string } | null = null;
let SERVER_LOG = ''; // the UI server's output, printed if the test throws (helps with timing-dependent failures)
/** Waits until a NEW run (different id) appears and finishes. */
async function waitNextRunDone(base: string, beforeId: string | null, timeoutMs = 90000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const run = await currentRun(base);
    lastSeenRun = run;
    if (run && run.id !== beforeId && run.status !== 'running') return;
    if (Date.now() - t0 > timeoutMs) throw new Error('next MCP run did not finish in time; last seen run=' + JSON.stringify(lastSeenRun) + ' beforeId=' + beforeId);
    await new Promise((ok) => setTimeout(ok, 500));
  }
}

async function main(): Promise<number> {
  const failures: string[] = [];
  const { server: amp, baseUrl: ampUrl } = await startFakeAmp();
  let ui: ChildProcess | null = null;
  let uiOut = '';
  const browser = await chromium.launch();
  try {
    ui = spawn(process.execPath, ['--import', 'tsx', 'src/app/server.ts', '--no-open'], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ui.stdout?.on('data', (d) => { uiOut += d; SERVER_LOG += d; });
    ui.stderr?.on('data', (d) => { uiOut += d; SERVER_LOG += d; });
    for (let i = 0; i < 100 && !uiOut.includes('running at'); i++) await new Promise((r) => setTimeout(r, 100));
    if (!uiOut.includes('running at')) throw new Error(`UI server did not start:\n${uiOut}`);

    const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    page.on('pageerror', (err) => failures.push(`page script error: ${err.message}`));
    const netLog: string[] = [];
    page.on('response', (r) => { if (r.url().includes('/api/mcp/') && r.request().method() === 'POST') netLog.push(`${r.request().method()} ${r.url().split('/api/mcp')[1]} -> ${r.status()}`); });
    page.on('requestfailed', (r) => netLog.push(`FAILED ${r.url().split('/api/mcp')[1] ?? r.url()} ${r.failure()?.errorText ?? ''}`));
    // Records each account row (key and jwt length only, never the jwt) at a few points, printed if the first run is not what we filled in.
    const rowSnaps: string[] = [];
    const snapRows = async (label: string): Promise<void> => {
      const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.acct-row')).map((r) => ({
        id: r.id, key: (r.querySelector('[id^=key-]') as HTMLInputElement | null)?.value ?? null, jwtLen: (r.querySelector('[id^=jwt-]') as HTMLInputElement | null)?.value.length ?? null,
      })));
      rowSnaps.push(label + ' ' + JSON.stringify(rows));
    };
    await page.goto(`${UI}/mcp`);
    await page.fill('#env-url', ampUrl);
    await page.click('#next-1');
    await page.fill('#key-1', 'admin');
    await page.fill('#jwt-1', JWT_ADMIN);
    await page.click('#btn-add');
    await page.fill('#key-2', 'default');
    await page.fill('#jwt-2', JWT_PARTNER);
    await snapRows('after fills');
    await page.click('#btn-check');
    await page.waitForFunction(() => (document.getElementById('users-msg')?.textContent ?? '').length > 0);
    await page.click('#next-2');
    await page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').length > 0);
    // Workflow steps are an opt-in: the switch starts off and the plan says no workflow is read.
    const offWords = await page.evaluate(() => document.getElementById('plan-words')?.textContent ?? '');
    if (!offWords.includes('Workflows are not read') || offWords.includes('3 workflows')) failures.push(`plan should say workflows are not read by default: ${offWords}`);
    if (await page.locator('#opt-wf').isChecked()) failures.push('Also check workflow steps should start off');
    await page.click('#opt-wf');
    await page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').includes('3 workflows'));
    const planWords = await page.evaluate(() => document.getElementById('plan-words')?.textContent ?? '');
    if (!planWords.includes('3 workflows')) failures.push(`plan does not read 3 workflows: ${planWords}`);
    await page.click('#next-3');
    await snapRows('on Run step');
    // Run screen before Start: a preview of every stage, no spinner, Start visible and Cancel not.
    const idle = (await page.evaluate(() => ({
      stages: document.querySelectorAll('#stlist .st').length,
      next: document.querySelectorAll('#stlist .st.next').length,
      spinner: !!document.querySelector('#run-title .spin'),
      start: !document.getElementById('btn-run')?.hidden,
      cancel: !document.getElementById('btn-cancel')?.hidden,
    }))) as { stages: number; next: number; spinner: boolean; start: boolean; cancel: boolean };
    if (idle.stages < 4 || idle.next !== idle.stages) failures.push(`Run screen should preview every stage as upcoming: ${JSON.stringify(idle)}`);
    if (idle.spinner || !idle.start || idle.cancel) failures.push(`Run screen before Start has a spinner or the wrong buttons: ${JSON.stringify(idle)}`);
    await page.click('#btn-run');
    // Right after Start: the first stage is running at once; Start and Back are gone, Cancel is there (unless the run already finished).
    const going = (await page.evaluate(() => ({
      now: document.querySelectorAll('#stlist .st.now').length,
      start: !document.getElementById('btn-run')?.hidden,
      back: !document.getElementById('back-4')?.hidden,
      cancel: !document.getElementById('btn-cancel')?.hidden,
      resultsOpen: !document.getElementById('step-5')?.hidden,
    }))) as { now: number; start: boolean; back: boolean; cancel: boolean; resultsOpen: boolean };
    if (!going.resultsOpen && (going.now < 1 || going.start || going.back || !going.cancel)) failures.push(`Run screen right after Start is wrong: ${JSON.stringify(going)}`);
    await waitNextRunDone(UI, null);
    await page.waitForFunction(() => (document.getElementById('summary')?.textContent ?? '').length > 0, null, { timeout: 60000 });

    const bodyText = (await page.evaluate(() => document.body.innerText)) as string;
    for (const want of ['3 need a fix', 'Dead MCP', 'Key MCP', 'Service account refused', 'Who acts']) {
      if (!bodyText.includes(want)) failures.push(`missing expected text: ${want}`);
    }
    if (['3 need a fix', 'Dead MCP', 'Key MCP'].some((w) => !bodyText.includes(w))) {
      const d = (await page.evaluate(() => ({
        summary: document.getElementById('summary')?.textContent ?? '',
        meta: document.getElementById('meta')?.textContent ?? '',
        acct: Array.from(document.querySelectorAll('#acct .pill')).map((p) => (p.textContent ?? '') + (p.classList.contains('on') ? '*' : '')),
        rows: Array.from(document.querySelectorAll('#view tr.row td:first-child')).map((c) => (c.textContent ?? '').trim()),
        log: Array.from(document.querySelectorAll('#log .ll')).map((l) => l.textContent ?? '').slice(0, 14),
      }))) as Record<string, unknown>;
      failures.push('DIAG first-run page: ' + JSON.stringify(d) + ' rows: ' + rowSnaps.join(' | '));
    }
    for (const e of ENUMS) {
      if (bodyText.includes(e)) failures.push(`internal enum leaks onto the page: ${e}`);
    }
    // The log has an m:ss stamp on every line.
    const logInfo = (await page.evaluate(() => ({
      lines: document.querySelectorAll('#log .ll').length,
      stamped: document.querySelectorAll('#log .ll .ts').length,
    }))) as { lines: number; stamped: number };
    if (logInfo.lines < 4 || logInfo.stamped !== logInfo.lines) failures.push(`log lines should all carry a time stamp: ${JSON.stringify(logInfo)}`);
    // Servers tab: a Tools column; a healthy row opens to a tool list with its count.
    const heads = (await page.evaluate(() => Array.from(document.querySelectorAll('#view thead th')).map((h) => h.textContent ?? ''))) as string[];
    if (!heads.includes('Tools')) failures.push(`Servers table has no Tools column: ${heads.join(',')}`);
    await page.click('tr.row:has-text("Healthy MCP")');
    const opened = (await page.evaluate(() => ({
      block: !!document.querySelector('tr.exp .toolsblock'),
      names: Array.from(document.querySelectorAll('tr.exp .tr2 code')).map((c) => c.textContent),
      open: document.querySelector('tr.row.open .car')?.textContent,
    }))) as { block: boolean; names: string[]; open?: string };
    if (!opened.block || !opened.names.includes('good_tool') || opened.open !== '▾') failures.push(`expanded row should list good_tool under an open caret: ${JSON.stringify(opened)}`);
    // Tools tab: search finds the tool and names its connector.
    await page.click('[data-tab="tools"]');
    await page.fill('#q', 'good_tool');
    const found = (await page.evaluate(() => Array.from(document.querySelectorAll('#view .found')).map((f) => (f as HTMLElement).innerText))) as string[];
    if (!found.some((f) => f.includes('good_tool') && f.includes('Healthy MCP'))) failures.push(`tool search did not find good_tool on Healthy MCP: ${JSON.stringify(found)}`);
    await page.click('[data-tab="nodes"]');
    // The tab defaults to live steps only; the draft steps need the All filter.
    await page.click('[data-kind="ALL"]');
    const nodesText = (await page.evaluate(() => document.getElementById('view')?.innerText ?? '')) as string;
    for (const want of ['missing_tool', 'does not exist', 'run time']) {
      if (!nodesText.includes(want)) failures.push(`nodes tab missing: ${want}`);
    }

    // Raw-answer files exist for the non-working servers and hold no jwt.
    const raws = rawFiles();
    if (raws.length < 4) failures.push(`expected >=4 raw-answer files, found ${raws.length}`);
    const dead = raws.find((f) => f.endsWith('admin-6.json'));
    if (!dead) failures.push('missing raw-answer file admin-6.json (dead host)');
    else {
      const r = JSON.parse(readFileSync(dead, 'utf8'));
      if (r.state !== 'DEAD_HOST' || r.label !== 'admin' || typeof r.errorText !== 'string') {
        failures.push(`admin-6.json has wrong shape: ${JSON.stringify(r).slice(0, 160)}`);
      }
    }
    for (const f of raws) {
      if (readFileSync(f, 'utf8').includes(JWT_ADMIN) || readFileSync(f, 'utf8').includes(JWT_PARTNER)) {
        failures.push(`jwt in raw-answer file ${f}`);
      }
    }

    // Second run: the fixture lists one more tool on server 4, so "changes" shows.
    await page.click('[data-tab="servers"]');
    await page.click('#btn-again');
    await page.fill('#key-1', 'admin');
    await page.fill('#jwt-1', JWT_ADMIN);
    await page.fill('#jwt-2', JWT_PARTNER);
    await page.click('#next-2');
    try {
      await page.waitForSelector('#step-3:not([hidden])', { timeout: 20000 });
      await page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').length > 0);
      await page.click('#opt-wf');
      await page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').includes('3 workflows'));
      await page.click('#next-3', { timeout: 15000 });
    } catch (e) {
      const snap = await page.evaluate(() => ({
        visibleStep: ['1', '2', '3', '4', '5'].filter((n) => !document.getElementById('step-' + n)?.hidden),
        usersMsg: document.getElementById('users-msg')?.innerText ?? '',
        planMsg: document.getElementById('plan-msg')?.innerText ?? '',
        keys: Array.from(document.querySelectorAll('[id^=key-]')).map((i) => (i as HTMLInputElement).value),
        jwtsFilled: Array.from(document.querySelectorAll('[id^=jwt-]')).map((i) => (i as HTMLInputElement).value.length > 0),
      }));
      failures.push('second pass did not reach the Run step: ' + JSON.stringify(snap));
    }
    const beforeId = (await currentRun(UI))?.id ?? null;
    try {
      await page.click('#btn-run', { timeout: 15000 });
    } catch (e) {
      const snap = await page.evaluate(() => ({
        visibleStep: ['1', '2', '3', '4', '5'].filter((n) => !document.getElementById('step-' + n)?.hidden),
        btnRunHidden: document.getElementById('btn-run')?.hidden, btnRunDisabled: (document.getElementById('btn-run') as HTMLButtonElement | null)?.disabled,
        cancelHidden: document.getElementById('btn-cancel')?.hidden, backHidden: document.getElementById('back-4')?.hidden,
        bodyRunning: document.body.classList.contains('running'),
        title: document.getElementById('run-title')?.textContent ?? '', sub: document.getElementById('run-sub')?.textContent ?? '',
        stages: Array.from(document.querySelectorAll('#stlist .st')).map((s) => s.className),
        runErr: document.getElementById('run-err')?.innerText ?? '', logLines: document.querySelectorAll('#log .ll').length,
      }));
      const cur = await fetch(UI + '/api/mcp/runs/current?from=0').then((r) => r.json()).catch(() => null) as { run?: { id: string; status: string; stage: string } } | null;
      failures.push('second run: Start not clickable. page=' + JSON.stringify(snap) + ' server=' + JSON.stringify(cur?.run ? { id: cur.run.id, status: cur.run.status, stage: cur.run.stage, before: beforeId } : null));
    }
    await snapRows('before 2nd start');
    try {
      await waitNextRunDone(UI, beforeId, 45000);
    } catch (e) {
      const st = (await page.evaluate(() => ({
        visibleStep: ['1', '2', '3', '4', '5'].filter((n) => !document.getElementById('step-' + n)?.hidden),
        runErr: document.getElementById('run-err')?.innerText ?? '', title: document.getElementById('run-title')?.textContent ?? '',
        btnRunHidden: document.getElementById('btn-run')?.hidden, cancelHidden: document.getElementById('btn-cancel')?.hidden,
      }))) as Record<string, unknown>;
      failures.push('second run never started: ' + (e as Error).message.slice(0, 120) + ' | page=' + JSON.stringify(st) + ' | net=' + JSON.stringify(netLog) + ' | rows: ' + rowSnaps.join(' | '));
      throw new Error(failures.join(' || '));
    }
    try {
  await page.waitForFunction(() => ((document.getElementById('changes-banner')?.innerText ?? '').includes('changed') || (document.getElementById('changes-banner')?.innerText ?? '').includes('Nothing changed')), null, { timeout: 60000 });
    } catch (e) {
      const snap = await page.evaluate(() => ({
        step5Hidden: document.getElementById('step-5')?.hidden,
        step4Hidden: document.getElementById('step-4')?.hidden,
        banner: document.getElementById('changes-banner')?.innerText ?? '(none)',
        runErr: document.getElementById('run-err')?.innerText ?? '',
        title: document.getElementById('run-title')?.textContent ?? '',
        summary: document.getElementById('summary')?.textContent ?? '',
        acct: Array.from(document.querySelectorAll('#acct .pill')).map((p) => (p.textContent ?? '') + (p.classList.contains('on') ? '*' : '')),
        meta: document.getElementById('meta')?.textContent ?? '',
      }));
      const cur = await fetch(UI + '/api/mcp/runs/current?from=0').then((r) => r.json()).catch(() => null);
      failures.push('second run: no changes banner. page=' + JSON.stringify(snap) + ' server=' + JSON.stringify(cur && (cur as { run?: unknown }).run ? { status: ((cur as { run: { status: string } }).run).status } : cur));
    }
    const banner = (await page.evaluate(() => document.getElementById('changes-banner')?.innerText ?? '')) as string;
    if (!banner.includes('changed')) failures.push(`second run shows no changes banner: ${banner}`);

    // No jwt anywhere: storage, URL, outputs, server log.
    const stored = (await page.evaluate(() => JSON.stringify([Object.values({ ...localStorage }), Object.values({ ...sessionStorage })]))) as string;
    for (const jwt of [JWT_ADMIN, JWT_PARTNER]) {
      if (stored.includes(jwt)) failures.push('jwt found in web storage');
      if (page.url().includes(jwt)) failures.push('jwt found in the URL');
    }
    const hits = scanMcpOutputs(OUTPUT_DIR, [JWT_ADMIN, JWT_PARTNER]);
    if (hits.length) failures.push(`leak-scan hits: ${hits.join('; ')}`);
    await page.close();
  } finally {
    await browser.close();
    if (ui) ui.kill();
    amp.close();
  }
  if (uiOut.includes(JWT_ADMIN) || uiOut.includes(JWT_PARTNER)) failures.push('jwt found in the server log');
  if (failures.length) {
    console.error(`mcp-run-e2e FAILURES:\n- ${failures.join('\n- ')}`);
    return 1;
  }
  console.log('mcp-run-e2e: all checks passed (real server + fake AMP)');
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    console.error(['--- UI server log (last 60 lines) ---', ...SERVER_LOG.split(String.fromCharCode(10)).slice(-60)].join(String.fromCharCode(10)));
    process.exit(1);
  });
