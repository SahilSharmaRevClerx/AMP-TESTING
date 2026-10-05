import { describe, expect, it } from 'vitest';
import { rulebookFromRows } from '../src/rulebook/parse';
import { findModule, planRole, targetFor, type AmpModule } from '../src/setter/sliders';
import { parseModules } from '../src/setter/session';
import { decideSetterRequest } from '../src/safety/gate';

const MODULES: AmpModule[] = [
  { id: 1, name: 'Dashboard', url: 'dashboard' },
  { id: 2, name: 'Internal Playbook', url: 'collateral/internal-playbook' },
  { id: 3, name: 'Contacts', url: 'connections/contacts' },
  { id: 4, name: 'Roles', url: 'setup/roles' },
  { id: 5, name: 'Users', url: 'setup/users/list' },
  { id: 6, name: 'Users Reports', url: 'report/users' },
  { id: 7, name: 'Opportunities', url: 'manage/opportunity/records' },
  { id: 8, name: 'Email', url: 'campaign/email' },
];

const RB = rulebookFromRows([
  ['page', 'name', 'Super Admin', 'User'],
  ['https://main.dvl.amp.vg/#collateral/internal-playbook', 'Internal Playbook', 'Yes', 'No'],
  ['#dashboard/sales', 'Sales Dashboard', 'Yes', 'Yes'],
  ['#connections/contacts', 'Contacts', 'Yes', 'No'],
  ['#setup/roles', 'Roles', 'Yes', 'No'],
  ['#manage/opportunity/records', 'Opportunities', 'Yes', 'Yes'],
  ['#setup/users/list', 'Users', 'Yes', 'Yes'],
  ['#report/users', 'Users Reports', 'Yes', 'No'],
  ['#campaign/email', 'Email', 'Yes', ''],
  ['#something/unknown', 'Unknown page', 'Yes', 'No'],
]);

describe('permission setter: page → module', () => {
  it('matches the exact url, a page under a module url, or the module name', () => {
    expect(findModule('collateral/internal-playbook', '', MODULES)?.name).toBe('Internal Playbook');
    expect(findModule('collateral/internal-playbook/sales', '', MODULES)?.name).toBe('Internal Playbook');
    expect(findModule('elsewhere', 'email', MODULES)?.name).toBe('Email');
    expect(findModule('nothing/here', 'Nope', MODULES)).toBeNull();
  });
});

describe('permission setter: plan for one rulebook column', () => {
  const plan = planRole(RB, 'user', 'PT User Role', MODULES);
  const page = (label: string) => plan.pages.find((p) => p.label === label)!;
  const control = (key: string) => plan.controls.find((c) => c.key === key);

  it('Yes raises the module slider (and Setup menu where the module needs it)', () => {
    expect(page('Opportunities').status).toBe('planned');
    expect(control('system:1700')?.raiseTo).toBe(1);
    expect(page('Users').controls).toEqual(['feature:32', 'system:100']);
    expect(control('feature:32')?.raiseTo).toBe(1);
  });

  it('No sets the slider to NA', () => {
    expect(page('Internal Playbook').status).toBe('planned');
    expect(control('media:16777216')).toMatchObject({ lower: true, raiseTo: null });
  });

  it("a No that shares a slider with a Yes page is a conflict, and the slider stays on", () => {
    expect(page('Users Reports').status).toBe('cannot');
    expect(page('Users Reports').reason).toMatch(/conflict.*Users/);
    expect(control('system:100')?.raiseTo).toBe(1);
  });

  it('pages no role slider controls are reported, not guessed', () => {
    expect(page('Sales Dashboard')).toMatchObject({ status: 'planned', controls: [] });
    expect(page('Sales Dashboard').reason).toMatch(/nothing to set/);
    expect(page('Contacts').reason).toMatch(/forces/);
    expect(page('Roles').reason).toMatch(/Site\/Super Admin/);
    expect(page('Unknown page').reason).toMatch(/module list/);
    expect(page('Email').status).toBe('not_specified');
  });
});

describe('permission setter: target values', () => {
  const w = (o: object) => ({ key: 'k', kind: 'slider' as const, id: 1, label: 'x', raiseTo: null, lower: false, yesPages: [], noPages: [], ...o });
  it('raises only when below the minimum, never lowers a Yes', () => {
    expect(targetFor(w({ raiseTo: 1 }), 0)).toBe(1);
    expect(targetFor(w({ raiseTo: 1 }), 3)).toBeNull();
    expect(targetFor(w({ raiseTo: 1, lower: true }), 2)).toBeNull();
  });
  it('lowers to NA for No', () => {
    expect(targetFor(w({ lower: true }), 4)).toBe(0);
    expect(targetFor(w({ lower: true }), 0)).toBeNull();
  });
  it('turns features on, never off', () => {
    expect(targetFor(w({ kind: 'feature', raiseTo: 1 }), false)).toBe(true);
    expect(targetFor(w({ kind: 'feature', raiseTo: 1 }), true)).toBeNull();
    expect(targetFor(w({ kind: 'feature' }), true)).toBeNull();
  });
});

describe('permission setter: AMP module list', () => {
  it('keeps modules, skips groups', () => {
    const m = parseModules([{ id: 2, name: 'Email', url: 'campaign/email', defaultlocalization: 'Email' }, { id: 9, name: 'Group', isgroup: true }, null]);
    expect(m).toEqual([{ id: 2, name: 'Email', url: 'campaign/email', label: 'Email', custom: false }]);
  });

  it('a Yes on drip also turns on the Advanced "drip" option its data needs; a No only lowers the sliders', () => {
    const rb = rulebookFromRows([['page', 'A', 'B'], ['#manage/campaigns/drip', 'Yes', 'No']]);
    const mods = [{ id: 1, name: 'Drip (Lead Nurturing)', url: 'manage/campaigns/drip' }];
    expect(planRole(rb, 'a', 'R', mods).pages[0]!.controls).toEqual(['system:910', 'feature:1']);
    expect(planRole(rb, 'b', 'R', mods).pages[0]!.controls).toEqual(['system:910', 'system:900']);
  });

  it('journeys (a company menu module) is set by route: Playbooks → View', () => {
    const rb = rulebookFromRows([['page', 'User'], ['#journeys', 'Yes'], ['#custompage', 'Yes']]);
    const mods = [{ id: 1, name: 'Journeys v5', url: 'journeys', custom: true }, { id: 2, name: 'My Custom Page', url: 'custompage', custom: true }];
    const [journeys, custom] = planRole(rb, 'user', 'R', mods).pages;
    expect(journeys).toMatchObject({ status: 'planned', controls: ['media:16777216'] });
    expect(custom!.status).toBe('cannot');
    expect(custom!.reason).toMatch(/company menu module/);
  });
});

describe('permission setter: browser gate', () => {
  const host = 'main.dvl.amp.vg';
  it('allows SaveRole only when applying', () => {
    expect(decideSetterRequest('POST', 'https://main.dvl.amp.vg/api/SaveRole', host, true).allowed).toBe(true);
    expect(decideSetterRequest('POST', 'https://main.dvl.amp.vg/api/SaveRole', host, false).allowed).toBe(false);
  });
  it('keeps every other write blocked', () => {
    expect(decideSetterRequest('POST', 'https://main.dvl.amp.vg/api/AddRemoveRoleToUser', host, true).allowed).toBe(false);
    expect(decideSetterRequest('POST', 'https://main.dvl.amp.vg/api/DeleteRoles', host, true).allowed).toBe(false);
    expect(decideSetterRequest('POST', 'https://other.host/api/SaveRole', host, true).allowed).toBe(false);
    expect(decideSetterRequest('POST', 'https://main.dvl.amp.vg/api/GetRoles', host, false).allowed).toBe(true);
  });
});

describe('permission setter: persona dashboards', () => {
  it('reports dashboard/<persona> as the always-visible Dashboard', () => {
    const rb = rulebookFromRows([['page', 'User'], ['#dashboard/sales', 'Yes']]);
    const p = planRole(rb, 'user', 'R', []).pages[0]!;
    expect(p.module).toBe('Dashboard');
    expect(p.reason).toMatch(/always visible/);
    const no = planRole(rulebookFromRows([['page', 'User'], ['#dashboard/sales', 'No']]), 'user', 'R', []).pages[0]!;
    expect(no.status).toBe('cannot');
  });

  it('a Yes on a page every role gets needs nothing; a No on it is out of reach', () => {
    const rb = rulebookFromRows([['page', 'User'], ['#connections/contacts', 'Yes'], ['#connections/lists', 'No'], ['#connections/export/status', 'Yes']]);
    const mods = [{ id: 1, name: 'Contacts', url: 'connections/contacts' }, { id: 2, name: 'Lists', url: 'connections/lists' }, { id: 3, name: 'Export Status', url: 'connections/export/status' }];
    const [contacts, lists, exportsPage] = planRole(rb, 'user', 'R', mods).pages;
    expect(contacts).toMatchObject({ status: 'planned', controls: [] });
    expect(lists!.status).toBe('cannot');
    expect(exportsPage).toMatchObject({ status: 'planned', controls: ['feature:1024'] });
  });
});

describe('permission setter: set every slider', () => {
  const w = { key: 'media:32', kind: 'slider' as const, id: 32, label: 'Email', raiseTo: null, lower: false, exact: 1 as const, yesPages: [], noPages: [] };
  it('moves to exactly the chosen level, up or down', () => {
    expect(targetFor(w, 0)).toBe(1);
    expect(targetFor(w, 4)).toBe(1);
    expect(targetFor(w, 1)).toBeNull();
  });
});
