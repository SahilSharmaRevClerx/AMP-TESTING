import type { AmpModule, PagePlan, RolePlan } from './sliders';
import { MODULE_RULES, findModule } from './sliders';

/**
 * Navigation Layout step: for pages role sliders can't hide (Contacts, Lists, Import, company menu
 * modules), use Navigation Layout → module → Settings ("Shown to: specific users").
 *
 * AMP's rule (Libraries/MindMatrix.Libraries.Entities/Module.cs, CustomModuleAccess / CheckModuleAccess):
 * with display "specific" a module is a whitelist: only linked users (or personas, groups,
 * organizations) see it, and its page redirects everyone else to /noaccess. Super Admins are not
 * exempt. So "hide X from Anmol" = display "specific" + a link for every other user of the company.
 */

/** A company user, as Navigation Layout's Users tab lists them (GetModuleSettingData type 2). */
export interface CompanyUser {
  id: number;
  email: string;
  name: string;
  /** Linked to the module (shown) in the current settings. */
  linked: boolean;
}

/** The AMP user a rulebook column stands for, if it could be identified. */
export interface ColumnUser {
  column: string;
  label: string;
  /** What the tester gave (email) or the name from the user's jwt. */
  hint: string;
  user?: { id: number; email: string; name: string };
  problem?: string;
}

export interface NavModulePlan {
  moduleId: number;
  moduleName: string;
  pages: string[];
  /** Columns whose user must not see it / must see it. */
  hideFrom: string[];
  showTo: string[];
  /** Filled once the module's current settings are read. */
  before?: string;
  after?: string;
  add?: CompanyUser[];
  remove?: CompanyUser[];
  /** Users who will see it afterwards (the whitelist). */
  shownTo?: string[];
  status?: 'planned' | 'done' | 'no_changes' | 'skipped' | 'failed';
  note?: string;
  shot?: string;
}

/** Which modules Navigation Layout settings can fix: pages AMP gives every role (Contacts …) and company menu modules. */
function navFixable(mod: AmpModule): boolean {
  const entry = MODULE_RULES[mod.name.toLowerCase()];
  return (!!entry && 'cannot' in entry && entry.nav === true) || (mod.custom === true && !entry);
}

/** Matches a column's user among the company's users: by email, else by full name (either order). */
export function matchUser(hint: string, users: CompanyUser[]): { user?: CompanyUser; problem?: string } {
  const h = hint.trim().toLowerCase();
  if (!h) return { problem: 'no user given' };
  if (h.includes('@')) {
    const u = users.find((x) => x.email.toLowerCase() === h);
    return u ? { user: u } : { problem: `no user with email ${hint} in this company` };
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  const hits = users.filter((x) => norm(x.name) === norm(h));
  if (hits.length === 1) return { user: hits[0] };
  if (hits.length > 1) return { problem: `${hits.length} users are called "${hint}": enter the email instead` };
  return { problem: `no user called "${hint}" in this company: enter the email instead` };
}

/**
 * The Navigation Layout changes the rulebook needs: one entry per module that a "No" page needs hidden
 * from some column's user. Only columns whose user is known take part.
 */
export function planNavigation(plans: RolePlan[], modules: AmpModule[], columnUsers: ColumnUser[]): NavModulePlan[] {
  const known = new Set(columnUsers.filter((c) => c.user).map((c) => c.column));
  const byModule = new Map<number, NavModulePlan>();
  for (const plan of plans) {
    if (!known.has(plan.userType)) continue;
    for (const page of plan.pages) {
      if (page.expected !== 'Yes' && page.expected !== 'No') continue;
      const mod = findModule(page.route, page.label, modules);
      if (!mod || !navFixable(mod)) continue;
      let m = byModule.get(mod.id);
      if (!m) {
        m = { moduleId: mod.id, moduleName: mod.name, pages: [], hideFrom: [], showTo: [] };
        byModule.set(mod.id, m);
      }
      if (!m.pages.includes(page.label)) m.pages.push(page.label);
      const list = page.expected === 'No' ? m.hideFrom : m.showTo;
      if (!list.includes(plan.userType)) list.push(plan.userType);
    }
  }
  // Only modules someone must not see; a column that is both Yes and No for one module can't be satisfied.
  const out = [...byModule.values()].filter((m) => m.hideFrom.length);
  for (const m of out) {
    const both = m.hideFrom.filter((c) => m.showTo.includes(c));
    if (both.length) {
      m.status = 'skipped';
      m.note = `rulebook says both Yes and No for ${both.join(', ')} on pages of this module (${m.pages.join(', ')})`;
    }
  }
  return out;
}

/** Marks the rulebook pages a Navigation Layout change takes care of, so the plan and report say so. */
export function markNavPages(plans: RolePlan[], nav: NavModulePlan[], modules: AmpModule[]): void {
  for (const plan of plans) {
    for (const page of plan.pages) {
      const mod = findModule(page.route, page.label, modules);
      const m = mod && nav.find((n) => n.moduleId === mod.id && n.status !== 'skipped');
      if (!m) continue;
      if (m.hideFrom.includes(plan.userType)) setNav(page, `Navigation Layout: hide ${m.moduleName} from this user`);
      else if (m.showTo.includes(plan.userType)) setNav(page, `Navigation Layout: ${m.moduleName} stays visible to this user`);
    }
  }
}

function setNav(page: PagePlan, reason: string): void {
  page.status = 'planned';
  page.reason = reason;
  page.nav = true;
}

/**
 * Who must be linked after the change: every company user except the columns' "No" users (so the
 * rest of the company keeps the module), plus the "Yes" users. Returns the links to add and remove.
 */
export function navChanges(m: NavModulePlan, users: CompanyUser[], columnUsers: ColumnUser[], display: string): Pick<NavModulePlan, 'add' | 'remove' | 'shownTo'> {
  const idOf = (cols: string[]) => new Set(cols.map((c) => columnUsers.find((x) => x.column === c)?.user?.id).filter((x): x is number => !!x));
  const hide = idOf(m.hideFrom);
  const show = idOf(m.showTo);
  // "all": everyone sees it today, so everyone except the hidden users keeps it. "specific": keep its
  // current whitelist (minus the hidden users, plus the shown ones). "hidden": nobody, so only the shown users.
  const keep = (u: CompanyUser) => !hide.has(u.id) && (display === 'all' ? true : display === 'specific' ? u.linked || show.has(u.id) : show.has(u.id));
  const add = users.filter((u) => keep(u) && !u.linked);
  const remove = users.filter((u) => !keep(u) && u.linked);
  return { add, remove, shownTo: users.filter(keep).map((u) => u.name || u.email) };
}
