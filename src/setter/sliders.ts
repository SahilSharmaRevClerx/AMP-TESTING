import type { Expected, Rulebook } from '../types';
import { normalizeRoute } from '../util/route';

/**
 * Which role permissions open which AMP module. AMP decides menu/page access per module in
 * Module.HasModuleAccess (AMP repo: Libraries/MindMatrix.Libraries.Entities/Module.cs); this table is
 * that switch, written as the role-editor controls that satisfy it. Slider ids are the role editor's
 * row ids: TemplateTypes for "Marketing Functions" (media), RoleSystemIds for "Operations" (system).
 * Feature ids are RoleFeatureFlags (checkboxes on the "Advanced" tab).
 */

/** Slider steps, as the role editor shows them. */
export const LEVELS = ['NA', 'View', 'Edit', 'Create', 'Delete'] as const;
export type Step = 0 | 1 | 2 | 3 | 4;

export type Grid = 'media' | 'system';

export type Requirement =
  | { kind: 'slider'; grid: Grid; id: number; min: Step }
  | { kind: 'feature'; id: number };

export interface ModuleRule {
  /** all = every requirement is needed; any = one of them is enough. */
  mode: 'all' | 'any';
  reqs: Requirement[];
  /** Extra condition outside role sliders the tester should know about. */
  note?: string;
  /** Advanced options the page's data needs on top of `reqs`: turned on for a Yes (never off for a No). */
  features?: Requirement[];
}

/** Why a module can't be switched with role sliders. */
export interface CannotRule {
  cannot: string;
  /** AMP shows it to every role anyway: a "Yes" needs nothing, only a "No" is out of reach. */
  alwaysOn?: string;
}

/** Display names of role-editor rows. */
export const SLIDER_LABELS: Record<string, string> = {
  'media:16': 'Print (PDFs)',
  'media:32': 'Email',
  'media:128': 'Web',
  'media:256': 'eBook',
  'media:1280': 'Campaigns',
  'media:2048': 'Social',
  'media:4096': 'Link Tracking',
  'media:8192': 'External Sites',
  'media:16384': 'PowerPoint',
  'media:36864': 'Data Room',
  'media:3145728': 'Contract',
  'media:8388608': 'Video',
  'media:16777216': 'Playbooks',
  'media:67108864': 'Banner',
  'media:134217728': 'Web Banner',
  'system:100': 'Users',
  'system:300': 'Databases',
  'system:500': 'Companies',
  'system:900': 'Drip Templates',
  'system:910': 'Drip Campaigns',
  'system:940': 'Auto Publishing Templates',
  'system:1100': 'Media Templates',
  'system:1400': 'MDF Admin',
  'system:1500': 'MDF Request',
  'system:1700': 'Opportunity',
  'system:1800': 'Organizations',
  'system:2000': 'Announcement',
  'system:2100': 'Deal Registration (admin)',
  'system:2200': 'Deal Registration (user)',
  'system:2400': 'Webinar',
  'system:2500': 'Content Syndication',
  'system:2600': 'Case',
  'system:2900': 'Learning Management',
  'feature:1': 'Drip (Advanced option)',
  'feature:4': 'Auto Publishing',
  'feature:32': 'Setup menu (Marketing UI)',
  'feature:256': 'CRM Add-ons',
  'feature:1024': 'Export (Contact export)',
};

const view = (grid: Grid, id: number, min: Step = 1): Requirement => ({ kind: 'slider', grid, id, min });
const feature = (id: number): Requirement => ({ kind: 'feature', id });
const one = (r: Requirement, note?: string): ModuleRule => ({ mode: 'all', reqs: [r], note });
const all = (reqs: Requirement[], note?: string): ModuleRule => ({ mode: 'all', reqs, note });

const MARKETING_UI = feature(32);
const CONTACTS_FORCED: CannotRule = {
  cannot: 'needs the Contacts permission, which AMP forces to full on every role (the row is hidden in the role editor); hide it with Navigation Layout settings instead',
  alwaysOn: 'nothing to set: AMP gives every role the Contacts permission',
};

/** Module name (lower case, as AMP's module list returns it) → what grants it. */
export const MODULE_RULES: Record<string, ModuleRule | CannotRule> = {
  dashboard: { cannot: 'the Dashboard is always visible; what it shows depends on the persona, not on role sliders', alwaysOn: 'nothing to set: the Dashboard is always visible' },
  'rewards catalog': { cannot: 'controlled by the company Incentive Programs setting (with internal redemption) and Database → View; set it by hand' },
  'export status': one(feature(1024)),
  roles: { cannot: 'only Site/Super Admins get Roles; no role permission can grant it' },
  contacts: CONTACTS_FORCED,
  accounts: CONTACTS_FORCED,
  lists: CONTACTS_FORCED,
  import: CONTACTS_FORCED,
  'import contact offline activities': CONTACTS_FORCED,
  'contact report': CONTACTS_FORCED,
  'accounts report': CONTACTS_FORCED,
  'shared lead accounts': CONTACTS_FORCED,
  'shared lead report': CONTACTS_FORCED,
  'shared lead source': CONTACTS_FORCED,

  email: one(view('media', 32)),
  'email summary report': one(view('media', 32)),
  'email a/b test': one(view('media', 32)),
  social: all([feature(4), view('media', 2048)]),
  'social one-off posts reports': all([feature(4), view('media', 2048)]),
  'facebook page': one(view('media', 2048)),
  'facebook posts': one(view('media', 2048)),
  'twitter posts': one(view('media', 2048)),
  'linkedin posts': one(view('media', 2048)),
  opportunities: one(view('system', 1700)),
  'opportunities reports': one(view('system', 1700)),
  // The menu needs one of the sliders; the page's data (GetAllDripCampaignsForCurrentUser) also needs the Advanced "drip" option.
  'drip (lead nurturing)': { mode: 'any', reqs: [view('system', 910), view('system', 900)], features: [feature(1)] },
  'drip campaign reports': { mode: 'any', reqs: [view('system', 910), view('system', 900)], features: [feature(1)] },
  'social drip': all([feature(4), view('system', 940)]),
  website: one(view('media', 128), 'also needs the "Websites" option under Web'),
  'web reports': one(view('media', 128), 'also needs the "Websites" option under Web'),
  'landing page': one(view('media', 128)),
  'web a/b test': one(view('media', 128)),
  'landing page reports': one(view('media', 128)),
  'forms reports': one(view('media', 128)),
  'web banner': one(view('media', 134217728)),
  'web banner reports': one(view('media', 134217728)),
  'external sites': one(view('media', 8192)),
  'external sites reports': one(view('media', 8192)),
  'external links': one(view('media', 4096)),
  'external links reports': one(view('media', 4096)),
  campaigns: one(view('media', 1280)),
  'campaigns summary reports': one(view('media', 1280, 2)),
  'content syndication': one(view('system', 2500)),
  contracts: one(view('media', 3145728)),
  'course catalog': one(view('system', 2900), 'also needs the company Course Catalog set to Linear Playbook or LMS'),
  'curriculum report': one(view('system', 2900), 'also needs the company Course Catalog set to Linear Playbook or LMS'),
  'courses report': one(view('system', 2900), 'also needs the company Course Catalog set to Linear Playbook or LMS'),
  'mdf summary report': one(view('system', 1400)),
  'fund request report': one(view('system', 1400)),
  'mdf approval plans': one(view('system', 1400)),
  'mdf approval request': one(view('system', 1400)),
  'mdf fund request': one(view('system', 1500), 'the user must also belong to an organization'),
  'deal registration request': one(view('system', 2200), 'also needs Deal Registration enabled for the company'),
  'deal registration approval': one(view('system', 2100), 'also needs Deal Registration enabled for the company'),
  'database records': one(view('system', 300)),
  'content repository': one(view('system', 300)),
  'internal playbook': one(view('media', 16777216)),
  'playbook sales': one(view('media', 16777216)),
  'playbook marketing': one(view('media', 16777216)),
  'marketing campaigns': one(view('media', 16777216)),
  'playbook onboarding': one(view('media', 16777216)),
  'playbook summary': one(view('media', 16777216)),
  'non-contact centric playbooks': one(view('media', 16777216)),
  'linear playbooks summary': one(view('media', 16777216)),
  'data room': one(view('media', 36864)),
  'data rooms summary': one(view('media', 36864)),
  'view assets': one(view('system', 1100)),
  images: one(view('system', 1100)),
  documents: one(view('system', 1100)),
  'knowledge pages summary report': one(view('system', 1100)),
  pdfs: one(view('media', 16)),
  ebooks: one(view('media', 256)),
  presentations: one(view('media', 16384)),
  'banner images': one(view('media', 67108864)),
  videos: one(view('media', 8388608)),
  'users reports': one(view('system', 100)),
  'users offline activity report': one(view('system', 100)),
  users: all([MARKETING_UI, view('system', 100)]),
  companies: all([MARKETING_UI, view('system', 500)]),
  templates: all([MARKETING_UI, view('system', 1100)]),
  announcements: all([MARKETING_UI, view('system', 2000)]),
  organizations: all([MARKETING_UI, view('system', 1800), view('system', 100)]),
  case: one(view('system', 2600)),
  webinar: all([feature(256), view('system', 2400)], 'also needs the GoToWebinar add-on'),
  'gotowebinar report': all([feature(256), view('system', 2400)], 'also needs the GoToWebinar add-on'),
};

/**
 * Pages whose module name differs per company (custom menu modules), matched by route instead.
 * journeys: Libraries/MindMatrix.Libraries.Pages/navin/internalplaybook/journeys.cshtml.cs requires Playbooks → View.
 */
export const ROUTE_RULES: Record<string, ModuleRule> = {
  journeys: one(view('media', 16777216), 'a company menu module: it must also be visible in Navigation Layout'),
};

/** A module as AMP's Navigation Layout API lists it. */
export interface AmpModule {
  id: number;
  name: string;
  url: string;
  label?: string;
  /** A company-made (custom) menu module. */
  custom?: boolean;
}

export function reqKey(r: Requirement): string {
  return r.kind === 'slider' ? `${r.grid}:${r.id}` : `feature:${r.id}`;
}

export function reqLabel(r: Requirement | string): string {
  const k = typeof r === 'string' ? r : reqKey(r);
  return SLIDER_LABELS[k] ?? k;
}

/**
 * The module a rulebook page belongs to: the same url, else the longest module url the route sits
 * under ("collateral/internal-playbook/sales" → "collateral/internal-playbook"), else the same name.
 */
export function findModule(route: string, label: string, modules: AmpModule[]): AmpModule | null {
  const r = normalizeRoute(route);
  let best: AmpModule | null = null;
  for (const m of modules) {
    const u = normalizeRoute(m.url);
    if (!u) continue;
    if (u === r) return m;
    if (r.startsWith(u + '/') && (!best || u.length > normalizeRoute(best.url).length)) best = m;
  }
  if (best) return best;
  const n = label.trim().toLowerCase();
  return (n && modules.find((m) => m.name.toLowerCase() === n || m.label?.toLowerCase() === n)) || null;
}

// ---------------------------------------------------------------- plan

export interface PagePlan {
  ruleId: string;
  label: string;
  route: string;
  expected: Expected;
  module: string | null;
  status: 'planned' | 'cannot' | 'not_specified';
  /** Role-editor controls this page needs moved (keys like "media:32"). */
  controls: string[];
  reason: string;
  note?: string;
}

/** What the rulebook wants from one role-editor control, before its current value is known. */
export interface ControlWant {
  key: string;
  kind: 'slider' | 'feature';
  grid?: Grid;
  id: number;
  label: string;
  /** Highest minimum step any "Yes" page needs (sliders), or true (features). */
  raiseTo: Step | null;
  /** A "No" page wants this slider at NA. */
  lower: boolean;
  /** "Set every slider" mode: this exact step, up or down. */
  exact?: Step;
  /** Pages behind each wish, for the report. */
  yesPages: string[];
  noPages: string[];
}

export interface RolePlan {
  userType: string;
  label: string;
  roleName: string;
  pages: PagePlan[];
  controls: ControlWant[];
  /** "Set every slider" mode: every visible slider of the role goes to this step (controls are filled once the role is open). */
  bulkStep?: Step;
}

/**
 * Turns one rulebook column into slider moves for the role that column stands for.
 * Yes → each control the module needs is raised to at least its minimum (never lowered).
 * No  → the module's slider goes to NA: for "all" modules only the first slider is enough (so a
 * shared one like Users isn't taken away from other pages); for "any" modules every slider.
 * Features are only turned on, never off (Setup menu also opens other pages).
 * When a Yes and a No meet on one slider, Yes wins and the No page is reported as a conflict.
 */
export function planRole(rulebook: Rulebook, userType: string, roleName: string, modules: AmpModule[]): RolePlan {
  const wants = new Map<string, ControlWant>();
  const want = (r: Requirement): ControlWant => {
    const key = reqKey(r);
    let w = wants.get(key);
    if (!w) {
      w = { key, kind: r.kind, grid: r.kind === 'slider' ? r.grid : undefined, id: r.id, label: reqLabel(r), raiseTo: null, lower: false, yesPages: [], noPages: [] };
      wants.set(key, w);
    }
    return w;
  };

  const pages: PagePlan[] = [];
  for (const rule of rulebook.rules) {
    if (rule.type !== 'page' || !rule.route) continue;
    const expected = rule.expected[userType] ?? null;
    const base = { ruleId: rule.id, label: rule.label, route: rule.route, expected, controls: [] as string[] };
    if (expected === null) {
      pages.push({ ...base, module: null, status: 'not_specified', reason: 'no Yes/No in the rulebook for this column' });
      continue;
    }
    const mod = findModule(rule.route, rule.label, modules);
    // Persona dashboards (dashboard/sales, dashboard/channelmanager…) are the Dashboard module.
    if (!mod && normalizeRoute(rule.route).split('/')[0] === 'dashboard') {
      const d = MODULE_RULES.dashboard as CannotRule;
      pages.push({ ...base, module: 'Dashboard', status: expected === 'Yes' ? 'planned' : 'cannot', reason: expected === 'Yes' ? d.alwaysOn! : d.cannot });
      continue;
    }
    if (!mod) {
      pages.push({ ...base, module: null, status: 'cannot', reason: "not found in this company's module list (Navigation Layout); set it by hand" });
      continue;
    }
    const entry = MODULE_RULES[mod.name.toLowerCase()] ?? ROUTE_RULES[normalizeRoute(rule.route)];
    if (!entry) {
      pages.push({
        ...base,
        module: mod.name,
        status: 'cannot',
        reason: mod.custom
          ? `"${mod.name}" is a company menu module: who sees it is set in Navigation Layout, not by role sliders; set it by hand`
          : `no known role slider for module "${mod.name}"; set it by hand`,
      });
      continue;
    }
    if ('cannot' in entry) {
      if (expected === 'Yes' && entry.alwaysOn) pages.push({ ...base, module: mod.name, status: 'planned', reason: entry.alwaysOn });
      else pages.push({ ...base, module: mod.name, status: 'cannot', reason: entry.cannot });
      continue;
    }
    const sliders = entry.reqs.filter((r): r is Extract<Requirement, { kind: 'slider' }> => r.kind === 'slider');
    if (expected === 'Yes') {
      const reqs = [...(entry.mode === 'all' ? entry.reqs : entry.reqs.slice(0, 1)), ...(entry.features ?? [])];
      for (const r of reqs) {
        const w = want(r);
        w.raiseTo = r.kind === 'slider' ? (Math.max(w.raiseTo ?? 0, r.min) as Step) : 1;
        w.yesPages.push(rule.label);
        base.controls.push(w.key);
      }
    } else {
      const reqs = entry.mode === 'all' ? sliders.slice(0, 1) : sliders;
      for (const r of reqs) {
        const w = want(r);
        w.lower = true;
        w.noPages.push(rule.label);
        base.controls.push(w.key);
      }
    }
    if (expected === 'No' && !base.controls.length) {
      // Only an Advanced checkbox opens it; the tool never turns checkboxes off (they open other pages too).
      pages.push({ ...base, module: mod.name, status: 'cannot', reason: `only the Advanced option "${entry.reqs.map((r) => reqLabel(r)).join(' + ')}" controls it, and the tool never turns options off; untick it by hand if no other page needs it` });
      continue;
    }
    const sliderKeys = base.controls.filter((k) => !k.startsWith('feature:'));
    const featureKeys = base.controls.filter((k) => k.startsWith('feature:'));
    const reason =
      expected === 'Yes'
        ? [sliderKeys.length ? `raise ${sliderKeys.map(reqLabel).join(' + ')} to at least ${minLabel(entry, sliderKeys)}` : '', featureKeys.length ? `turn on ${featureKeys.map(reqLabel).join(' + ')}` : ''].filter(Boolean).join(', ')
        : `set ${base.controls.map(reqLabel).join(' + ')} to NA`;
    pages.push({ ...base, module: mod.name, status: 'planned', reason, note: entry.note });
  }

  // A No page whose slider is also needed by a Yes page can't be hidden this way.
  for (const p of pages) {
    if (p.status !== 'planned' || p.expected !== 'No') continue;
    const clash = p.controls.map((k) => wants.get(k)!).find((w) => w.raiseTo !== null);
    if (clash) {
      p.status = 'cannot';
      p.reason = `conflict: ${clash.label} must stay on for ${clash.yesPages.join(', ')} (Yes), so this page can't be hidden with role sliders`;
    }
  }

  return { userType, label: rulebook.userTypeLabels[userType] ?? userType, roleName, pages, controls: [...wants.values()] };
}

function minLabel(entry: ModuleRule, keys: string[]): string {
  const steps = entry.reqs.filter((r) => r.kind === 'slider' && keys.includes(reqKey(r))).map((r) => (r as { min: Step }).min);
  return LEVELS[(steps.length ? Math.max(...steps) : 1) as Step];
}

/** The value a control should end at, given its current value. Null = leave it alone. */
export function targetFor(w: ControlWant, current: number | boolean): number | boolean | null {
  if (w.kind === 'feature') return w.raiseTo !== null && current !== true ? true : null;
  const cur = Number(current);
  if (w.exact !== undefined) return cur !== w.exact ? w.exact : null;
  if (w.raiseTo !== null) return cur < w.raiseTo ? w.raiseTo : null;
  if (w.lower) return cur !== 0 ? 0 : null;
  return null;
}

export function valueLabel(w: Pick<ControlWant, 'kind'>, v: number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '-';
  if (w.kind === 'feature') return v ? 'on' : 'off';
  return LEVELS[Number(v) as Step] ?? String(v);
}
