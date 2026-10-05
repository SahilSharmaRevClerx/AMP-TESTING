import type { RequestGate } from '../safety/gate';
import type { Credentials, Rulebook } from '../types';
import { validateToken } from '../sessions/validate';
import { slug } from '../util/route';
import type { RoleEditor } from './editor';
import { markNavPages, matchUser, navChanges, planNavigation, type ColumnUser, type CompanyUser, type NavModulePlan } from './nav';
import type { AmpModule, RolePlan } from './sliders';

const USER = 'super_admin';

/** Navigation Layout's user link type (LinkType.User). */
const LINK_USER = 2;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Reads every company user with their link state for one module (Navigation Layout → Users tab), read-only. */
export async function fetchModuleUsers(gate: RequestGate, creds: Credentials, moduleId: number): Promise<CompanyUser[]> {
  const out: CompanyUser[] = [];
  for (let page = 0; page < 50; page++) {
    const res = await gate.fetch(USER, 'POST', gate.resolve('/services/api.ashx?func=getmodulesettingdata'), creds, { type: LINK_USER, moduleId, page, pageSize: 100, sort: 'email', ascending: true, search: '' });
    if (!res.ok) throw new Error(`could not read the users of module ${moduleId} (HTTP ${res.status})`);
    const body = (await res.json()) as { status?: number; result?: { item?: Record<string, unknown>[]; row_count?: number } | string };
    const result = body.result;
    if (!result || typeof result !== 'object' || !Array.isArray(result.item)) throw new Error(`AMP refused the user list for module ${moduleId}: ${JSON.stringify(result ?? body).slice(0, 120)}`);
    for (const u of result.item) {
      // AMP's "friendlyname" can be a number (an id): prefer the real first/last name, then a non-numeric friendly name, then the email.
      const friendly = str(u.friendlyname).trim();
      const name = [str(u.firstname), str(u.lastname)].map((x) => x.trim()).filter(Boolean).join(' ') || (friendly && !/^\d+$/.test(friendly) ? friendly : '');
      out.push({ id: Number(u.id), email: str(u.email), name: name || str(u.email), linked: u.selected === '1' || u.selected === 1 || u.selected === true });
    }
    if (result.item.length < 100 || out.length >= Number(result.row_count ?? 0)) break;
  }
  return out;
}

/**
 * Works out the Navigation Layout part of the plan: who each column's user is, which modules need a
 * "Shown to" change, and the exact links to add/remove. Read-only (used by Show plan, Preview and Apply).
 */
export async function prepareNavigation(input: {
  gate: RequestGate;
  creds: Credentials;
  rulebook: Rulebook;
  plans: RolePlan[];
  modules: AmpModule[];
  /** Column → email or name the tester typed. */
  hints: Record<string, string>;
  /** Column → that user's jwt (to read their name when no hint was typed). */
  userCreds?: Map<string, Credentials>;
}): Promise<{ nav: NavModulePlan[]; columnUsers: ColumnUser[] }> {
  const { gate, creds, rulebook, plans, modules } = input;
  // First with every column, to find out whether any module needs the step at all.
  const everyone: ColumnUser[] = plans.map((p) => ({ column: p.userType, label: p.label, hint: '', user: { id: -1, email: '', name: '' } }));
  const candidates = planNavigation(plans, modules, everyone);
  if (!candidates.length) return { nav: [], columnUsers: [] };

  const users = await fetchModuleUsers(gate, creds, candidates[0]!.moduleId);
  const columnUsers: ColumnUser[] = [];
  for (const p of plans) {
    let hint = input.hints[p.userType]?.trim() ?? '';
    if (!hint && input.userCreds?.has(p.userType)) {
      const id = await validateToken(gate, p.userType, input.userCreds.get(p.userType)!);
      if (id.valid && id.userName) hint = id.userName;
    }
    const cu: ColumnUser = { column: p.userType, label: rulebook.userTypeLabels[p.userType] ?? p.userType, hint };
    if (!hint) cu.problem = "enter this column's user (email) or paste their jwt to use Navigation Layout";
    else {
      const m = matchUser(hint, users);
      if (m.user) cu.user = { id: m.user.id, email: m.user.email, name: m.user.name };
      else cu.problem = m.problem;
    }
    columnUsers.push(cu);
  }

  const nav = planNavigation(plans, modules, columnUsers);
  for (const m of nav) {
    if (m.status === 'skipped') continue;
    const mod = modules.find((x) => x.id === m.moduleId);
    const linkState = m.moduleId === candidates[0]!.moduleId ? users : await fetchModuleUsers(gate, creds, m.moduleId);
    m.before = mod?.level ?? 'all';
    Object.assign(m, navChanges(m, linkState, columnUsers, m.before));
    m.after = 'specific';
    m.status = 'planned';
    if (!m.shownTo?.length) {
      m.status = 'skipped';
      m.note = 'nobody would see this module afterwards; left as is';
    }
  }
  markNavPages(plans, nav.filter((m) => m.status === 'planned'), modules);
  return { nav, columnUsers };
}

/** Applies one module's "Shown to: specific" change in AMP (as the Super Admin), then reads it back. */
export async function applyNavModule(editor: RoleEditor, gate: RequestGate, creds: Credentials, m: NavModulePlan, columnUsers: ColumnUser[], shotDir: string, outRel: (f: string | null) => string | undefined, say: (l: string) => void): Promise<void> {
  try {
    for (const u of [...(m.add ?? []), ...(m.remove ?? [])]) {
      // A toggle: AMP adds the link if missing and removes it if present.
      const r = await editor.api('ToggleModuleSettingLink', { moduleid: m.moduleId, linktype: LINK_USER, linktoid: u.id });
      if (r.http !== 200) throw new Error(`AMP refused to change ${u.name || u.email} on ${m.moduleName} (HTTP ${r.http})`);
      await editor.pauseStep();
    }
    const save = await editor.api('UpdateModuleSetting', { moduleId: m.moduleId, configurationval: { items: [{ permissions: [{ moduleId: m.moduleId, display: 'specific' }] }] }, moduleType: 0 });
    const ok = (save.result as { status?: boolean } | undefined)?.status === true;
    if (!ok) throw new Error(`AMP refused the ${m.moduleName} setting: ${JSON.stringify(save.result ?? save).slice(0, 160)}`);

    // Read back: the module must now be shown to exactly the planned users.
    const after = await fetchModuleUsers(gate, creds, m.moduleId);
    const linked = new Set(after.filter((u) => u.linked).map((u) => u.name || u.email));
    const want = new Set(m.shownTo ?? []);
    const hidden = columnUsers.filter((c) => m.hideFrom.includes(c.column) && c.user && linked.has(c.user.name || c.user.email));
    if (hidden.length || [...want].some((n) => !linked.has(n))) throw new Error(`${m.moduleName} settings did not come out as planned (shown to: ${[...linked].join(', ') || 'nobody'})`);
    m.status = (m.add?.length ?? 0) + (m.remove?.length ?? 0) || m.before !== 'specific' ? 'done' : 'no_changes';
    say(`  ✓ ${m.moduleName}: shown only to ${[...linked].join(', ')}`);
  } catch (e) {
    m.status = 'failed';
    m.note = (e as Error).message;
    say(`  ✗ ${m.moduleName}: ${m.note}`);
  }
  m.shot = outRel(await editor.shotNavSettings(shotDir, `nav-${slug(m.moduleName)}.png`, m.moduleId));
}
