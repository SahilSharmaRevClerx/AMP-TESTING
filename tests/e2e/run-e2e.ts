/**
 * End-to-end check of the whole pipeline (real headless browser) against the fake AMP.
 * Run: npm run e2e
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandRun } from '../../src/modules/pages/run';
import { setLogLevel } from '../../src/core/util/logger';

if (!process.env.LOG_LEVEL) setLogLevel('warn');
import { PARTNER_SUB_LINK, received, startFakeAmp, TOKENS } from './fake-amp';
import { scanForSecrets } from './leak-scan';

const expected: Record<string, string> = {
  'setup/roles': 'PASS',
  'setup/users/list': 'FAIL_SECURITY_GAP',
  'setup/brand': 'FAIL_MISSING_ACCESS',
  'setup/leadrouting': 'PASS',
  'connections/contacts': 'PASS',
  'report/assets': 'FAIL_OPENS_EMPTY',
  'manage/mdf/funds': 'PASS',
  'setup/customdeny': 'PASS',
  'insights/dashboard': 'PASS', // different widgets per user
  'setup/blankno': 'PASS', // blank + rulebook No
  'setup/blankyes': 'FAIL_MISSING_ACCESS', // blank for partner while the admin gets it
  'setup/errorbox': 'PASS', // error box + rulebook No
  'manage/nonono': 'PASS', // No No No
  'setup/broken': 'REVIEW', // renders for nobody
  'connections/slowlist': 'PASS', // slow page + spinner + empty list ("No Data Found") = usable
  'insights/widgets': 'PASS', // one widget says "no permission", the page itself opened
  'setup/rolez': 'REVIEW', // mistyped link (No/No): AMP's 404 screen for everyone → never a Pass
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
      parallelUsers: Number(process.env.PARALLEL ?? 3),
      headless: true,
      outputDir,
      debugShots: true,
      debugDir: join(outputDir, 'debug'),
    }),
  );
  process.env.AMP_JWT_SITE_ADMIN = TOKENS.site_admin.jwt;
  process.env.AMP_JWT_PARTNER_SALES = TOKENS.partner_sales.jwt;

  const failures: string[] = [];
  try {
    const code = await commandRun({ configFile });
    if (code !== 2) failures.push(`exit code ${code}, expected 2 (failures present)`);

    const runDir = readdirSync(outputDir, { withFileTypes: true }).find((d) => d.isDirectory() && d.name !== 'debug')!.name;
    const data = JSON.parse(readFileSync(join(outputDir, runDir, 'results.json'), 'utf8')) as {
      meta: { warnings: string[] };
      results: { route: string; label: string; type: string; userType: string; verdict: string; reason: string; inMenu: boolean }[];
    };
    const byRoute = new Map(data.results.filter((r) => r.userType === 'partner_sales').map((r) => [r.route, r]));
    // The admin should get every page except the one that is broken for everyone and the mistyped link.
    for (const r of data.results.filter((x) => x.userType === 'site_admin')) {
      const want = r.route === 'setup/broken' || r.route === 'setup/rolez' ? 'REVIEW' : 'PASS';
      if (r.verdict !== want) failures.push(`admin #${r.route}: expected ${want}, got ${r.verdict} (${r.reason})`);
    }
    for (const [route, v] of Object.entries(expected)) {
      const got = byRoute.get(route);
      if (got?.verdict !== v) failures.push(`#${route}: expected ${v}, got ${got?.verdict} (${got?.reason})`);
    }
    if (data.results.length !== Object.keys(expected).length * 2) failures.push(`expected ${Object.keys(expected).length * 2} results, got ${data.results.length}`);

    if (!data.meta.warnings.some((w) => /don't exist on this site/.test(w) && w.includes('#setup/rolez'))) failures.push(`no "link doesn't exist" warning for #setup/rolez: ${data.meta.warnings.join(' | ')}`);

    // Menu: only a page under #setup/roles (PARTNER_SUB_LINK) is in the partner's menu → "not in menu".
    if (byRoute.get('setup/roles')?.inMenu !== false) failures.push(`#setup/roles: only ${PARTNER_SUB_LINK} is in the partner's menu, must be "not in menu"`);
    if (data.results.find((r) => r.userType === 'site_admin' && r.route === 'setup/roles')?.inMenu !== true) failures.push('admin #setup/roles: the page itself is in the menu');

    // Debug folder: debug/<date_time_site>/<user>/<NN-page>/ with step shots, the final shot and decision.txt.
    const debugRoot = join(outputDir, 'debug');
    const debugRuns = readdirSync(debugRoot);
    if (debugRuns.length !== 1 || !/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_127-0-0-1-\d+$/.test(debugRuns[0] ?? '')) failures.push(`debug run folder name: ${debugRuns.join(', ')}`);
    const debugRun = join(debugRoot, debugRuns[0] ?? '');
    for (const u of ['site-admin', 'partner-sales']) {
      const pageDirs = readdirSync(join(debugRun, u)).filter((d) => /^\d{2}-/.test(d));
      if (pageDirs.length !== Object.keys(expected).length + 1) failures.push(`debug ${u}: expected ${Object.keys(expected).length} pages + frame-only, got ${pageDirs.length}`);
      for (const d of pageDirs.filter((x) => x !== '00-frame-only')) {
        const files = readdirSync(join(debugRun, u, d));
        if (!files.includes('decision.txt') || !files.some((f) => f.startsWith('final-')) || !files.some((f) => /^01-at-/.test(f))) failures.push(`debug ${u}/${d}: missing files (${files.join(', ')})`);
      }
    }
    const slow = readFileSync(join(debugRun, 'partner-sales', readdirSync(join(debugRun, 'partner-sales')).find((d) => d.endsWith('connections-slowlist'))!, 'decision.txt'), 'utf8');
    if (!/VERDICT:\s+PASS/.test(slow) || !/No Data Found/.test(slow) || !/loaded after/.test(slow)) failures.push(`slow list decision.txt not as expected:\n${slow}`);

    // Safety: the page's write API must never reach the server, and must be in the audit log as blocked.
    if (received.some((r) => r.func === 'savelastviewed')) failures.push('SAFETY: savelastviewed reached the server');
    const audit = readFileSync(join(outputDir, runDir, 'audit.jsonl'), 'utf8');
    if (!/savelastviewed.*"decision":"blocked"/.test(audit)) failures.push('SAFETY: blocked write not recorded in audit log');
    if (audit.includes(TOKENS.partner_sales.jwt) || audit.includes(TOKENS.site_admin.jwt)) failures.push('SAFETY: raw token found in audit log');
    // Parallel users: the two users' page loads must overlap in time (separate browsers at the same time).
    const pageHits = (u: string) => received.filter((x) => x.user === u && x.method === 'GET' && /^\/(setup|connections|report|manage|insights)\//.test(x.path)).map((x) => x.at);
    const [a, p] = [pageHits('admin'), pageHits('partner')];
    const overlap = a.length && p.length && Math.min(Math.max(...a), Math.max(...p)) > Math.max(Math.min(...a), Math.min(...p));
    if (!overlap) failures.push('users did not run in parallel (page loads did not overlap)');
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
