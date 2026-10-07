/**
 * End-to-end check: when Chromium cannot start for any user, the run retries, then stops with a
 * plain "No pages were tested" error instead of writing a report where every page is Review.
 * Chromium is made unavailable by pointing Playwright at an empty browsers folder.
 * Run: npm run e2e:browser-start
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

async function main(): Promise<number> {
  const outputDir = join('output', `e2e-browser-start-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  // Must be set before Playwright is loaded: no Chromium can be found, so every start attempt fails.
  process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(outputDir, 'no-browsers-here');

  const { commandRun } = await import('../../src/run');
  const { setLogSink } = await import('../../src/util/logger');
  const { startFakeAmp, TOKENS } = await import('./fake-amp');
  const { START_ATTEMPTS } = await import('../../src/probe/launch');

  const lines: string[] = [];
  setLogSink((l) => void lines.push(l));
  const { server, baseUrl } = await startFakeAmp();
  const configFile = join(outputDir, 'config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      environment: { name: 'fake-amp', baseUrl, isProduction: false },
      rulebook: 'tests/e2e/rulebook.csv',
      shellPath: '/',
      calibrationUserType: 'site_admin',
      userTypes: { site_admin: { label: 'Site Admin' }, partner_sales: { label: 'Partner Sales' } },
      delayMs: 0,
      pageTimeoutMs: 5000,
      settleMs: 300,
      fingerprintThreshold: 0.6,
      parallelUsers: 2,
      headless: true,
      outputDir,
      debugShots: false,
    }),
  );
  process.env.AMP_JWT_SITE_ADMIN = TOKENS.site_admin.jwt;
  process.env.AMP_JWT_PARTNER_SALES = TOKENS.partner_sales.jwt;

  const failures: string[] = [];
  try {
    const code = await commandRun({ configFile });
    if (code !== 1) failures.push(`exit code ${code}, expected 1 (run stopped)`);

    const stopped = lines.find((l) => l.includes('run stopped'));
    if (!stopped?.includes('No pages were tested')) failures.push(`no "No pages were tested" stop reason in the log: ${stopped ?? '(none)'}`);
    if (!stopped?.includes(`after ${START_ATTEMPTS} attempts`)) failures.push('stop reason does not say how often it tried');

    const attempts = lines.filter((l) => l.includes('browser failed to start'));
    if (attempts.length !== START_ATTEMPTS * 2) failures.push(`expected ${START_ATTEMPTS} logged start attempts per user (${START_ATTEMPTS * 2}), got ${attempts.length}`);
    if (!attempts.every((l) => l.length > 120)) failures.push("start attempts are logged without Playwright's detail");

    const reports = readdirSync(outputDir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(outputDir, d.name, 'report.html')));
    if (reports.length) failures.push(`a report was written although nothing was tested: ${reports.map((d) => d.name).join(', ')}`);
  } finally {
    server.close();
  }

  setLogSink();
  if (failures.length) {
    console.error(`\nE2E FAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    return 1;
  }
  console.log('\nBrowser start e2e: retried, then stopped with a clear message and no all-Review report.');
  return 0;
}

main().then((c) => process.exit(c), (e) => {
  console.error(e);
  process.exit(1);
});
