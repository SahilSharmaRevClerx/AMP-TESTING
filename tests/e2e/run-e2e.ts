/**
 * End-to-end check of the whole pipeline (real headless browser) against the fake AMP.
 * Run: npm run e2e
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandRun } from '../../src/run';
import { setLogLevel } from '../../src/util/logger';

if (!process.env.LOG_LEVEL) setLogLevel('warn');
import { received, startFakeAmp, TOKENS } from './fake-amp';
import { scanForSecrets } from './leak-scan';

const expected: Record<string, string> = {
  'setup/roles': 'PASS',
  'setup/users/list': 'FAIL_SECURITY_GAP',
  'setup/brand': 'FAIL_MISSING_ACCESS',
  'setup/leadrouting': 'PASS',
  'connections/contacts': 'PASS',
  'report/assets': 'FAIL_OPENS_EMPTY',
  'manage/mdf/funds': 'PASS',
};

async function main(): Promise<number> {
  const { server, baseUrl } = await startFakeAmp();
  const outputDir = join('output', `e2e-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
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
      headless: true,
      outputDir,
    }),
  );
  process.env.AMP_JWT_SITE_ADMIN = TOKENS.site_admin.jwt;
  process.env.AMP_JWT_PARTNER_SALES = TOKENS.partner_sales.jwt;

  const failures: string[] = [];
  try {
    const code = await commandRun({ configFile, only: ['partner_sales'] });
    if (code !== 2) failures.push(`exit code ${code}, expected 2 (failures present)`);

    const runDir = readdirSync(outputDir, { withFileTypes: true }).find((d) => d.isDirectory())!.name;
    const data = JSON.parse(readFileSync(join(outputDir, runDir, 'results.json'), 'utf8')) as {
      results: { route: string; label: string; type: string; verdict: string; reason: string }[];
    };
    const byRoute = new Map(data.results.map((r) => [r.route, r]));
    for (const [route, v] of Object.entries(expected)) {
      const got = byRoute.get(route);
      if (got?.verdict !== v) failures.push(`#${route}: expected ${v}, got ${got?.verdict} (${got?.reason})`);
    }
    if (data.results.length !== Object.keys(expected).length) failures.push(`expected ${Object.keys(expected).length} results, got ${data.results.length}`);

    // Safety: the page's write API must never reach the server, and must be in the audit log as blocked.
    if (received.some((r) => r.func === 'savelastviewed')) failures.push('SAFETY: savelastviewed reached the server');
    const audit = readFileSync(join(outputDir, runDir, 'audit.jsonl'), 'utf8');
    if (!/savelastviewed.*"decision":"blocked"/.test(audit)) failures.push('SAFETY: blocked write not recorded in audit log');
    if (audit.includes(TOKENS.partner_sales.jwt) || audit.includes(TOKENS.site_admin.jwt)) failures.push('SAFETY: raw token found in audit log');
    for (const h of scanForSecrets([outputDir], [TOKENS.site_admin.jwt, TOKENS.partner_sales.jwt])) failures.push(`SAFETY LEAK: ${h}`);
    if (received.some((r) => r.path === '/leak-probe')) failures.push('SAFETY: a page script could read the jwt cookie');
    const nonGetNonApi = received.filter((r) => r.method !== 'GET' && r.path !== '/services/api.ashx');
    if (nonGetNonApi.length) failures.push(`SAFETY: unexpected non-GET requests: ${JSON.stringify(nonGetNonApi)}`);
  } finally {
    server.close();
  }

  if (failures.length) {
    console.error(`\nE2E FAILED:\n  ${failures.join('\n  ')}`);
    return 1;
  }
  console.log('\nE2E PASSED: every scenario got the expected verdict and safety checks held.');
  return 0;
}

main().then((c) => process.exit(c), (e) => {
  console.error(e);
  process.exit(1);
});
