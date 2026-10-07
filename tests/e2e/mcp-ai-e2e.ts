/**
 * MCP AI triage e2e (P11 T5). Real server + fake AMP + real page, with Gemini
 * replaced by a loopback stub: the server gets GEMINI_BASE_URL pointing at the
 * stub and a dummy key that never leaves loopback. NO real network, NO real key.
 * Asserts: the stubbed prompt carries none of the jwts, AI notes reach the
 * page, toggle-off runs have no notes, key-missing refuses ai:true with a
 * plain message, and leak-scan over output/_mcp passes.
 * Run: npm run e2e:mcp-ai
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { startFakeAmp, TOKENS } from './fake-amp';
import { scanMcpOutputs } from './leak-scan';

const JWT_ADMIN = TOKENS.site_admin.jwt;
const JWT_PARTNER = TOKENS.partner_sales.jwt;
const DUMMY_KEY = 'stub-dummy-gemini-key-0123456789';
const ROOT = process.cwd();
const OUTPUT_DIR = join(ROOT, 'output');

const prompts: string[] = [];

function startGeminiStub(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { contents?: { parts?: { text?: string }[] }[] };
        const text = parsed.contents?.map((c) => (c.parts ?? []).map((p) => p.text ?? '').join('\n')).join('\n') ?? body;
        prompts.push(text);
      } catch {
        prompts.push(body);
      }
      const text = [...prompts.join('\n').matchAll(/- id: (\S+)/g)].map((m) => m[1]);
      const seen = [...new Set(text)].slice(-20);
      const notes = seen.map((id) => ({ id, diagnosis: `Stub note for ${id}.`, nextStep: 'Reconnect and rerun.', confidence: 'medium' }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(notes) }], role: 'model' }, finishReason: 'STOP' }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function startServer(port: number, extraEnv: Record<string, string> = {}): Promise<{ ui: ChildProcess; out: () => string; base: string }> {
  const ui = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts', '--no-open'], {
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let uiOut = '';
  ui.stdout?.on('data', (d) => (uiOut += d));
  ui.stderr?.on('data', (d) => (uiOut += d));
  for (let i = 0; i < 300 && !uiOut.includes('running at'); i++) await new Promise((r) => setTimeout(r, 100));
  if (!uiOut.includes('running at')) throw new Error(`server did not start on :${port}:\n${uiOut.slice(0, 2000)}`);
  return { ui, out: () => uiOut, base: `http://127.0.0.1:${port}` };
}

async function currentRun(base: string) {
  const r = (await (await fetch(`${base}/api/mcp/runs/current?from=0`)).json()) as { run: { id: string; status: string } | null };
  return r.run;
}

async function waitNextRunDone(base: string, beforeId: string | null): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const run = await currentRun(base);
    if (run && run.id !== beforeId && run.status !== 'running') return;
    if (Date.now() - t0 > 90000) throw new Error('run did not finish in time');
    await new Promise((ok) => setTimeout(ok, 500));
  }
}

async function main(): Promise<number> {
  const failures: string[] = [];
  const { server: amp, baseUrl: ampUrl } = await startFakeAmp();
  const { server: gemini, baseUrl: geminiUrl } = await startGeminiStub();
  const browser = await chromium.launch();
  let keyed: { ui: ChildProcess; out: () => string; base: string } | null = null;
  let plain: { ui: ChildProcess; out: () => string; base: string } | null = null;
  let slow: { ui: ChildProcess; out: () => string; base: string } | null = null;
  let hang: Server | null = null;
  try {
    keyed = await startServer(4603, { GEMINI_API_KEY: DUMMY_KEY, GEMINI_BASE_URL: geminiUrl });
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    page.on('pageerror', (err) => failures.push(`page script error: ${err.message}`));
    try {
      await page.goto(`${keyed.base}/mcp`);
      await page.fill('#env-url', ampUrl);
      await page.click('#next-1');
      await page.fill('#key-1', 'admin');
      await page.fill('#jwt-1', JWT_ADMIN);
      await page.click('#btn-add');
      await page.fill('#key-2', 'default');
      await page.fill('#jwt-2', JWT_PARTNER);
      await page.click('#btn-check');
      await page.waitForFunction(() => (document.getElementById('users-msg')?.textContent ?? '').length > 0);
      await page.click('#next-2');
      await page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').length > 0);
      const aiHelp = (await page.evaluate(() => document.getElementById('ai-help')?.textContent ?? '')) as string;
      if (!aiHelp.includes('Google')) failures.push(`plan AI help missing Google note: ${aiHelp}`);
      const toggleDisabled = (await page.evaluate(() => (document.getElementById('opt-ai') as HTMLInputElement)?.disabled)) as boolean;
      if (toggleDisabled) failures.push('AI toggle disabled even though the key is set');
      await page.click('#next-3');
      // Run 1: toggle ON.
      await page.evaluate(() => ((document.getElementById('opt-ai') as HTMLInputElement).checked = true));
      await page.click('#btn-run');
      await waitNextRunDone(keyed.base, null);
      await page.waitForFunction(() => (document.getElementById('summary')?.textContent ?? '').length > 0, null, { timeout: 60000 });
      await page.evaluate(() => {
        const first = document.querySelector('tr.row') as HTMLElement | null;
        if (first) first.click();
      });
      await page.waitForFunction(() => (document.querySelector('tr.exp') ? 1 : 0), null, { timeout: 15000 }).catch(() => undefined);
      const expText = (await page.evaluate(() => document.querySelector('tr.exp')?.textContent ?? '')) as string;
      if (!expText.includes('AI note') || !expText.includes('check before acting')) {
        failures.push(`AI note missing in expanded row: ${expText.slice(0, 160)}`);
      }
      // Run 2: toggle OFF — no AI notes anywhere.
      await page.click('#btn-again');
      await page.fill('#key-1', 'admin');
      await page.fill('#jwt-1', JWT_ADMIN);
      await page.fill('#jwt-2', JWT_PARTNER);
      await page.click('#next-2');
      await page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').length > 0);
      await page.click('#next-3');
      const beforeId = (await currentRun(keyed.base))?.id ?? null;
      await page.evaluate(() => ((document.getElementById('opt-ai') as HTMLInputElement).checked = false)); // really OFF for this run
      await page.click('#btn-run');
      await waitNextRunDone(keyed.base, beforeId);
      await page.waitForFunction(() => !document.getElementById('step-5')?.hidden, null, { timeout: 60000 }); // the results step is on screen
      const noAi = (await page.evaluate(() => document.body.innerText)) as string;
      if (noAi.includes('AI note')) failures.push(`AI note shown on a toggle-off run: ...${noAi.slice(Math.max(0, noAi.indexOf('AI note') - 100), noAi.indexOf('AI note') + 100).replace(/s+/g, ' ')}...`);
    } finally {
      await page.close();
    }

    // Key missing: blank the inherited key vars (values never read) so the
    // server reports unavailable and refuses ai:true before any run.
    plain = await startServer(4604, { GEMINI_API_KEY: '', GOOGLE_API_KEY: '' });
    const plan = (await (await fetch(`${plain.base}/api/mcp/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Amp-Ui': '1' },
      body: JSON.stringify({ environment: { name: 'fake', baseUrl: ampUrl, isProduction: false }, users: [{ key: 'admin', jwt: JWT_ADMIN }] }),
    })).json()) as { ai?: { available?: boolean } };
    if (plan.ai?.available !== false) failures.push(`plan without key should report ai unavailable: ${JSON.stringify(plan.ai)}`);
    const refused = await fetch(`${plain.base}/api/mcp/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Amp-Ui': '1' },
      body: JSON.stringify({ environment: { name: 'fake', baseUrl: ampUrl, isProduction: false }, users: [{ key: 'admin', jwt: JWT_ADMIN }], ai: true }),
    });
    if (refused.status !== 400) failures.push(`ai:true without key -> ${refused.status}, want 400`);
    const refusedBody = (await refused.json()) as { error?: string };
    if (!/GEMINI_API_KEY/.test(refusedBody.error ?? '')) failures.push(`refusal is not plain/helpful: ${refusedBody.error}`);

    // The stubbed prompt carries DATA-RULE fields only — never the jwts.
    if (!prompts.length) failures.push('Gemini stub received no prompt');
    const allPrompts = prompts.join('\n');
    for (const jwt of [JWT_ADMIN, JWT_PARTNER, DUMMY_KEY]) {
      if (allPrompts.includes(jwt)) failures.push('secret material in Gemini prompt');
    }
    for (const want of ['Dead MCP', 'missing_tool', 'good_tool']) {
      if (!allPrompts.includes(want)) failures.push(`prompt missing DATA-RULE field: ${want}`);
    }
    const hits = scanMcpOutputs(OUTPUT_DIR, [JWT_ADMIN, JWT_PARTNER, DUMMY_KEY]);
    if (hits.length) failures.push(`leak-scan hits: ${hits.join('; ')}`);

    // Cancel while the AI triage is in flight: a Gemini stub that never answers; Cancel must end the run as
    // 'cancelled' within seconds (not wait for the 60 s triage timeout), and nothing is saved as a finished run.
    let hangHits = 0;
    hang = createServer((req) => {
      req.on('data', () => {});
      req.on('end', () => {
        hangHits += 1; // never responds
      });
    });
    await new Promise<void>((ok) => hang!.listen(0, '127.0.0.1', () => ok()));
    const hangUrl = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
    slow = await startServer(4605, { GEMINI_API_KEY: DUMMY_KEY, GEMINI_BASE_URL: hangUrl });
    const hdr = { 'Content-Type': 'application/json', 'X-Amp-Ui': '1' };
    const started = await fetch(`${slow.base}/api/mcp/runs`, {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ environment: { name: 'fake', baseUrl: ampUrl, isProduction: false }, users: [{ key: 'admin', jwt: JWT_ADMIN }], ai: true }),
    });
    if (started.status !== 202) failures.push(`cancel scenario: run did not start (${started.status})`);
    const runId = ((await started.json()) as { run?: { id?: string } }).run?.id ?? '';
    const t0 = Date.now();
    while (hangHits === 0 && Date.now() - t0 < 60000) await new Promise((ok) => setTimeout(ok, 200));
    if (hangHits === 0) failures.push('cancel scenario: triage never reached Gemini');
    // While Gemini is thinking the page must not look stuck: the server reports an explicit AI stage + batch text.
    const during = ((await (await fetch(`${slow.base}/api/mcp/runs/current?from=0`)).json()) as { run?: { stage?: string; ai?: boolean; stageLabel?: string; current?: string } }).run;
    if (during?.stage !== 'ai' || during?.ai !== true) failures.push(`AI step not visible while running: ${JSON.stringify(during)}`);
    if (!/batch \d+ of \d+/.test(during?.current ?? '')) failures.push(`AI step shows no batch progress: ${during?.current}`);
    const tCancel = Date.now();
    await fetch(`${slow.base}/api/mcp/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', headers: hdr, body: '{}' });
    let status = 'running';
    while (status === 'running' && Date.now() - tCancel < 8000) {
      status = ((await (await fetch(`${slow.base}/api/mcp/runs/current?from=0`)).json()) as { run?: { status?: string } }).run?.status ?? 'none';
      if (status === 'running') await new Promise((ok) => setTimeout(ok, 200));
    }
    if (status !== 'cancelled') failures.push(`cancel during AI triage: status ${status}, want cancelled within 8 s`);
    if (existsSync(join(OUTPUT_DIR, '_mcp', runId, 'result.json'))) failures.push('cancelled run must not be saved as a finished result');
  } finally {
    slow?.ui.kill();
    hang?.close();
    await browser.close();
    keyed?.ui.kill();
    plain?.ui.kill();
    gemini.close();
    amp.close();
  }
  if (failures.length) {
    console.error(`mcp-ai-e2e FAILURES:\n- ${failures.join('\n- ')}`);
    return 1;
  }
  console.log('mcp-ai-e2e: all checks passed (stubbed Gemini, no real key/network)');
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
