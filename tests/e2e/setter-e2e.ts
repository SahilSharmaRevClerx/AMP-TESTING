/**
 * End-to-end check of the Permission Setter against a fake AMP role editor: preview, apply (with the
 * role reopened to confirm), the check as the user, and the AI review against a fake Gemini API.
 * Run: npm run e2e:setter
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rulebookFromRows } from '../../src/rulebook/parse';
import { makeCredentials } from '../../src/config';
import { executeSetter } from '../../src/setter/run';
import { navSettings, navWrites, resetRoles, roles, saves, SETTER_TOKENS, startFakeGemini, startFakeRolesAmp } from './fake-amp-roles';

const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  if (!ok) failures.push(what);
  console.log(`${ok ? '✓' : '✗'} ${what}`);
};

const amp = await startFakeRolesAmp();
const gemini = await startFakeGemini();
process.env.GEMINI_BASE_URL = gemini.baseUrl;
process.env.GEMINI_API_KEY = 'fake-gemini-key-for-tests';
delete process.env.GOOGLE_API_KEY;
delete process.env.GEMINI_MODEL;
const root = mkdtempSync(join(tmpdir(), 'setter-e2e-'));

const rulebook = rulebookFromRows([
  ['page', 'name', 'Super Admin', 'User', 'Other'],
  [`${amp.baseUrl}/#collateral/internal-playbook`, 'Internal Playbook', 'Yes', 'Yes', 'No'],
  [`${amp.baseUrl}/#manage/opportunity-records`, 'Opportunities', 'Yes', 'No', 'Yes'],
  [`${amp.baseUrl}/#dashboard/sales`, 'Sales Dashboard', 'Yes', 'Yes', 'Yes'],
  [`${amp.baseUrl}/#connections/contacts`, 'Manage Contacts', 'Yes', 'No', 'Yes'],
]);
const environment = { name: 'fake', baseUrl: amp.baseUrl, isProduction: false };
const lines: string[] = [];
const base = {
  environment,
  rulebook,
  rulebookName: 'fake.csv',
  roles: { user: 'Ayush Normal', other: 'Other Role' } as Record<string, string>,
  headless: process.env.HEADED !== '1',
  stepDelayMs: 150,
  // Navigation Layout: "Other" is Anmol (by email); "User" is identified from their jwt (Ayushmaan).
  navigation: { enabled: true, hints: { other: 'anmol.sethi@revclerx.com' } },
  outputRoot: join(root, '_setter'),
  log: (l: string) => {
    lines.push(l);
    if (process.env.VERBOSE) console.log(l);
  },
};

try {
  // 1. Preview: sliders move on screen, nothing saved.
  resetRoles();
  // In the preview nobody's jwt is pasted: the tester types the User's email instead.
  const preview = await executeSetter({ ...base, navigation: { enabled: true, hints: { user: 'ayushmaan@revclerx.com', other: 'anmol.sethi@revclerx.com' } }, creds: makeCredentials(SETTER_TOKENS.superAdmin), apply: false });
  const pr = preview.roles[0];
  check(!preview.error && pr?.status === 'previewed', `preview finished as "previewed" (${preview.error ?? pr?.status})`);
  check(saves.length === 0 && roles[0]!.media['16777216'] === 0, 'preview saved nothing (SaveRole blocked)');
  check(navWrites.length === 0 && navSettings[4]!.display === 'all', 'preview changed no Navigation Layout setting');
  check(preview.nav?.modules[0]?.status === 'planned' && preview.nav.modules[0].moduleName === 'Contacts', `preview planned the Contacts change (${preview.nav?.modules[0]?.status ?? preview.nav?.error})`);
  check(pr?.shots.length === 2 && pr.shots.every((x) => existsSync(join(preview.outDir, x.file))), `2 full-tab screenshots in the preview (${pr?.shots.map((x) => x.label).join(', ')})`);

  // 2. Apply + check as the user + AI review.
  resetRoles();
  const out = await executeSetter({
    ...base,
    creds: makeCredentials(SETTER_TOKENS.superAdmin),
    apply: true,
    ai: true,
    verify: { creds: new Map([['user', makeCredentials(SETTER_TOKENS.user)]]), outputDir: root, debugDir: join(root, 'debug'), rulebookSource: { name: 'fake.csv', data: Buffer.from('') }, waitSec: 0, navCacheSec: 0 },
  });
  const r = out.roles[0]!;
  check(!out.error, `apply run had no error (${out.error ?? 'ok'})`);
  check(r.status === 'saved', `role saved and confirmed after reopening (${r.status} ${r.error ?? ''})`);
  check(saves.length === 2, `one SaveRole call per role (${saves.length})`);
  check(roles[0]!.media['16777216'] === 1, 'Playbooks saved at View (Internal Playbook = Yes)');
  check(roles[0]!.system['1700'] === 0, 'Opportunity saved at NA (Opportunities = No)');
  check(roles[0]!.media['32'] === 1, 'unrelated sliders untouched');
  const second = out.roles[1];
  check(second?.status === 'saved', `second role opened and saved after the first (${second?.status} ${second?.error ?? ''})`);
  check(roles[1]!.system['1700'] === 1 && roles[1]!.media['16777216'] === 0, 'second role: Opportunity at View, Playbooks left at NA');
  check(r.controls.filter((c) => c.changed).every((c) => c.savedAs === c.after), 'every change read back from the reopened role');
  check(r.shots.length === 2 && r.shots.every((x) => existsSync(join(out.outDir, x.file))), `2 full-tab screenshots of the saved role (${r.shots.map((x) => x.label).join(', ')})`);
  const html = readFileSync(out.reportFile!, 'utf8');
  check(/✓ Done/.test(html) && (html.match(/✓ Matches/g) ?? []).length >= 2 && /Can't be set with role sliders|Page not found/.test(html), 'report says Done, 2 pages match, dashboard flagged');
  check(/nothing to set/.test(r.pages.find((p) => p.label === 'Sales Dashboard')?.reason ?? ''), 'Sales Dashboard (Yes) reported as nothing to set');

  const uc = r.userCheck?.pages ?? [];
  check(uc.length === 4, `checked all 4 rulebook pages as the user (${uc.length})`);
  const contactsNav = navSettings[4]!;
  check(contactsNav.display === 'specific' && [...contactsNav.links].sort().join() === '1,3', `Contacts shown only to sahil + Anmol (${contactsNav.display}: ${[...contactsNav.links].join(',')})`);
  check(out.nav?.modules[0]?.status === 'done', `Navigation Layout change confirmed (${out.nav?.modules[0]?.status} ${out.nav?.modules[0]?.note ?? ''})`);
  check(uc.find((p) => p.label === 'Manage Contacts')?.verdict === 'PASS', 'as the user: Manage Contacts now blocked (PASS)');
  check(r.pages.find((p) => p.label === 'Manage Contacts')?.nav === true, 'Manage Contacts marked as handled by Navigation Layout');
  check(out.nav?.modules[0]?.shot && existsSync(join(out.outDir, out.nav.modules[0].shot)), 'screenshot of the Contacts settings');
  check(uc.find((p) => p.label === 'Internal Playbook')?.verdict === 'PASS', 'as the user: Internal Playbook opens (PASS)');
  check(uc.find((p) => p.label === 'Opportunities')?.verdict === 'PASS', 'as the user: Opportunities blocked (PASS)');
  check(out.verify?.reportUrl && existsSync(join(root, out.verify.runId, 'report.html')), 'page-test report written for the user check');

  check(r.ai?.verdict === 'pass', `AI review stored (${r.ai?.verdict ?? r.aiError})`);
  const call = gemini.requests[0];
  const sent = call?.body;
  const images = sent?.contents?.[0]?.parts.filter((p) => p.inlineData).length ?? 0;
  check(gemini.requests.length === 2 && /models\/gemini-2\.5-pro:generateContent/.test(call?.path ?? ''), `one Gemini generateContent request per role (${call?.path})`);
  check(call?.key === 'fake-gemini-key-for-tests', 'Gemini key sent as the API key header');
  check(images === 6, `screenshots sent for review (${images} images: 2 role tabs + 4 user pages)`);
  check(!JSON.stringify(sent).includes(SETTER_TOKENS.superAdmin) && !JSON.stringify(sent).includes(SETTER_TOKENS.user), 'no jwt in the AI request');
  check(out.reportFile && existsSync(out.reportFile), 'setter report written');

  // 3. Every-slider mode on the other role.
  resetRoles();
  const bulk = await executeSetter({ ...base, rulebook: null, roles: {}, bulk: { roleName: 'Other Role', step: 1 }, creds: makeCredentials(SETTER_TOKENS.superAdmin), apply: true });
  const other = roles[1]!;
  check(bulk.roles[0]?.status === 'saved', `every-slider mode saved (${bulk.roles[0]?.status} ${bulk.roles[0]?.error ?? ''})`);
  check(other.media['32'] === 1 && other.media['16777216'] === 1 && other.system['100'] === 1 && other.system['1700'] === 1, 'every visible slider at View');
  check(other.system['600'] === 4, 'hidden Contacts row left alone');

  // 4. A jwt that is not a Super Admin is refused before any browser opens.
  const notAdmin = await executeSetter({ ...base, creds: makeCredentials(SETTER_TOKENS.user), apply: true });
  check(/not a Super Admin/.test(notAdmin.error ?? ''), 'a normal user jwt is refused as the Super Admin');
} catch (e) {
  failures.push(`crashed: ${(e as Error).stack}`);
  console.log(lines.slice(-30).join('\n'));
} finally {
  amp.server.close();
  gemini.server.close();
  if (!process.env.KEEP) rmSync(root, { recursive: true, force: true });
  else console.log(`output kept in ${root}: ${readdirSync(root).join(', ')}`);
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nPermission Setter e2e: all checks passed');
