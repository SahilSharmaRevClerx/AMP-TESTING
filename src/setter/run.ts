import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CheckResult, Credentials, Environment, Identity, Rulebook } from '../types';
import { RequestGate } from '../safety/gate';
import { buildConfig } from '../config';
import { selectUserTypes } from '../rulebook/parse';
import { executeRun, newRunId } from '../run';
import { AuditLog } from '../util/audit';
import { scrub } from '../util/mask';
import { slug } from '../util/route';
import { createLogger } from '../util/logger';
import { checkSuperAdmin } from './session';
import { DEFAULT_STEP_DELAY_MS, RoleEditor, type RoleValues } from './editor';
import { aiErrorMessage, aiModel, reviewRole, type AiReview, type AiRoleInput } from './ai';
import { LEVELS, planRole, reqLabel, targetFor, valueLabel, type ControlWant, type PagePlan, type RolePlan, type Step } from './sliders';

const log = createLogger('setter');

export interface VerifyAsUsers {
  /** Rulebook column → that user's own jwt. */
  creds: Map<string, Credentials>;
  /** Where the page-test run goes (the normal output folder, so it shows in Past runs). */
  outputDir: string;
  debugDir: string;
  rulebookSource: { name: string; data: Buffer };
  /** Pause after saving before the users open pages (AMP rebuilds permissions on the next request). */
  waitSec: number;
}

export interface SetterRequest {
  environment: Environment;
  /** Null in "set every slider" mode. */
  rulebook: Rulebook | null;
  rulebookName: string;
  /** Rulebook column → AMP role name to configure. Columns without a role are skipped. */
  roles: Record<string, string>;
  /** "Set every slider" mode: one role, every visible slider to one level (no rulebook). */
  bulk?: { roleName: string; step: Step };
  creds: Credentials;
  /** false = preview: open each role and move the sliders on screen, but never save. */
  apply: boolean;
  headless: boolean;
  /** Pause after every step in AMP's role editor. */
  stepDelayMs?: number;
  /** After saving: log in as each column's user and open the rulebook pages. */
  verify?: VerifyAsUsers;
  /** After everything: send results and screenshots to Gemini for a second check. */
  ai?: boolean;
  outputRoot: string;
  log: (line: string) => void;
  signal?: AbortSignal;
}

export interface ControlResult {
  key: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
  /** Read back after saving and reopening the role. */
  savedAs?: string;
  note?: string;
}

/** What one column's user saw on one page after the change. */
export interface UserPageResult {
  label: string;
  route: string;
  expected: string;
  verdict: string;
  state: string | null;
  reason: string;
  /** Relative to the setter report. */
  shot?: string;
}

export interface RoleResult {
  userType: string;
  label: string;
  roleName: string;
  status: 'saved' | 'previewed' | 'no_changes' | 'failed';
  error?: string;
  controls: ControlResult[];
  pages: PagePlan[];
  /** 2–3 full screenshots of the role editor's tabs in their final state (changed rows outlined). */
  shots: { label: string; file: string }[];
  userCheck?: { userName?: string; pages: UserPageResult[] };
  ai?: AiReview;
  aiError?: string;
}

export interface SetterOutcome {
  runId: string;
  outDir: string;
  apply: boolean;
  identity?: Identity;
  error?: string;
  roles: RoleResult[];
  /** The page-test run made as the users (when verified). */
  verify?: { runId: string; reportUrl?: string; error?: string };
  reportFile?: string;
}

export function newSetterRunId(envName: string): string {
  return `${slug(envName)}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}

/** Plans every column that has a role. Needs the Super Admin's module list to map pages to modules. */
export function planAll(rulebook: Rulebook, roles: Record<string, string>, modules: Parameters<typeof planRole>[3]): RolePlan[] {
  return rulebook.userTypes.filter((ut) => roles[ut]?.trim()).map((ut) => planRole(rulebook, ut, roles[ut]!.trim(), modules));
}

export async function executeSetter(req: SetterRequest, runId = newSetterRunId(req.environment.name)): Promise<SetterOutcome> {
  const outDir = join(req.outputRoot, runId);
  mkdirSync(outDir, { recursive: true });
  const audit = new AuditLog(join(outDir, 'audit.jsonl'));
  const out: SetterOutcome = { runId, outDir, apply: req.apply, roles: [] };
  const say = (l: string) => req.log(scrub(l));

  try {
    const gate = new RequestGate(req.environment, 300, audit);
    say(`Checking the Super Admin jwt on ${req.environment.baseUrl} …`);
    const admin = await checkSuperAdmin(gate, req.creds);
    out.identity = admin.identity;
    if (!admin.isAdmin) throw new Error(admin.reason ?? 'not a Super Admin');
    say(`✓ Logged in as ${admin.identity.userName ?? '?'} (${admin.identity.companyName ?? 'company'}), ${admin.modules.length} modules on this site`);

    const plans: RolePlan[] = req.bulk
      ? [{ userType: 'all-sliders', label: `Every slider → ${LEVELS[req.bulk.step]}`, roleName: req.bulk.roleName, pages: [], controls: [], bulkStep: req.bulk.step }]
      : req.rulebook
        ? planAll(req.rulebook, req.roles, admin.modules)
        : [];
    if (!plans.length) throw new Error('enter an AMP role name for at least one rulebook column');

    const stepDelayMs = req.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;
    say(`Working slowly on purpose: ${(stepDelayMs / 1000).toFixed(1)} s after every step, then 2–3 full screenshots of each role`);
    const editor = new RoleEditor({ baseUrl: req.environment.baseUrl, headless: req.headless, timeoutMs: 45000, allowSave: req.apply, stepDelayMs }, audit);
    try {
      await editor.open(req.creds);
      for (const plan of plans) {
        if (req.signal?.aborted) throw new Error('cancelled');
        out.roles.push(await applyRole(editor, plan, req, outDir, say));
      }
    } finally {
      await editor.close();
    }

    if (req.verify && req.rulebook && !req.bulk) await verifyAsUsers(out, req, req.rulebook, req.verify, say);
    if (req.ai) await aiReviewAll(out, req, say);
  } catch (e) {
    out.error = scrub((e as Error).message);
    say(`✗ ${out.error}`);
    log.warn('setter run failed', { run: runId, error: out.error });
  }

  out.reportFile = writeSetterReport(out, req);
  say(`Report: ${out.reportFile}`);
  return out;
}

// ---------------------------------------------------------------- layer 1: set the sliders as the Super Admin

function currentValue(v: RoleValues, w: ControlWant): number | boolean | undefined {
  return w.kind === 'feature' ? v.features[String(w.id)] : v[w.grid!][String(w.id)];
}

async function applyRole(editor: RoleEditor, plan: RolePlan, req: SetterRequest, outDir: string, say: (l: string) => void): Promise<RoleResult> {
  const res: RoleResult = { userType: plan.userType, label: plan.label, roleName: plan.roleName, status: 'no_changes', controls: [], pages: plan.pages, shots: [] };
  const shotDir = join(outDir, 'shots', slug(plan.userType));
  say(`\n${plan.label} → role "${plan.roleName}": ${plan.pages.filter((p) => p.status === 'planned').length} page(s) to set, ${plan.pages.filter((p) => p.status === 'cannot').length} can't be set by sliders`);
  try {
    say('  opening Setup → Roles → the role …');
    await editor.openRole(plan.roleName);
    const current = await editor.read();
    if (plan.bulkStep !== undefined) plan.controls = everySlider(current, plan.bulkStep);

    const moves: { w: ControlWant; to: number | boolean; c: ControlResult }[] = [];
    const checked: { w: ControlWant; c: ControlResult }[] = [];
    for (const w of plan.controls) {
      const cur = currentValue(current, w);
      if (cur === undefined) {
        res.controls.push({ key: w.key, label: w.label, before: '-', after: '-', changed: false, note: 'not shown in this role editor (feature off for the company?)' });
        continue;
      }
      if (current.hidden.includes(w.key)) {
        res.controls.push({ key: w.key, label: w.label, before: valueLabel(w, cur), after: valueLabel(w, cur), changed: false, note: 'hidden in the role editor for this company; left as is' });
        continue;
      }
      const to = targetFor(w, cur);
      const c: ControlResult = { key: w.key, label: w.label, before: valueLabel(w, cur), after: valueLabel(w, to ?? cur), changed: to !== null };
      res.controls.push(c);
      checked.push({ w, c });
      if (to !== null) moves.push({ w, to, c });
    }

    // Each permission that needs it: move it, wait, check it took.
    for (const { w, to, c } of moves) {
      if (w.kind === 'feature') await editor.setFeature(w.id, to === true);
      else await editor.setSlider(w.grid!, w.id, Number(to));
      say(`  ${w.label}: ${c.before} → ${c.after}`);
    }
    if (moves.length) {
      const after = await editor.read();
      for (const { w, to } of moves) {
        const got = currentValue(after, w);
        if (got !== to) throw new Error(`${reqLabel(w.key)} did not move (shows ${valueLabel(w, got)}, wanted ${valueLabel(w, to)})`);
      }
    }
    if (!moves.length) {
      res.status = 'no_changes';
      say('  already matches; nothing to change');
    } else if (req.apply) {
      say('  saving …');
      await editor.save();
      say(`  ✓ saved ${moves.length} change(s); reopening the role to check AMP kept them …`);
      await confirmSaved(editor, plan, moves, res, say);
    } else {
      res.status = 'previewed';
      say(`  preview only: ${moves.length} change(s) shown, not saved`);
    }
    // 2–3 screenshots of the final state: each tab the plan touches, whole, changed rows outlined.
    await shootTabs(editor, plan, moves.map((m) => m.w.key), res, outDir, shotDir);
    say(`  ${res.shots.length} screenshot(s) of the role: ${res.shots.map((x) => x.label).join(', ')}`);
  } catch (e) {
    res.status = 'failed';
    res.error = scrub((e as Error).message);
    say(`  ✗ ${res.error}`);
    const shot = rel(outDir, await editor.screenshot(shotDir, 'error.png'));
    if (shot) res.shots.push({ label: 'When it failed', file: shot });
  }
  return res;
}

/** Reopens the saved role and reads every moved permission back, with a screenshot of each. */
async function confirmSaved(
  editor: RoleEditor,
  plan: RolePlan,
  moves: { w: ControlWant; to: number | boolean; c: ControlResult }[],
  res: RoleResult,
  say: (l: string) => void,
): Promise<void> {
  await editor.openRole(plan.roleName);
  const saved = await editor.read();
  const lost: string[] = [];
  for (const { w, to, c } of moves) {
    const got = currentValue(saved, w);
    c.savedAs = valueLabel(w, got);
    if (got !== to) lost.push(`${w.label} (shows ${c.savedAs}, wanted ${valueLabel(w, to)})`);
  }
  if (lost.length) throw new Error(`AMP did not keep: ${lost.join(', ')}`);
  res.status = 'saved';
  say(`  ✓ confirmed: all ${moves.length} change(s) are saved in AMP`);
}

const TAB_NAMES = { media: 'Marketing Functions', system: 'Operations', features: 'Advanced' } as const;

/** One full screenshot per tab the role's plan touches (Marketing Functions and Operations always, Advanced when a checkbox is involved). */
async function shootTabs(editor: RoleEditor, plan: RolePlan, changed: string[], res: RoleResult, outDir: string, shotDir: string): Promise<void> {
  const tabs: ('media' | 'system' | 'features')[] = ['media', 'system'];
  if (plan.controls.some((c) => c.kind === 'feature')) tabs.push('features');
  let n = 1;
  for (const tab of tabs) {
    const file = rel(outDir, await editor.shotTab(shotDir, `${n++}-${slug(TAB_NAMES[tab])}.png`, tab, changed));
    if (file) res.shots.push({ label: TAB_NAMES[tab], file });
  }
}

/** "Set every slider" mode: one control per slider the role editor shows (hidden rows are left alone). */
function everySlider(current: RoleValues, step: Step): ControlWant[] {
  const out: ControlWant[] = [];
  for (const grid of ['media', 'system'] as const) {
    for (const id of Object.keys(current[grid])) {
      const key = `${grid}:${id}`;
      if (current.hidden.includes(key)) continue;
      out.push({ key, kind: 'slider', grid, id: Number(id), label: current.labels[key] ?? reqLabel(key), raiseTo: null, lower: false, exact: step, yesPages: [], noPages: [] });
    }
  }
  return out;
}

// ---------------------------------------------------------------- layer 2: log in as each user and open the pages

async function verifyAsUsers(out: SetterOutcome, req: SetterRequest, rulebook: Rulebook, v: VerifyAsUsers, say: (l: string) => void): Promise<void> {
  const cols = out.roles.filter((r) => (r.status === 'saved' || r.status === 'no_changes') && v.creds.has(r.userType)).map((r) => r.userType);
  if (!req.apply) {
    say('\nSkipping the check as users: this was a preview, nothing was saved');
    return;
  }
  if (!cols.length) {
    say('\nSkipping the check as users: no saved role has a user jwt');
    return;
  }
  say(`\nWaiting ${v.waitSec}s, then logging in as ${cols.map((c) => rulebook.userTypeLabels[c] ?? c).join(', ')} to open the rulebook pages …`);
  await new Promise((r) => setTimeout(r, v.waitSec * 1000));

  const rb = selectUserTypes(rulebook, cols);
  const userTypes: Record<string, { label: string }> = {};
  for (const k of rb.userTypes) userTypes[k] = { label: rb.userTypeLabels[k] ?? k };
  const cfg = buildConfig(
    { environment: req.environment, rulebook: '(permission setter)', calibrationUserType: null, userTypes, outputDir: v.outputDir, debugDir: v.debugDir, debugShots: true, headless: req.headless },
    'permission setter',
  );
  const runId = newRunId(`${req.environment.name}-after-setter`);
  out.verify = { runId };
  const started = new Date().toISOString();
  const creds = new Map(cols.map((c) => [c, v.creds.get(c)!] as const));
  const outcome = await executeRun(
    { cfg, rulebook: rb, rulebookSource: v.rulebookSource, creds, only: cols, signal: req.signal, reporter: { log: (l) => say(`  ${l}`) }, notes: [`Run by the Permission Setter right after saving roles (${out.runId}).`] },
    runId,
  );
  if (outcome.error) out.verify.error = outcome.error;
  if (outcome.reportFile) out.verify.reportUrl = `/output/${runId}/report.html`;
  try {
    writeFileSync(
      join(outcome.outDir, 'summary.json'),
      JSON.stringify({ runId, environment: { name: cfg.environment.name, baseUrl: cfg.environment.baseUrl }, rulebook: v.rulebookSource.name, startedAt: started, finishedAt: new Date().toISOString(), status: outcome.error ? 'failed' : 'done', code: outcome.code, error: outcome.error ?? null, summary: outcome.summary, reportUrl: out.verify.reportUrl ?? null }),
    );
  } catch {
    /* history is best-effort */
  }

  const resultsFile = join(outcome.outDir, 'results.json');
  if (!existsSync(resultsFile)) return;
  const data = JSON.parse(readFileSync(resultsFile, 'utf8')) as { results: CheckResult[]; meta?: { identities?: Identity[] } };
  for (const r of out.roles) {
    if (!cols.includes(r.userType)) continue;
    const rows = data.results.filter((x) => x.userType === r.userType && x.type === 'page');
    r.userCheck = {
      userName: data.meta?.identities?.find((i) => i.userType === r.userType)?.userName,
      pages: rows.map((x) => ({
        label: x.label,
        route: x.route,
        expected: x.expected ?? '-',
        verdict: x.verdict,
        state: x.state,
        reason: x.reason,
        shot: x.evidence?.screenshot ? relative(out.outDir, join(outcome.outDir, x.evidence.screenshot)).split('\\').join('/') : undefined,
      })),
    };
    const pass = rows.filter((x) => x.verdict === 'PASS').length;
    say(`  ${r.label}: ${pass}/${rows.length} pages behave as the rulebook says`);
  }
}

// ---------------------------------------------------------------- layer 3: AI review of results and screenshots

async function aiReviewAll(out: SetterOutcome, req: SetterRequest, say: (l: string) => void): Promise<void> {
  say(`\nAI review: sending each role's results and screenshots to Gemini (${aiModel()}) …`);
  for (const r of out.roles) {
    if (r.status === 'failed') {
      r.aiError = 'skipped: setting this role failed';
      continue;
    }
    const input: AiRoleInput = {
      column: r.label,
      roleName: r.roleName,
      mode: req.bulk ? 'every-slider' : 'rulebook',
      controls: r.controls.map((c) => ({ label: c.label, before: c.before, wanted: c.after, savedAs: c.savedAs ?? null })),
      tabShots: r.shots.map((x) => ({ label: x.label, file: join(out.outDir, x.file) })),
      pages: r.pages.map((p) => ({ label: p.label, route: p.route, expected: p.expected ?? '-', plan: `${p.status}: ${p.reason}` })),
      userPages: r.userCheck?.pages.map((p) => ({ label: p.label, route: p.route, expected: p.expected, verdict: p.verdict, reason: p.reason, shot: abs(out.outDir, p.shot) })),
    };
    try {
      r.ai = await reviewRole(input);
      const bad = r.ai.checks.filter((c) => c.ok === 'no').length;
      const unsure = r.ai.checks.filter((c) => c.ok === 'unsure').length;
      say(`  ${r.label}: AI says ${r.ai.verdict.toUpperCase()} (${r.ai.checks.length} checks, ${bad} wrong, ${unsure} unsure)`);
    } catch (e) {
      r.aiError = scrub(aiErrorMessage(e));
      say(`  ${r.label}: AI review failed: ${r.aiError}`);
    }
  }
}

function abs(dir: string, rel?: string): string | undefined {
  return rel ? join(dir, rel) : undefined;
}

function rel(outDir: string, file: string | null): string | undefined {
  return file ? relative(outDir, file).split('\\').join('/') : undefined;
}

// ---------------------------------------------------------------- report

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

type Mark = 'ok' | 'bad' | 'check' | 'none';
const MARK: Record<Mark, string> = { ok: '✓ Matches', bad: '✗ Does not match', check: '? Check', none: '–' };

/** What the user got on a page, in plain words. */
function userResult(p: UserPageResult, who: string): { text: string; mark: Mark } {
  const got: Record<string, string> = {
    OPENED: `Opens for ${who}`,
    OPENED_EMPTY: `Opens for ${who}, but its data is denied`,
    BLOCKED: `Blocked for ${who}`,
    BLANK: `Empty page for ${who}`,
    NOT_FOUND: 'Page not found on this site',
    ERROR: 'Page shows an error',
    BAD_TOKEN: `The jwt of ${who} expired`,
  };
  const text = got[p.state ?? ''] ?? p.reason;
  return { text, mark: p.verdict === 'PASS' ? 'ok' : p.verdict.startsWith('FAIL') ? 'bad' : 'check' };
}

/** One row per rulebook page: what the rulebook says and what we have now. */
function compareRows(r: RoleResult): { page: string; route: string; expected: string; result: string; detail: string; mark: Mark }[] {
  const who = r.userCheck?.userName ?? 'the user';
  return r.pages.map((p) => {
    const base = { page: p.label, route: p.route, expected: p.expected ?? '–' };
    const seen = r.userCheck?.pages.find((u) => u.route === p.route);
    if (seen) {
      const u = userResult(seen, who);
      const set = p.status === 'planned' ? `The tool: ${p.reason}` : p.status === 'cannot' ? `Not set by the tool: ${p.reason}` : '';
      return { ...base, result: u.text, detail: set, mark: u.mark };
    }
    if (p.status === 'not_specified') return { ...base, result: 'No Yes/No in the rulebook', detail: '', mark: 'none' };
    if (p.status === 'cannot') return { ...base, result: "Can't be set with role sliders", detail: p.reason, mark: 'check' };
    if (r.status === 'failed') return { ...base, result: 'Not set (the role could not be saved)', detail: r.error ?? '', mark: 'bad' };
    if (r.status === 'previewed') return { ...base, result: 'Preview only: not saved', detail: p.reason, mark: 'none' };
    return { ...base, result: p.expected === 'Yes' ? 'Permission given' : 'Permission removed', detail: p.reason, mark: 'ok' };
  });
}

function roleHeadline(r: RoleResult, rows: ReturnType<typeof compareRows>): string {
  if (r.status === 'failed') return `Failed: ${esc(r.error ?? 'the role could not be set')}`;
  const counted = rows.filter((x) => x.mark !== 'none');
  const ok = counted.filter((x) => x.mark === 'ok').length;
  const changed = r.controls.filter((c) => c.changed).length;
  const what = r.status === 'previewed' ? `${changed} change(s) shown, not saved` : changed ? `${changed} permission(s) changed and confirmed in AMP` : 'nothing needed changing';
  if (!rows.length) return what;
  return `${ok} of ${counted.length} page(s) match the rulebook${r.userCheck ? ` when logged in as ${esc(r.userCheck.userName ?? 'the user')}` : ''} · ${what}`;
}

function roleSection(r: RoleResult, bulk: boolean): string {
  const rows = compareRows(r);
  const table = rows.length
    ? `<table><tr><th>Page</th><th>Rulebook says</th><th>Result now</th><th>Match</th></tr>${rows
        .map((x) => `<tr><td>${esc(x.page)}<div class="muted">#${esc(x.route)}</div></td><td><b>${esc(x.expected)}</b></td><td>${esc(x.result)}${x.detail ? `<div class="muted">${esc(x.detail)}</div>` : ''}</td><td class="m ${x.mark}">${MARK[x.mark]}</td></tr>`)
        .join('')}</table>`
    : '';
  const changed = r.controls.filter((c) => c.changed);
  const changes = changed.length
    ? `<ul class="chg">${changed.map((c) => `<li><b>${esc(c.label)}</b>: ${esc(c.before)} → ${esc(c.after)}${c.savedAs ? (c.savedAs === c.after ? ' <span class="ok">✓ saved</span>' : ` <span class="bad">✗ AMP shows ${esc(c.savedAs)}</span>`) : ''}</li>`).join('')}</ul>`
    : '<p class="muted">Nothing needed changing.</p>';
  const shots = r.shots.length
    ? `<div class="shots">${r.shots.map((x) => `<figure><a href="${esc(x.file)}" target="_blank"><img src="${esc(x.file)}" alt="${esc(x.label)}"></a><figcaption>${esc(x.label)}</figcaption></figure>`).join('')}</div>`
    : '';
  const ai = r.ai
    ? `<details class="ai"><summary>AI review (Gemini): <b class="m ${r.ai.verdict === 'pass' ? 'ok' : r.ai.verdict === 'fail' ? 'bad' : 'check'}">${esc(r.ai.verdict.toUpperCase())}</b> — ${esc(r.ai.summary)}</summary><table><tr><th>Item</th><th>Expected</th><th>Seen</th><th>OK?</th></tr>${r.ai.checks
        .map((c) => `<tr><td>${esc(c.item)}${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}</td><td>${esc(c.expected)}</td><td>${esc(c.observed)}</td><td class="m ${c.ok === 'yes' ? 'ok' : c.ok === 'no' ? 'bad' : 'check'}">${esc(c.ok)}</td></tr>`)
        .join('')}</table></details>`
    : r.aiError
      ? `<p class="muted">AI review: ${esc(r.aiError)}</p>`
      : '';
  const title = bulk ? `Role “${esc(r.roleName)}”: ${esc(r.label.replace(/^Every slider/, 'every slider'))}` : `${esc(r.label)} → role “${esc(r.roleName)}”`;
  return `<section><h2>${title}</h2><p class="head ${r.status === 'failed' ? 'bad' : ''}">${roleHeadline(r, rows)}</p>${table}<h3>What changed in AMP</h3>${changes}${shots}${ai}</section>`;
}

export function writeSetterReport(out: SetterOutcome, req: Pick<SetterRequest, 'environment' | 'rulebookName' | 'bulk'>): string {
  writeFileSync(join(out.outDir, 'results.json'), JSON.stringify({ ...out, environment: req.environment, rulebook: req.rulebookName }, null, 2));
  const failed = !!out.error || out.roles.some((r) => r.status === 'failed');
  const mismatches = out.roles.flatMap((r) => compareRows(r)).filter((x) => x.mark === 'bad').length;
  const headline = failed
    ? { cls: 'bad', text: '✗ Finished with problems', sub: out.error ?? 'Some roles could not be set; see below.' }
    : !out.apply
      ? { cls: 'warn', text: 'Preview done — nothing was saved', sub: 'The sliders were moved on screen only. Click Apply to save them.' }
      : mismatches
        ? { cls: 'bad', text: `Done — but ${mismatches} page(s) don't match the rulebook`, sub: 'The roles were saved, but some pages still behave differently for the user. See the rows marked ✗.' }
        : { cls: 'ok', text: '✓ Done', sub: out.verify ? 'Roles saved, confirmed in AMP, and checked by logging in as the users.' : 'Roles saved and confirmed in AMP.' };
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Permission Setter Report</title><style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2330;--muted:#6b7280;--line:#e3e6eb;--ok:#127a4b;--ok-bg:#e3f5ea;--bad:#b42318;--bad-bg:#fdeceb;--warn:#a15c00;--warn-bg:#fdf3e1}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--text:#e7eaf0;--muted:#9aa3b2;--line:#2c3340;--ok:#4cc38a;--ok-bg:#16301f;--bad:#ff7b72;--bad-bg:#3a1d1b;--warn:#e3a33b;--warn-bg:#382b13}}
body{background:var(--bg);color:var(--text);font:15px/1.55 system-ui,sans-serif;margin:0;padding:24px 16px}main{max-width:1000px;margin:auto}
.banner{border-radius:12px;padding:18px 20px;margin:12px 0 18px}.banner h1{margin:0;font-size:26px}.banner p{margin:4px 0 0}
.banner.ok{background:var(--ok-bg);color:var(--ok)}.banner.bad{background:var(--bad-bg);color:var(--bad)}.banner.warn{background:var(--warn-bg);color:var(--warn)}
.meta{color:var(--muted);font-size:13px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:16px 0}h2{margin:0 0 4px;font-size:19px}h3{font-size:15px;margin:18px 0 6px}
p.head{margin:0 0 12px;color:var(--muted)}p.head.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:13px;color:var(--muted);font-weight:600}
.muted{color:var(--muted);font-size:12.5px}.m{font-weight:600;white-space:nowrap}.ok,.m.ok{color:var(--ok)}.bad,.m.bad{color:var(--bad)}.m.check{color:var(--warn)}.m.none{color:var(--muted)}
ul.chg{margin:0;padding-left:20px}
.shots{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px}figure{margin:0;flex:1 1 280px}figure img{width:100%;max-height:420px;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:8px}figcaption{font-size:13px;color:var(--muted);text-align:center}
details.ai{margin-top:14px}details.ai summary{cursor:pointer}
.wrap{overflow-x:auto}</style></head><body><main>
<div class="banner ${headline.cls}"><h1>${headline.text}</h1><p>${esc(headline.sub)}</p></div>
<p class="meta">${esc(req.environment.name)} · ${esc(req.environment.baseUrl)} · ${req.bulk ? 'every slider of one role' : `rulebook ${esc(req.rulebookName)}`} · by ${esc(out.identity?.userName ?? '?')} (Super Admin) · ${esc(new Date().toLocaleString())}${out.verify?.reportUrl ? ` · <a href="../../${esc(out.verify.runId)}/report.html">full page test as the users</a>` : ''}</p>
<div class="wrap">${out.roles.map((r) => roleSection(r, !!req.bulk)).join('')}</div>
<p class="meta">A user gets the highest level from every role linked to them (own, groups, organization, company-wide). If a "No" page still opens, check the user's other roles. Click a screenshot to open it full size.</p>
</main></body></html>`;
  const file = join(out.outDir, 'report.html');
  writeFileSync(file, html);
  return file;
}
