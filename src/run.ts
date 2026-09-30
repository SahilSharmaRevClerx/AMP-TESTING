import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { credentialsFor, envKey, loadConfig, loadLocalEnv } from './config';
import { loadRulebook, selectUserTypes } from './rulebook/parse';
import { RequestGate } from './safety/gate';
import { describeIdentity, validateToken } from './sessions/validate';
import { fetchMenu, menuHasRoute } from './probe/menu';
import { BrowserProbe } from './probe/browser';
import { buildFrame, pickReference, type EvidenceByUser, type PageReference } from './verdict/fingerprint';
import { accessState, type StateResult } from './verdict/state';
import { pageVerdict, VERDICT_ORDER } from './verdict/compare';
import { writeReports } from './report/write';
import { AuditLog } from './util/audit';
import { slug } from './util/route';
import { scrub } from './util/mask';
import { createLogger, since } from './util/logger';
import type { CheckResult, Credentials, Expected, Identity, MenuResult, PageEvidence, Rule, Rulebook, RunConfig, Verdict } from './types';

export interface Progress {
  phase: 'tokens' | 'menus' | 'probe' | 'report';
  userType?: string;
  done: number;
  total: number;
}

export interface Reporter {
  log(message: string): void;
  progress?(p: Progress): void;
}

export interface RunInput {
  cfg: RunConfig;
  rulebook: Rulebook;
  /** Original rulebook file, copied into the run folder for traceability. */
  rulebookSource: { name: string; data: Buffer };
  creds: Map<string, Credentials>;
  only?: string[];
  limit?: number;
  signal?: AbortSignal;
  reporter?: Reporter;
  /** Extra notes shown as warnings in the report (e.g. assumptions made for this run). */
  notes?: string[];
}

export interface RunOutcome {
  /** 0 all pass, 2 failures found, 1 run error, 130 cancelled. */
  code: number;
  runId: string;
  outDir: string;
  reportFile?: string;
  error?: string;
  summary: Record<string, Partial<Record<Verdict, number>>>;
}

export interface Plan {
  pages: Rule[];
  testedTypes: string[];
  allTypes: string[];
  pageOpens: number;
  estimatedMinutes: number;
}

const consoleReporter: Reporter = { log: (m) => console.log(m) };
const log = createLogger('run');

export class CancelledError extends Error {
  constructor() {
    super('Run cancelled');
  }
}

/** Works out which user types and pages a run covers. Throws on mismatches. */
export function planRun(cfg: RunConfig, rulebook: Rulebook, only?: string[], limit?: number): Plan {
  const unknown = rulebook.userTypes.filter((ut) => !cfg.userTypes[ut]);
  if (unknown.length) throw new Error(`Rulebook columns without a configured user type: ${unknown.join(', ')}`);
  let testedTypes = rulebook.userTypes;
  if (only?.length) {
    const bad = only.filter((o) => !rulebook.userTypes.includes(o));
    if (bad.length) throw new Error(`${bad.join(', ')} not in rulebook columns (${rulebook.userTypes.join(', ')})`);
    testedTypes = only;
  }
  if (testedTypes.length === 0) throw new Error('Choose at least one user type to test');
  // Every tested user is also a candidate reference (per page, the one who sees the most), so no extra user is needed.
  const allTypes = [...testedTypes];
  let pages = rulebook.rules.filter((r) => r.type === 'page');
  if (limit && limit > 0) pages = pages.slice(0, limit);
  const pageOpens = pages.length * allTypes.length;
  const estimatedMinutes = Math.ceil((pageOpens * (cfg.settleMs + cfg.delayMs + 2500)) / 60000);
  return { pages, testedTypes, allTypes, pageOpens, estimatedMinutes };
}

export function newRunId(envName: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${slug(envName)}-${stamp}`;
}

/** Full run: tokens → menus → open pages as each user → per-page reference → verdicts → report. Used by CLI and web UI. */
export async function executeRun(input: RunInput, runId = newRunId(input.cfg.environment.name)): Promise<RunOutcome> {
  const { cfg, rulebook, creds, signal } = input;
  const r = input.reporter ?? consoleReporter;
  const outDir = join(cfg.outputDir, runId);
  const summary: RunOutcome['summary'] = {};
  const runStarted = Date.now();
  const fail = (error: string, code = 1): RunOutcome => {
    r.log(`\nStopping: ${error}`);
    if (code === 130) log.info('run cancelled', { run: runId, ms: since(runStarted) });
    else log.warn('run stopped', { run: runId, code, reason: error, ms: since(runStarted) });
    return { code, runId, outDir, error, summary };
  };
  const checkCancel = () => {
    if (signal?.aborted) throw new CancelledError();
  };

  try {
    const plan = planRun(cfg, rulebook, input.only, input.limit);
    const missing = plan.allTypes.filter((ut) => !creds.get(ut)?.jwt);
    if (missing.length) return fail(`missing tokens for: ${missing.join(', ')}`);

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `rulebook-${basename(input.rulebookSource.name)}`), input.rulebookSource.data);
    const audit = new AuditLog(join(outDir, 'audit.jsonl'));
    const gate = new RequestGate(cfg.environment, cfg.delayMs, audit);
    const startedAt = new Date().toISOString();
    const warnings: string[] = [...(input.notes ?? [])];
    r.log(`Run ${runId} on ${cfg.environment.name} (${cfg.environment.baseUrl})`);
    r.log(`User types: ${plan.testedTypes.join(', ')} · ${plan.pages.length} pages · ~${plan.estimatedMinutes} min`);
    log.info('run started', {
      run: runId,
      env: cfg.environment.name,
      baseUrl: cfg.environment.baseUrl,
      users: plan.testedTypes,
      pages: plan.pages.length,
      pageOpens: plan.pageOpens,
      estMin: plan.estimatedMinutes,
      headless: cfg.headless,
      delayMs: cfg.delayMs,
      threshold: cfg.fingerprintThreshold,
      out: outDir,
    });

    // ① Tokens
    r.log('\n① Token check');
    const identities: Identity[] = [];
    for (const [i, ut] of plan.allTypes.entries()) {
      checkCancel();
      const t0 = Date.now();
      const id = await validateToken(gate, ut, creds.get(ut)!);
      identities.push(id);
      r.log(`  ${ut.padEnd(24)} ${describeIdentity(id)}`);
      if (id.valid) {
        log.info('token ok', { user: ut, name: id.userName, persona: id.persona, siteAdmin: id.isSiteAdmin, org: id.organizationName, company: id.companyName, amp: id.ampVersion, ms: since(t0) });
      } else {
        log.warn('token invalid', { user: ut, reason: id.reason, ms: since(t0) });
      }
      r.progress?.({ phase: 'tokens', done: i + 1, total: plan.allTypes.length });
    }
    const invalid = identities.filter((i) => !i.valid);
    if (invalid.length) return fail(`${invalid.map((i) => i.userType).join(', ')} token(s) invalid. Log in again and paste fresh tokens.`);
    if (plan.testedTypes.length === 1) {
      warnings.push('Only one user type was tested, so each page was compared with that user\'s own view. AMP\'s no-access screen, "no access" messages, redirects and missing pages are still detected; test a higher-access user type too (e.g. a Super Admin) to also catch pages that open with unexpected content.');
    }

    // ② Menus
    r.log('\n② Menu read');
    const menus = new Map<string, MenuResult>();
    for (const [i, ut] of plan.allTypes.entries()) {
      checkCancel();
      const t0 = Date.now();
      const m = await fetchMenu(gate, ut, creds.get(ut)!, cfg.shellPath);
      r.log(`  ${ut.padEnd(24)} ${m.ok ? `${m.links.length} links` : `FAILED - ${m.reason}`}`);
      if (m.ok) {
        const covered = plan.pages.filter((p) => menuHasRoute(m, p.route)).length;
        log.info('menu read', { user: ut, links: m.links.length, rulebookPagesInMenu: `${covered}/${plan.pages.length}`, ms: since(t0) });
        log.debug('menu links', { user: ut, links: m.links.map((l) => l.link) });
      } else {
        log.warn('menu read failed', { user: ut, reason: m.reason, ms: since(t0) });
      }
      if (!m.ok) return fail(`menu could not be read for ${ut}: ${m.reason}`);
      menus.set(ut, m);
      r.progress?.({ phase: 'menus', done: i + 1, total: plan.allTypes.length });
    }

    // ③ Open every page as each user
    const byUser: EvidenceByUser = new Map();
    const baselines: PageEvidence[] = [];
    const failedUsers = new Map<string, string>();
    for (const ut of plan.testedTypes) {
      checkCancel();
      r.log(`\n③ ${ut} (${plan.pages.length} pages)`);
      const t0 = Date.now();
      const outcome = await probeAll(input, outDir, audit, ut, plan.pages, 'probe');
      if (typeof outcome === 'string') {
        log.warn('user could not be tested', { user: ut, reason: outcome });
        failedUsers.set(ut, outcome);
      } else {
        byUser.set(ut, outcome.pages);
        if (outcome.baseline) baselines.push(outcome.baseline);
        log.info('user pages opened', { user: ut, pages: outcome.pages.size, frameBaseline: !!outcome.baseline, ms: since(t0) });
      }
    }

    // ④ Decide each page: did each user get usable content? (Rulebook Yes/No says how to read "not usable".)
    r.log('\n④ Deciding');
    const frame = buildFrame(byUser, baselines);
    log.debug('AMP frame learned', { elements: frame.tokens.size, apis: [...frame.apis] });
    const states = new Map<string, Map<string, StateResult>>(); // route → user → state
    const references = new Map<string, PageReference>();
    for (const rule of plan.pages) {
      const expectedByUser: Record<string, Expected> = {};
      for (const ut of plan.testedTypes) expectedByUser[ut] = rule.expected[ut] ?? null;
      const ref = pickReference(rule.route, byUser, expectedByUser, frame);
      references.set(rule.route, ref);
      const perUser = new Map<string, StateResult>();
      for (const [ut, pages] of byUser) {
        const ev = pages.get(rule.route);
        if (ev) perUser.set(ut, accessState(ev, frame, ref));
      }
      states.set(rule.route, perUser);
      log.debug('page decided', { route: rule.route, reference: ref.referenceUser ?? 'none', states: Object.fromEntries([...perUser].map(([u, s]) => [u, s.state])) });
    }
    const brokenForAll = plan.pages.filter((p) => {
      const s = [...(states.get(p.route)?.values() ?? [])];
      return s.length > 0 && s.every((x) => x.state === 'BLANK' || x.state === 'ERROR' || x.state === 'NOT_FOUND') && plan.testedTypes.some((ut) => p.expected[ut] === 'Yes');
    });
    if (brokenForAll.length) {
      warnings.push(`${brokenForAll.length} page(s) rendered for none of the tested users although some should see them (broken page or wrong route?) — marked Review: ${brokenForAll.map((p) => '#' + p.route).join(', ')}`);
    }

    const results: CheckResult[] = [];
    for (const ut of plan.testedTypes) {
      const menu = menus.get(ut)!;
      const evidence = byUser.get(ut);
      for (const rule of plan.pages) {
        const expected = rule.expected[ut] ?? null;
        const inMenu = menuHasRoute(menu, rule.route);
        const ev = evidence?.get(rule.route);
        const st = states.get(rule.route)?.get(ut);
        if (!ev || !st) {
          const why = failedUsers.get(ut) ?? 'not probed (run stopped for this user type)';
          results.push({ ...base(rule, ut, expected), inMenu, state: null, fingerprintScore: null, verdict: 'REVIEW', reason: why });
          continue;
        }
        const othersWithContent = [...(states.get(rule.route) ?? [])]
          .filter(([u, s]) => u !== ut && (s.state === 'OPENED' || s.state === 'OPENED_EMPTY'))
          .map(([u]) => u);
        const v = pageVerdict(expected, inMenu, st.state, { othersWithContent });
        const ref = references.get(rule.route);
        const fields = { user: ut, route: rule.route, expected: expected ?? '-', state: st.state, score: st.score ?? undefined, reference: ref?.referenceUser ?? undefined, inMenu, verdict: v.verdict };
        if (v.verdict === 'PASS' || v.verdict === 'NOT_SPECIFIED') log.debug('verdict', fields);
        else log.info('verdict', { ...fields, why: st.reason });
        results.push({
          ...base(rule, ut, expected),
          inMenu,
          state: st.state,
          fingerprintScore: st.score,
          verdict: v.verdict,
          reason: `${v.reason} — ${st.reason}`,
          evidence: ev,
        });
      }
      const mine = results.filter((x) => x.userType === ut);
      log.info('user done', {
        user: ut,
        pass: mine.filter((x) => x.verdict === 'PASS').length,
        fail: mine.filter((x) => x.verdict.startsWith('FAIL')).length,
        review: mine.filter((x) => x.verdict === 'REVIEW').length,
        notSpecified: mine.filter((x) => x.verdict === 'NOT_SPECIFIED').length,
      });
    }

    // ⑤ Report
    r.progress?.({ phase: 'report', done: 0, total: 1 });
    const referenceShots: Record<string, { user: string; shot: string | null }> = {};
    for (const ref of references.values()) {
      if (!ref.referenceUser) continue;
      referenceShots[ref.route] = { user: ref.referenceUser, shot: byUser.get(ref.referenceUser)?.get(ref.route)?.screenshot ?? null };
    }
    const reportFile = writeReports(
      outDir,
      cfg,
      {
        runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        ampVersion: identities.find((i) => i.ampVersion)?.ampVersion,
        rulebookFile: input.rulebookSource.name,
        identities,
        menus: [...menus.values()],
        referenceShots,
        warnings,
      },
      results,
    );
    r.progress?.({ phase: 'report', done: 1, total: 1 });

    r.log('\nSummary');
    for (const ut of plan.testedTypes) {
      const counts: Partial<Record<Verdict, number>> = {};
      for (const res of results) if (res.userType === ut) counts[res.verdict] = (counts[res.verdict] ?? 0) + 1;
      summary[ut] = counts;
      const parts = VERDICT_ORDER.filter((v) => counts[v]).map((v) => `${v}=${counts[v]}`);
      r.log(`  ${ut.padEnd(24)} ${parts.join('  ')}`);
    }
    for (const w of warnings) r.log(`  ⚠ ${w}`);
    r.log(`\nReport: ${reportFile}`);
    const code = results.some((x) => x.verdict.startsWith('FAIL')) ? 2 : 0;
    for (const w of warnings) log.warn('report warning', { message: w });
    log.info('run finished', { run: runId, result: code === 2 ? 'failures found' : 'all pass', checks: results.length, ms: since(runStarted), report: reportFile });
    return { code, runId, outDir, reportFile, summary };
  } catch (e) {
    if (e instanceof CancelledError) return fail('cancelled by tester', 130);
    log.error('run crashed', e, { run: runId });
    return fail(scrub((e as Error).message));
  }
}

function base(rule: Rule, userType: string, expected: CheckResult['expected']) {
  return { ruleId: rule.id, label: rule.label, parent: rule.parent, route: rule.route, type: rule.type, userType, expected };
}

/** Opens every page as one user. Returns evidence by route plus the user's frame-only snapshot, or an error string. */
async function probeAll(
  input: RunInput,
  outDir: string,
  audit: AuditLog,
  userType: string,
  pages: Rule[],
  phase: 'probe',
): Promise<{ pages: Map<string, PageEvidence>; baseline: PageEvidence | null } | string> {
  const { cfg, signal } = input;
  const r = input.reporter ?? consoleReporter;
  const probe = new BrowserProbe(cfg, audit, userType, join(outDir, 'shots', slug(userType)));
  const out = new Map<string, PageEvidence>();
  try {
    const err = await probe.open(input.creds.get(userType)!);
    if (err) return err;
    for (const [idx, page] of pages.entries()) {
      if (signal?.aborted) throw new CancelledError();
      if (out.has(page.route)) continue;
      const ev = await probe.probe(page.route);
      out.set(page.route, ev);
      log.debug('page checked', {
        user: userType,
        phase,
        route: page.route,
        http: ev.fragmentStatus ?? undefined,
        redirect: ev.fragmentRedirect ?? undefined,
        noAccessMarker: ev.noAccessMarker || undefined,
        denial: ev.denialText,
        errorText: ev.errorText,
        dataApis: ev.apiCalls.filter((a) => a.hasData).map((a) => a.func),
        finalUrl: ev.finalUrl,
        elements: ev.tokens.length,
        apis: ev.apiCalls.length,
        apisDenied: ev.apiCalls.filter((a) => a.denied).map((a) => a.func),
        blocked: ev.blockedRequests.length,
        jsErrors: ev.pageErrors.length || undefined,
        error: ev.error,
        ms: ev.durationMs,
      });
      const signalText = ev.noAccessMarker
        ? 'no-access screen'
        : ev.denialText
          ? `says "${ev.denialText.slice(0, 40)}"`
          : ev.error
            ? `error: ${ev.error}`
            : `${ev.tokens.length} elements${ev.apiCalls.some((a) => a.hasData) ? ', data loaded' : ''}`;
      r.log(`  ${String(idx + 1).padStart(3)}/${pages.length} #${page.route.padEnd(42)} ${signalText}`);
      r.progress?.({ phase, userType, done: idx + 1, total: pages.length });
      if (/\/(login|sessionexpired)\b/i.test(ev.finalUrl) || (ev.fragmentRedirect && /\/(login|sessionexpired)\b/.test(ev.fragmentRedirect))) {
        r.log('  token expired mid-run — stopping this user type');
        log.warn('token expired mid-run, stopping this user', { user: userType, route: page.route, finalUrl: ev.finalUrl });
        break;
      }
      await new Promise((res) => setTimeout(res, cfg.delayMs));
    }
    return { pages: out, baseline: probe.baseline };
  } finally {
    await probe.close();
  }
}

// ---------------------------------------------------------------- CLI commands

export interface CliOptions {
  configFile: string;
  only?: string[];
  limit?: number;
  dryRun?: boolean;
  headed?: boolean;
}

async function cliSetup(opts: CliOptions) {
  loadLocalEnv();
  const cfg = loadConfig(opts.configFile);
  if (opts.headed) cfg.headless = false;
  const full = await loadRulebook(cfg.rulebook);
  // The config's userTypes decide what the CLI tests; other detected columns are skipped.
  const skipped = full.userTypes.filter((ut) => !cfg.userTypes[ut]);
  if (skipped.length) console.warn(`Skipping rulebook columns not in config userTypes: ${skipped.map((s) => full.userTypeLabels[s] ?? s).join(', ')}`);
  const rulebook = selectUserTypes(full, full.userTypes.filter((ut) => cfg.userTypes[ut]));
  const plan = planRun(cfg, rulebook, opts.only, opts.limit);
  return { cfg, rulebook, plan };
}

function cliCredentials(types: string[]): Map<string, Credentials> {
  const creds = new Map<string, Credentials>();
  const missing: string[] = [];
  for (const ut of types) {
    const c = credentialsFor(ut);
    if (c) creds.set(ut, c);
    else missing.push(`AMP_JWT_${envKey(ut)}`);
  }
  if (missing.length) throw new Error(`Missing tokens (set in terminal or .env.local):\n  ${missing.join('\n  ')}`);
  return creds;
}

function cliGate(cfg: RunConfig): RequestGate {
  const audit = new AuditLog(join(cfg.outputDir, '_cli', 'audit.jsonl'));
  return new RequestGate(cfg.environment, cfg.delayMs, audit);
}

export async function commandCheck(opts: CliOptions): Promise<number> {
  const { cfg, plan } = await cliSetup(opts);
  const creds = cliCredentials(plan.allTypes);
  const gate = cliGate(cfg);
  console.log(`Token check against ${cfg.environment.name} (${cfg.environment.baseUrl})`);
  let ok = true;
  for (const ut of plan.allTypes) {
    const id = await validateToken(gate, ut, creds.get(ut)!);
    ok &&= id.valid;
    console.log(`  ${ut.padEnd(24)} ${describeIdentity(id)}`);
  }
  return ok ? 0 : 1;
}

export async function commandMenu(opts: CliOptions): Promise<number> {
  const { cfg, plan } = await cliSetup(opts);
  const creds = cliCredentials(plan.allTypes);
  const gate = cliGate(cfg);
  let ok = true;
  for (const ut of plan.allTypes) {
    const menu = await fetchMenu(gate, ut, creds.get(ut)!, cfg.shellPath);
    if (!menu.ok) {
      ok = false;
      console.log(`\n[${ut}] menu FAILED: ${menu.reason}`);
      continue;
    }
    const present = plan.pages.filter((p) => menuHasRoute(menu, p.route)).length;
    console.log(`\n[${ut}] ${menu.links.length} menu links; ${present}/${plan.pages.length} rulebook pages present`);
    for (const l of menu.links) console.log(`   #${l.link}${l.name ? `  (${l.name})` : ''}`);
  }
  return ok ? 0 : 1;
}

export async function commandRun(opts: CliOptions): Promise<number> {
  const { cfg, rulebook, plan } = await cliSetup(opts);
  if (opts.dryRun) {
    console.log(`DRY RUN — no requests will be made.\nEnvironment: ${cfg.environment.name} (${cfg.environment.baseUrl})`);
    console.log(`User types: ${plan.allTypes.join(', ')} (per page, the user who sees the most is the reference)`);
    console.log(`Planned: ${plan.allTypes.length} token checks, ${plan.allTypes.length} menu reads, ${plan.pageOpens} page opens (GET only; page's own write calls are blocked).`);
    console.log(`Estimated time: ~${plan.estimatedMinutes} min`);
    console.log(`Pages:\n${plan.pages.map((p) => `  #${p.route}  (${p.label})`).join('\n')}`);
    return 0;
  }
  const outcome = await executeRun({
    cfg,
    rulebook,
    rulebookSource: { name: cfg.rulebook, data: readFileSync(cfg.rulebook) },
    creds: cliCredentials(plan.allTypes),
    only: opts.only,
    limit: opts.limit,
  });
  return outcome.code;
}
