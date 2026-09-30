/**
 * Drives the tester web UI in a real browser against the fake AMP, like a tester would.
 * Run: npm run e2e:ui   (optional: SHOT=<path.png> to save a screenshot of the finished UI)
 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { scanForSecrets } from './leak-scan';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { received, startFakeAmp, TOKENS } from './fake-amp';

const PORT = 4599;
const UI = `http://127.0.0.1:${PORT}`;

async function main(): Promise<number> {
  const { server: amp, baseUrl } = await startFakeAmp();
  const ui = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts', '--no-open'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let uiOut = '';
  ui.stdout.on('data', (d) => (uiOut += d));
  ui.stderr.on('data', (d) => (uiOut += d));

  const failures: string[] = [];
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 100 && !uiOut.includes('running at'); i++) await new Promise((r) => setTimeout(r, 100));
    if (!uiOut.includes('running at')) throw new Error(`UI server did not start:\n${uiOut}`);

    // API refuses calls that don't come from the UI.
    const noHeader = await fetch(`${UI}/api/tokens/check`, { method: 'POST', body: '{}' });
    if (noHeader.status !== 403) failures.push(`API without UI header returned ${noHeader.status}, expected 403`);

    // DNS-rebinding guard: a request carrying another site's Host header is refused, even for reports.
    const rebound = await new Promise<number>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port: PORT, path: '/api/runs', headers: { Host: `evil.example:${PORT}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on('error', reject);
      r.end();
    });
    if (rebound !== 403) failures.push(`request with foreign Host header returned ${rebound}, expected 403`);

    // Security headers on the tool page.
    const home = await fetch(UI + '/');
    for (const [h, want] of [['x-frame-options', 'DENY'], ['referrer-policy', 'no-referrer'], ['content-security-policy', "connect-src 'self'"]] as const) {
      if (!(home.headers.get(h) ?? '').includes(want)) failures.push(`missing security header ${h}: ${home.headers.get(h)}`);
    }

    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.on('pageerror', (err) => failures.push(`UI script error: ${err.message}`));
    const shot = async (name: string) => {
      if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, `${name}.png`), fullPage: true });
    };
    const runAndWait = async () => {
      await page.click('#btn-run');
      await page.waitForFunction(
        () => !document.getElementById('step-5')!.hidden && /Finished|stopped|cancelled/i.test(document.getElementById('run-msg')?.textContent ?? ''),
        null,
        { timeout: 120000 },
      );
      return (await page.textContent('#run-msg')) ?? '';
    };
    const fillUser = async (key: string, jwt: string) => {
      const box = `.user[data-key="${key}"] .u-jwt`;
      // Type, then confirm the box holds exactly this value (retry if the rows were redrawn mid-typing).
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.fill(box, jwt);
        if ((await page.inputValue(box)) === jwt) return;
        await page.waitForTimeout(200);
      }
      throw new Error(`could not type the jwt into the ${key} row`);
    };

    // Welcome → Start
    await page.goto(UI);
    await page.waitForSelector('#btn-start');
    await shot('1-welcome');
    await page.click('#btn-start');

    // Step 1: environment (Next is refused without a valid URL)
    await page.fill('#env-url', 'not a url');
    await page.click('#next-1');
    await page.waitForSelector('#env-msg .msg.bad');
    await page.fill('#env-name', 'fake');
    await page.fill('#env-url', baseUrl);
    await shot('2-environment');
    await page.click('#next-1');

    // Step 2: rulebook upload
    await page.setInputFiles('#rb-file', 'tests/e2e/rulebook.csv');
    await page.waitForSelector('#rb-msg .msg.ok', { timeout: 10000 });
    const detected = await page.locator('.col-user').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    if (detected.join() !== 'site_admin,partner_sales,reviewed') failures.push(`detected user types: ${detected.join()}`);
    const rbText = (await page.textContent('#step-2')) ?? '';
    if (!/row 2; the title row/.test(rbText) || !/Owner\s*ignored — not Yes\/No values/.test(rbText)) failures.push(`rulebook step text: ${rbText.slice(0, 400)}`);
    await page.uncheck('.col-user[value="reviewed"]');
    await shot('3-rulebook');
    await page.click('#next-2');

    // Step 3: tokens; Next checks them automatically
    for (const [key, t] of Object.entries(TOKENS)) await fillUser(key, t.jwt);
    await page.click('#btn-check');
    await page.waitForSelector('#users-msg .msg.ok', { timeout: 10000 });
    const names = await page.locator('#users .uname').allTextContents();
    if (names.join('|') !== 'Site Admin|Partner Sales') failures.push(`rows should be the sheet's column names, got: ${names.join('|')}`);
    const who = await page.textContent('#st-partner_sales');
    if (!who?.includes('Pat Partner')) failures.push(`token check did not show partner identity: ${who}`);
    await shot('4-users');
    await page.click('#next-3');

    // Step 4: plan shown automatically, then run
    await page.waitForSelector('#step-4:not([hidden]) #plan-msg .msg', { timeout: 10000 });
    await page.click('#adv summary');
    await page.fill('#opt-delay', '200');
    await shot('5-run');
    const result = await runAndWait();
    await shot('6-results');
    if (!result.includes('failures found')) failures.push(`unexpected run result: ${result}`);
    if (!result.includes('4 failed')) failures.push(`expected 4 failures in summary: ${result}`);

    const href = await page.getAttribute('#btn-report', 'href');
    if (!href) failures.push('no report link');
    else {
      const rep = await fetch(UI + href);
      const html = await rep.text();
      if (rep.status !== 200 || !html.includes('Security gap')) failures.push(`report not served correctly (${rep.status})`);
    }

    // Second run: Test again → only one user type, no reference Site Admin.
    await page.click('#btn-again');
    await fillUser('site_admin', '');
    await page.click('#next-3');
    await page.waitForFunction(() => /Only one user type/.test(document.getElementById('plan-msg')?.textContent ?? ''), null, { timeout: 10000 });
    const single = await runAndWait();
    if (!single.includes('3 failed')) failures.push(`single-user run without reference: expected 3 failures, got: ${single}`);
    const singleHref = await page.getAttribute('#btn-report', 'href');
    const singleHtml = singleHref ? await (await fetch(UI + singleHref)).text() : '';
    if (!singleHtml.includes('Only one user type was tested')) failures.push('single-user report is missing the one-user-type warning');

    // Third run: only the Site Admin (no rulebook column for it → expected to see every page).
    await page.click('#btn-again');
    await fillUser('partner_sales', '');
    await fillUser('site_admin', TOKENS.site_admin.jwt);
    await page.click('#next-3');
    await page.waitForFunction(() => /Only one user type/.test(document.getElementById('plan-msg')?.textContent ?? ''), null, { timeout: 10000 });
    const adminOnly = await runAndWait();
    if (!adminOnly.includes('no failures, 1 to review') || !adminOnly.includes('0 failed')) failures.push(`site-admin-only run: ${adminOnly}`);

    // Pasting a whole cookie pair is cleaned to the bare jwt; "Clear jwts" empties every box.
    await page.click('#btn-again');
    await page.fill('.user[data-key="partner_sales"] .u-jwt', `jwt=${TOKENS.partner_sales.jwt}; X-CSRF-Token=abc`);
    const cleaned = await page.inputValue('.user[data-key="partner_sales"] .u-jwt');
    if (cleaned !== TOKENS.partner_sales.jwt) failures.push(`pasted cookie pair was not cleaned: ${cleaned.slice(0, 12)}…`);
    await page.click('#btn-clear');
    const left = await page.locator('#users .u-jwt').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(''));
    if (left !== '') failures.push('Clear jwts left values in the boxes');
    const pwFields = await page.locator('input[type=password]').count();
    if (pwFields !== 0) failures.push('jwt boxes are password fields (password managers may offer to save them)');

    // Past runs screen lists all three.
    await page.click('#go-history');
    await page.waitForFunction(() => document.querySelectorAll('#history a').length >= 3, null, { timeout: 10000 });
    await shot('7-history');

    // Tokens must not be persisted by the UI.
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    if (stored.includes(TOKENS.partner_sales.jwt) || stored.includes(TOKENS.site_admin.jwt)) failures.push('SAFETY: token found in browser storage');

    // Page scripts in the tested browser never saw the jwt cookie (HttpOnly).
    if (received.some((r) => r.path === '/leak-probe')) failures.push('SAFETY: a page script could read the jwt cookie');

    // No raw jwt anywhere in what the tool wrote or printed.
    const runDirs = readdirSync('output').filter((d) => d.startsWith('fake-')).map((d) => join('output', d));
    const hits = scanForSecrets([...runDirs, join('output', '_ui')], [TOKENS.site_admin.jwt, TOKENS.partner_sales.jwt], { 'server terminal output': uiOut });
    if (runDirs.length === 0) failures.push('leak scan found no run folders to scan');
    failures.push(...hits.map((h) => `SAFETY LEAK: ${h}`));
  } catch (e) {
    failures.push(String(e).split('\n')[0]!);
    const p = browser.contexts()[0]?.pages()[0];
    if (p) {
      failures.push(`at: ${await p.evaluate(() => Array.from(document.querySelectorAll('.panel:not([hidden]) h2, .panel:not([hidden]) .msg')).map((e) => e.textContent?.trim()).join(' | '))}`);
      if (process.env.SHOT_DIR) await p.screenshot({ path: join(process.env.SHOT_DIR, 'failure.png'), fullPage: true });
    }
  } finally {
    await browser.close();
    ui.kill();
    amp.close();
    // Remove the run folders this test created.
    for (const d of readdirSync('output')) if (d.startsWith('fake-')) rmSync(join('output', d), { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`UI E2E FAILED:\n  ${failures.join('\n  ')}\n--- server output ---\n${uiOut}`);
    return 1;
  }
  if (process.env.SHOW_SERVER_LOG) console.log(`--- server terminal output ---\n${uiOut}--- end ---`);
  console.log('UI E2E PASSED: tester flow works end to end (environment → rulebook upload → tokens → run → report).');
  return 0;
}

main().then((c) => process.exit(c), (e) => {
  console.error(e);
  process.exit(1);
});
