/**
 * Permission Setter → Pages Testing hand-off, through the real server: Apply in the setter with a
 * user jwt, then "Verify in Pages Testing" opens the page test filled in and runs it with the jwt
 * kept in server memory (never sent back to the page).
 * Run: npm run e2e:handoff
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { resetRoles, roles, SETTER_TOKENS, startFakeRolesAmp } from './fake-amp-roles';

const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (!ok) failures.push(what);
  console.log(`${ok ? '✓' : '✗'} ${what}`);
};

const PORT = 4590 + Math.floor(Math.random() * 8);
const BASE = `http://127.0.0.1:${PORT}`;
const amp = await startFakeRolesAmp();
resetRoles();
const server = spawn(process.execPath, ['--import', 'tsx', 'src/app/server.ts', '--no-open'], { env: { ...process.env, PORT: String(PORT), GEMINI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', (d) => (serverOut += d));
server.stderr.on('data', (d) => (serverOut += d));

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Amp-Ui': '1' }, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json as any;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 60; i++) {
    if (await fetch(BASE + '/').then((r) => r.ok).catch(() => false)) break;
    await sleep(500);
  }
  const environment = { name: 'fake', baseUrl: amp.baseUrl };
  const csv = ['page,name,User', `${amp.baseUrl}/#collateral/internal-playbook,Internal Playbook,Yes`, `${amp.baseUrl}/#manage/opportunity-records,Opportunities,No`].join('\n');
  const rb = await api('POST', '/api/rulebooks/parse', { name: 'handoff.csv', contentBase64: Buffer.from(csv).toString('base64') });

  // 1. Apply in the setter, with the user's jwt for the check.
  await api('POST', '/api/setter/runs', { environment, rulebookId: rb.id, jwt: SETTER_TOKENS.superAdmin, roles: { user: 'Ayush Normal' }, users: { user: SETTER_TOKENS.user }, apply: true, stepDelaySec: 0.5 });
  let run: any;
  for (let i = 0; i < 240; i++) {
    run = (await api('GET', '/api/setter/runs/current')).run;
    if (run.status !== 'running') break;
    await sleep(500);
  }
  check(run.status === 'done', `setter apply finished (${run.status} ${run.outcome?.error ?? ''})`);
  check(roles[0]!.media['16777216'] === 1 && roles[0]!.system['1700'] === 0, 'role saved in the fake AMP');
  const hid = run.outcome?.handoffId;
  check(!!hid, 'setter result offers a hand-off to Pages Testing');

  // 2. The hand-off says what to verify, but never contains a jwt.
  const h = await api('GET', `/api/handoff/${hid}`);
  check(h.rulebook?.id === rb.id && h.columns?.join() === 'user' && h.jwtFor?.join() === 'user', 'hand-off has the rulebook, column and "jwt kept" flag');
  const raw = JSON.stringify(h);
  check(!raw.includes(SETTER_TOKENS.user) && !raw.includes(SETTER_TOKENS.superAdmin), 'hand-off response contains no jwt');

  // 3. The Pages wizard opens on Run, filled in, and verifies with the kept jwt.
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Like a tester who used Pages Testing before: it remembers their last rulebook and loads it on open.
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.setItem('amp-rulebook', JSON.stringify('main-dvl.csv')));
  await page.goto(`${BASE}/pages?handoff=${hid}`);
  await page.waitForTimeout(2500); // let the remembered rulebook finish loading (it must not replace the hand-off)
  await page.waitForSelector('#step-4:not([hidden])', { timeout: 15000 });
  check(page.url() === `${BASE}/pages`, 'hand-off id removed from the address bar');
  check((await page.inputValue('#env-url')) === amp.baseUrl, 'site filled in');
  check(/Ready to verify the Permission Setter run/.test(await page.textContent('#run-err') ?? ''), 'Run step says it verifies the setter run');
  check(!(await page.content()).includes(SETTER_TOKENS.user), 'the page never holds the user jwt');
  check((await page.textContent('#rb-msg'))?.includes('handoff.csv'), 'the setter rulebook is kept (not replaced by the remembered one)');
  check(await page.isChecked('#users .user[data-key="user"] .u-test'), 'the user row is ticked with the kept jwt');
  await page.click('#btn-run');
  await page.waitForSelector('#step-5:not([hidden])', { timeout: 120000 });
  const result = (await page.textContent('#run-msg')) ?? '';
  check(/everything matches the rulebook/i.test(result), `page test passed with the kept jwt (${result.slice(0, 80).trim()})`);
  check(!errors.length, `no script errors (${errors.join('; ')})`);
  await browser.close();

  // 4. An unknown or expired hand-off is refused, and a run with it fails cleanly.
  const bad = await fetch(`${BASE}/api/handoff/nope`, { headers: { 'X-Amp-Ui': '1' } });
  check(bad.status === 404, 'unknown hand-off refused');
  check(!serverOut.includes(SETTER_TOKENS.user) && !serverOut.includes(SETTER_TOKENS.superAdmin), 'no jwt in the server log');
} catch (e) {
  failures.push(`crashed: ${(e as Error).stack}`);
  console.log(serverOut.split('\n').slice(-25).join('\n'));
} finally {
  server.kill();
  amp.server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nHand-off e2e: all checks passed');
