import { describe, expect, it } from 'vitest';
import { headerKey, loadRulebook, parseCsv, rulebookFromRows, withAllowAllColumn } from '../src/rulebook/parse';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes and CRLF', () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\n')).toEqual([
      ['a', 'b,c', 'd "e"'],
      ['1', '2', '3'],
    ]);
  });
});

describe('headerKey', () => {
  it('normalizes user-type headers', () => {
    expect(headerKey(' Site Admin ')).toBe('site_admin');
    expect(headerKey('Partner-Sales')).toBe('partner_sales');
    expect(headerKey('Page URL')).toBe('page_url');
  });
});

describe('rulebookFromRows — simple format (page + one column per user type)', () => {
  it('every non-page column is a user type; full URLs and /# routes are normalized', () => {
    const rb = rulebookFromRows([
      ['Page', 'Site Admin', 'Super Admin', 'Normal User'],
      ['/#setup/roles', 'Yes', 'yes', 'No'],
      ['https://ai.sb.amp.vg/#connections/contacts', 'Y', 'Y', 'Y'],
    ]);
    expect(rb.userTypes).toEqual(['site_admin', 'super_admin', 'normal_user']);
    expect(rb.rules.map((r) => r.route)).toEqual(['setup/roles', 'connections/contacts']);
    expect(rb.rules[0]!.expected).toEqual({ site_admin: 'Yes', super_admin: 'Yes', normal_user: 'No' });
    expect(rb.rules[0]!.label).toBe('setup/roles');
  });

  it('uses an optional name column and ignores notes', () => {
    const rb = rulebookFromRows([
      ['url', 'name', 'admin', 'notes'],
      ['#setup/roles', 'Roles', 'No', 'check this'],
    ]);
    expect(rb.userTypes).toEqual(['admin']);
    expect(rb.rules[0]).toMatchObject({ label: 'Roles', notes: 'check this', expected: { admin: 'No' } });
  });

  it('keeps empty cells as null (never guessed), skips rows without a page and duplicates', () => {
    const rb = rulebookFromRows([
      ['page', 'cm'],
      ['x', ''],
      ['', 'Yes'],
      ['x/', 'Yes'],
      ['mailto:help@x.com', 'Yes'],
    ]);
    expect(rb.rules).toHaveLength(1);
    expect(rb.rules[0]!.expected.cm).toBeNull();
  });

  it('explains what is wrong', () => {
    expect(() => rulebookFromRows([['name', 'cm'], ['Roles', 'Yes']])).toThrow(/column for the page/);
    expect(() => rulebookFromRows([['page', 'notes'], ['x', '']])).toThrow(/user-type column/);
    expect(() => rulebookFromRows([['page', 'cm'], ['x', 'maybe']])).toThrow(/Yes\/No/);
    expect(() => rulebookFromRows([['page', 'cm'], ['', 'Yes']])).toThrow(/no pages/);
  });
});

describe('withAllowAllColumn', () => {
  it('adds a column expecting Yes on every page, keeping existing columns', () => {
    const rb = rulebookFromRows([['page', 'cm'], ['setup/roles', 'No']]);
    const out = withAllowAllColumn(rb, 'site_admin');
    expect(out.userTypes).toEqual(['site_admin', 'cm']);
    expect(out.rules[0]!.expected).toEqual({ site_admin: 'Yes', cm: 'No' });
    expect(withAllowAllColumn(out, 'site_admin')).toBe(out);
  });
});

describe('shipped rulebooks', () => {
  it('old persona sheet still loads: menu headings and external links are skipped', async () => {
    const rb = await loadRulebook('rulebook/internal-user-personas.csv');
    expect(rb.userTypes).toEqual(['channel_manager', 'corporate_prm_admin', 'partner_sales']);
    expect(rb.rules.length).toBeGreaterThan(80);
    expect(rb.rules.every((r) => r.route.length > 0)).toBe(true);
    expect(rb.rules.find((r) => r.route === 'setup/roles')!.expected.corporate_prm_admin).toBe('Yes');
  });

  it('template loads', async () => {
    const rb = await loadRulebook('rulebook/template.csv');
    expect(rb.userTypes).toEqual(['site_admin', 'super_admin', 'normal_user']);
  });
});
