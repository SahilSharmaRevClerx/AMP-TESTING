/**
 * MCP scope switch end to end: the REAL server against the fake AMP, through the real page.
 * Run 1 leaves "Also check workflow steps" off (the default): the fake AMP must receive NO workflow
 * request, the run has no workflow stage, and the results have no Workflow nodes tab.
 * Run 2 ticks the switch: workflows are read and the Workflow nodes tab appears.
 * Screenshots go to notes/demo/switch/ (git-ignored). Only synthetic fake-AMP jwts.
 * Run: npm run e2e:mcp-scope
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { received, startFakeAmp, TOKENS } from './fake-amp';

const PORT = 4606;
const UI = `http://127.0.0.1:${PORT}`;
const SHOTS = join(process.cwd(), 'notes', 'demo', 'switch');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isWorkflowRequest = (p: string): boolean => p.includes('/workflow-definitions');

async function main(): Promise<number> {
  const failures: string[] = [];
  mkdirSync(SHOTS, { recursive: true });
  const { server: amp, baseUrl } = await startFakeAmp();
  let ui: ChildProcess | null = null;
  let out = '';
  const browser = await chromium.launch();
  try {
    ui = spawn(process.execPath, ['--import', 'tsx', 'src/app/server.ts', '--no-open'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    ui.stdout?.on('data', (d) => { out += d; });
    ui.stderr?.on('data', (d) => { out += d; });
    for (let i = 0; i < 150 && !out.includes('running at'); i++) await wait(100);
    if (!out.includes('running at')) throw new Error(`UI server did not start:\n${out}`);

    const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const shot = (name: string, full = false) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: full });
    const planReady = () => page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').length > 0);
    const tabs = async (): Promise<string[]> => (await page.locator('#tabs button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    const runDone = () => page.waitForFunction(() => !document.getElementById('step-5')?.hidden && (document.getElementById('summary')?.textContent ?? '').length > 0, null, { timeout: 90000 });
    const signIn = async (): Promise<void> => {
      await page.fill('#key-1', 'admin');
      await page.fill('#jwt-1', TOKENS.site_admin.jwt);
      await page.click('#btn-check');
      await page.waitForFunction(() => /Logged in/.test(document.getElementById('who-1')?.textContent ?? ''));
    };

    // ---- run 1: connectors only (the default) ----
    await page.goto(`${UI}/mcp`);
    await page.fill('#env-url', baseUrl);
    await page.click('#next-1');
    await signIn();
    await page.click('#next-2');
    await planReady();
    if (await page.locator('#opt-wf').isChecked()) failures.push('the switch should start off');
    const offWords = await page.evaluate(() => document.getElementById('plan-words')?.textContent ?? '');
    if (!offWords.includes('Workflows are not read')) failures.push(`plan should say workflows are not read: ${offWords}`);
    const boxes = await page.evaluate(() => Array.from(document.querySelectorAll('#plan-sum .sbox .l')).map((l) => l.textContent ?? ''));
    if (boxes.includes('workflows')) failures.push(`plan should show no workflow count when off: ${boxes.join(',')}`);
    await shot('1-plan-switch-off');
    await page.click('#next-3');
    const stages = await page.evaluate(() => Array.from(document.querySelectorAll('#stlist .st')).map((s) => (s.textContent ?? '').replace(/\s+/g, ' ').trim()));
    if (stages.length !== 3 || stages.some((t) => /workflow/i.test(t))) failures.push(`connector-only run should preview 3 stages without workflows: ${JSON.stringify(stages)}`);
    const bar = await page.evaluate(() => document.getElementById('runbar')?.textContent ?? '');
    if (!bar.includes('Connectors only')) failures.push(`run bar should say Connectors only: ${bar}`);
    await shot('2-run-connectors-only');
    const before = received.length;
    await page.click('#btn-run');
    await runDone();
    const wfSeen = received.slice(before).filter((r) => isWorkflowRequest(r.path)).length;
    if (wfSeen !== 0) failures.push(`connector-only run sent ${wfSeen} workflow request(s) to AMP`);
    const connSeen = received.slice(before).filter((r) => r.func === 'getmcpservertools').length;
    if (connSeen < 1) failures.push('connector-only run did not ask AMP for any connector tool list');
    const t1 = await tabs();
    if (t1.some((t) => t.startsWith('Workflow nodes'))) failures.push(`Workflow nodes tab should be hidden: ${t1.join(' | ')}`);
    for (const want of ['Servers', 'Tools', 'Changes']) if (!t1.some((t) => t.startsWith(want))) failures.push(`missing tab ${want}: ${t1.join(' | ')}`);
    const meta1 = await page.evaluate(() => document.getElementById('meta')?.textContent ?? '');
    if (!meta1.includes('connector health only')) failures.push(`results subtitle should say connector health only: ${meta1}`);
    const text1 = await page.evaluate(() => document.body.innerText);
    if (!text1.includes('Dead MCP')) failures.push('connector-only results should still list the connectors');
    await shot('3-results-connectors-only', true);

    // ---- run 2: workflow steps on ----
    await page.click('#btn-again');
    await signIn();
    await page.click('#next-2');
    await page.waitForSelector('#step-3:not([hidden])');
    await planReady();
    if (await page.locator('#opt-wf').isChecked()) failures.push('the switch should be off again for a new run');
    await page.click('#opt-wf');
    await page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').includes('3 workflows'));
    await shot('4-plan-switch-on');
    await page.click('#next-3');
    const stagesOn = await page.evaluate(() => document.querySelectorAll('#stlist .st').length);
    if (stagesOn !== 4) failures.push(`run with workflows should preview 4 stages, got ${stagesOn}`);
    const before2 = received.length;
    await page.click('#btn-run');
    await runDone();
    const wfSeen2 = received.slice(before2).filter((r) => isWorkflowRequest(r.path)).length;
    if (wfSeen2 < 2) failures.push(`run with workflows should read the workflow list and graphs, saw ${wfSeen2} request(s)`);
    const t2 = await tabs();
    if (!t2.some((t) => t.startsWith('Workflow nodes'))) failures.push(`Workflow nodes tab should show when on: ${t2.join(' | ')}`);
    // The second run also read workflows, so connector #99 (only a workflow names it) is new to the page; it must not be reported as a change.
    await page.click('[data-tab="changes"]');
    const changeView = await page.evaluate(() => document.getElementById('view')?.innerText ?? '');
    if (changeView.includes('#99')) failures.push(`scope difference was reported as a connector change: ${changeView.slice(0, 200)}`);
    if (!changeView.includes('Healthy MCP')) failures.push(`the real change (a new tool on Healthy MCP) should still be listed: ${changeView.slice(0, 200)}`);
    await page.click('[data-tab="servers"]');
    await shot('5-results-with-workflow-steps', true);

    if (pageErrors.length) failures.push(`page script errors: ${pageErrors.join('; ')}`);
  } catch (e) {
    failures.push(`test crashed: ${(e as Error).message}\n--- server log (tail) ---\n${out.split('\n').slice(-25).join('\n')}`);
  } finally {
    await browser.close();
    ui?.kill();
    amp.close();
  }
  if (failures.length) {
    console.error('mcp-scope-e2e FAILED:\n- ' + failures.join('\n- '));
    return 1;
  }
  console.log('mcp-scope-e2e: all checks passed (connectors-only sends no workflow request; switch on reads them)');
  return 0;
}

main().then((c) => process.exit(c));
