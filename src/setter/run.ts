import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Credentials, Environment, Identity, Rulebook } from '../types';
import { RequestGate } from '../safety/gate';
import { AuditLog } from '../util/audit';
import { scrub } from '../util/mask';
import { slug } from '../util/route';
import { createLogger } from '../util/logger';
import { checkSuperAdmin } from './session';
import { RoleEditor } from './editor';
import { LEVELS, planRole, reqLabel, targetFor, valueLabel, type ControlWant, type PagePlan, type RolePlan, type Step } from './sliders';

const log = createLogger('setter');

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
  note?: string;
}

export interface RoleResult {
  userType: string;
  label: string;
  roleName: string;
  status: 'saved' | 'previewed' | 'no_changes' | 'failed';
  error?: string;
  controls: ControlResult[];
  pages: PagePlan[];
  shots: { before?: string; after?: string };
}

export interface SetterOutcome {
  runId: string;
  outDir: string;
  apply: boolean;
  identity?: Identity;
  error?: string;
  roles: RoleResult[];
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

    const editor = new RoleEditor({ baseUrl: req.environment.baseUrl, headless: req.headless, timeoutMs: 30000, allowSave: req.apply }, audit);
    try {
      await editor.open(req.creds);
      for (const plan of plans) {
        if (req.signal?.aborted) throw new Error('cancelled');
        out.roles.push(await applyRole(editor, plan, req, outDir, say));
      }
    } finally {
      await editor.close();
    }
  } catch (e) {
    out.error = scrub((e as Error).message);
    say(`✗ ${out.error}`);
    log.warn('setter run failed', { run: runId, error: out.error });
  }

  out.reportFile = writeSetterReport(out, req);
  say(`Report: ${out.reportFile}`);
  return out;
}

async function applyRole(editor: RoleEditor, plan: RolePlan, req: SetterRequest, outDir: string, say: (l: string) => void): Promise<RoleResult> {
  const res: RoleResult = { userType: plan.userType, label: plan.label, roleName: plan.roleName, status: 'no_changes', controls: [], pages: plan.pages, shots: {} };
  const shotDir = join(outDir, 'shots', slug(plan.userType));
  say(`\n${plan.label} → role "${plan.roleName}": ${plan.pages.filter((p) => p.status === 'planned').length} page(s) to set, ${plan.pages.filter((p) => p.status === 'cannot').length} can't be set by sliders`);
  try {
    await editor.openRole(plan.roleName);
    const current = await editor.read();
    if (plan.bulkStep !== undefined) plan.controls = everySlider(current, plan.bulkStep);
    const firstSlider = plan.controls.find((c) => c.kind === 'slider');
    const firstGrid = firstSlider?.grid ?? 'media';
    await editor.showTab(firstGrid);
    if (firstSlider) await editor.scrollTo(firstGrid, firstSlider.id);
    res.shots.before = rel(outDir, await editor.screenshot(shotDir, 'before.png'));

    const moves: { w: ControlWant; to: number | boolean }[] = [];
    for (const w of plan.controls) {
      const cur = w.kind === 'feature' ? current.features[String(w.id)] : current[w.grid!][String(w.id)];
      if (cur === undefined) {
        res.controls.push({ key: w.key, label: w.label, before: '-', after: '-', changed: false, note: 'not shown in this role editor (feature off for the company?)' });
        continue;
      }
      if (current.hidden.includes(w.key)) {
        res.controls.push({ key: w.key, label: w.label, before: valueLabel(w, cur), after: valueLabel(w, cur), changed: false, note: 'hidden in the role editor for this company; left as is' });
        continue;
      }
      const to = targetFor(w, cur);
      res.controls.push({ key: w.key, label: w.label, before: valueLabel(w, cur), after: valueLabel(w, to ?? cur), changed: to !== null });
      if (to !== null) moves.push({ w, to });
    }

    for (const { w, to } of moves) {
      if (w.kind === 'feature') await editor.setFeature(w.id, to === true);
      else await editor.setSlider(w.grid!, w.id, Number(to));
      say(`  ${w.label}: ${res.controls.find((c) => c.key === w.key)!.before} → ${valueLabel(w, to)}`);
    }
    if (moves.length) {
      const after = await editor.read();
      for (const { w, to } of moves) {
        const got = w.kind === 'feature' ? after.features[String(w.id)] : after[w.grid!][String(w.id)];
        if (got !== to) throw new Error(`${reqLabel(w.key)} did not move (shows ${valueLabel(w, got)}, wanted ${valueLabel(w, to)})`);
      }
    }
    const moved = moves.find((m) => m.w.kind === 'slider')?.w ?? firstSlider;
    await editor.showTab(moved?.grid ?? firstGrid);
    if (moved) await editor.scrollTo(moved.grid!, moved.id);
    res.shots.after = rel(outDir, await editor.screenshot(shotDir, 'after.png'));

    if (!moves.length) {
      res.status = 'no_changes';
      say('  already matches the rulebook; nothing to change');
    } else if (req.apply) {
      await editor.save();
      res.status = 'saved';
      say(`  ✓ saved ${moves.length} change(s)`);
    } else {
      res.status = 'previewed';
      say(`  preview only: ${moves.length} change(s) shown, not saved`);
    }
  } catch (e) {
    res.status = 'failed';
    res.error = scrub((e as Error).message);
    say(`  ✗ ${res.error}`);
    res.shots.after ??= rel(outDir, await editor.screenshot(shotDir, 'error.png'));
  }
  return res;
}

/** "Set every slider" mode: one control per slider the role editor shows (hidden rows are left alone). */
function everySlider(current: Awaited<ReturnType<RoleEditor['read']>>, step: Step): ControlWant[] {
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

function rel(outDir: string, file: string | null): string | undefined {
  return file ? relative(outDir, file).split('\\').join('/') : undefined;
}

// ---------------------------------------------------------------- report

const STATUS: Record<RoleResult['status'], string> = {
  saved: 'Saved',
  previewed: 'Preview (not saved)',
  no_changes: 'Already matches',
  failed: 'Failed',
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function writeSetterReport(out: SetterOutcome, req: Pick<SetterRequest, 'environment' | 'rulebookName'>): string {
  writeFileSync(join(out.outDir, 'results.json'), JSON.stringify({ ...out, environment: req.environment, rulebook: req.rulebookName }, null, 2));
  const roles = out.roles
    .map((r) => {
      const controls = r.controls.length
        ? `<table><tr><th>Permission</th><th>Before</th><th>After</th><th></th></tr>${r.controls
            .map((c) => `<tr class="${c.changed ? 'chg' : ''}"><td>${esc(c.label)}</td><td>${esc(c.before)}</td><td>${esc(c.after)}</td><td>${esc(c.note ?? (c.changed ? 'changed' : 'unchanged'))}</td></tr>`)
            .join('')}</table>`
        : '<p class="muted">No sliders to move for this column.</p>';
      const pages = `<table><tr><th>Page</th><th>Rulebook</th><th>Module</th><th>What the tool did</th></tr>${r.pages
        .map((p) => `<tr class="${p.status}"><td>${esc(p.label)}<div class="muted">#${esc(p.route)}</div></td><td>${esc(p.expected ?? '-')}</td><td>${esc(p.module ?? '-')}</td><td>${esc(p.reason)}${p.note ? `<div class="muted">Note: ${esc(p.note)}</div>` : ''}</td></tr>`)
        .join('')}</table>`;
      const shots = [r.shots.before && `<figure><figcaption>Before</figcaption><a href="${esc(r.shots.before)}"><img src="${esc(r.shots.before)}" alt="before"></a></figure>`, r.shots.after && `<figure><figcaption>After</figcaption><a href="${esc(r.shots.after)}"><img src="${esc(r.shots.after)}" alt="after"></a></figure>`]
        .filter(Boolean)
        .join('');
      return `<section><h2>${esc(r.label)} → role “${esc(r.roleName)}” <span class="st ${r.status}">${STATUS[r.status]}</span></h2>${r.error ? `<p class="err">${esc(r.error)}</p>` : ''}<h3>Sliders</h3>${controls}<h3>Pages</h3>${pages}${shots ? `<div class="shots">${shots}</div>` : ''}</section>`;
    })
    .join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Permission Setter Report</title><style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2330;--muted:#6b7280;--line:#e3e6eb;--ok:#127a4b;--bad:#b42318;--warn:#a15c00;--chg:#eef6ff}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--text:#e7eaf0;--muted:#9aa3b2;--line:#2c3340;--ok:#4cc38a;--bad:#ff7b72;--warn:#e3a33b;--chg:#1d2a3a}}
body{background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px}main{max-width:1100px;margin:auto}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}table{width:100%;border-collapse:collapse;margin:6px 0 12px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}tr.chg td{background:var(--chg)}tr.cannot td:last-child{color:var(--warn)}
.muted{color:var(--muted);font-size:12px}.err{color:var(--bad)}.st{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid currentColor;margin-left:6px}
.st.saved,.st.no_changes{color:var(--ok)}.st.failed{color:var(--bad)}.st.previewed{color:var(--warn)}.shots{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0;flex:1 1 300px}img{width:100%;border:1px solid var(--line);border-radius:6px}
.wrap{overflow-x:auto}</style></head><body><main>
<h1>Permission Setter</h1>
<p>${esc(req.environment.name)} · ${esc(req.environment.baseUrl)} · rulebook ${esc(req.rulebookName)} · ${out.apply ? 'applied (saved to AMP)' : 'preview only (nothing saved)'} · as ${esc(out.identity?.userName ?? '?')} · ${esc(new Date().toLocaleString())}</p>
${out.error ? `<p class="err">${esc(out.error)}</p>` : ''}
<p class="muted">A user gets the highest level from every role linked to them (their own, their groups, organization and company-wide roles). If a page still shows after a "No", check the user's other roles. The user may need to log in again to see the change.</p>
<div class="wrap">${roles}</div></main></body></html>`;
  const file = join(out.outDir, 'report.html');
  writeFileSync(file, html);
  return file;
}
