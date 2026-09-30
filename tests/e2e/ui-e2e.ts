/**
 * Drives the tester web UI in a real browser against the fake AMP, like a tester would.
 * Run: npm run e2e:ui   (optional: SHOT=<path.png> to save a screenshot of the finished UI)
 */
import { spawn } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startFakeAmp, TOKENS } from './fake-amp';

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

    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(UI);
    await page.fill('#env-name', 'fake');
    await page.fill('#env-url', baseUrl);
    await page.setInputFiles('#rb-file', 'tests/e2e/rulebook.csv');
    await page.waitForSelector('#rb-msg .msg.ok', { timeout: 10000 });

    for (const [key, t] of Object.entries(TOKENS)) {
      await page.fill(`tr[data-key="${key}"] .u-jwt`, t.jwt);
      await page.fill(`tr[data-key="${key}"] .u-csrf`, t.csrf);
    }
    await page.click('#btn-check');
    await page.waitForSelector('#users-msg .msg.ok', { timeout: 10000 });
    const who = await page.textContent('#st-partner_sales');
    if (!who?.includes('Pat Partner')) failures.push(`token check did not show partner identity: ${who}`);

    await page.fill('#opt-delay', '200');
    await page.click('#btn-run');
    await page.waitForFunction(() => /Finished|stopped|cancelled/i.test(document.getElementById('run-msg')?.textContent ?? ''), null, { timeout: 120000 });
    const result = (await page.textContent('#run-msg')) ?? '';
    if (!result.includes('failures found')) failures.push(`unexpected run result: ${result}`);
    if (!result.includes('3 failed')) failures.push(`expected 3 failures in summary: ${result}`);

    const href = await page.getAttribute('#run-msg a', 'href');
    if (!href) failures.push('no report link');
    else {
      const rep = await fetch(UI + href);
      const html = await rep.text();
      if (rep.status !== 200 || !html.includes('Security gap')) failures.push(`report not served correctly (${rep.status})`);
    }

    await page.waitForSelector('#history a', { timeout: 5000 });

    // Second run: only one user type, no reference Site Admin.
    await page.fill('tr[data-key="site_admin"] .u-jwt', '');
    await page.fill('tr[data-key="site_admin"] .u-csrf', '');
    await page.click('#btn-plan');
    await page.waitForFunction(() => /No reference Site Admin/.test(document.getElementById('run-msg')?.textContent ?? ''), null, { timeout: 10000 });
    await page.click('#btn-run');
    await page.waitForFunction(
      () => document.querySelectorAll('#history a').length >= 2 && /Finished|stopped/.test(document.getElementById('run-msg')?.textContent ?? ''),
      null,
      { timeout: 120000 },
    );
    const single = (await page.textContent('#run-msg')) ?? '';
    if (!single.includes('3 failed')) failures.push(`single-user run without reference: expected 3 failures, got: ${single}`);
    const singleHref = await page.getAttribute('#run-msg a', 'href');
    const singleHtml = singleHref ? await (await fetch(UI + singleHref)).text() : '';
    if (!singleHtml.includes('No reference Site Admin was given')) failures.push('single-user report is missing the no-reference warning');

    // Third run: only the Site Admin (no rulebook column for it → expected to see every page).
    await page.fill('tr[data-key="partner_sales"] .u-jwt', '');
    await page.fill('tr[data-key="partner_sales"] .u-csrf', '');
    await page.fill('tr[data-key="site_admin"] .u-jwt', TOKENS.site_admin.jwt);
    await page.fill('tr[data-key="site_admin"] .u-csrf', TOKENS.site_admin.csrf);
    await page.click('#btn-plan');
    await page.waitForFunction(() => /expected to see every page/.test(document.getElementById('run-msg')?.textContent ?? ''), null, { timeout: 10000 });
    await page.click('#btn-run');
    await page.waitForFunction(
      () => document.querySelectorAll('#history a').length >= 3 && /Finished|stopped/.test(document.getElementById('run-msg')?.textContent ?? ''),
      null,
      { timeout: 120000 },
    );
    const adminOnly = (await page.textContent('#run-msg')) ?? '';
    if (!adminOnly.includes('everything matches') || !adminOnly.includes('0 failed')) failures.push(`site-admin-only run: ${adminOnly}`);

    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

    // Tokens must not be persisted by the UI.
    const stored = await page.evaluate(() => JSON.stringify(localStorage));
    if (stored.includes(TOKENS.partner_sales.jwt)) failures.push('SAFETY: token found in localStorage');
  } catch (e) {
    failures.push(String(e));
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
  console.log('UI E2E PASSED: tester flow works end to end (environment → rulebook upload → tokens → run → report).');
  return 0;
}

main().then((c) => process.exit(c), (e) => {
  console.error(e);
  process.exit(1);
});
