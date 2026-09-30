import { describe, expect, it } from 'vitest';
import { headerKey, loadRulebook, parseCsv, parseRulebook, rulebookFromRows, rulebookSummary, selectUserTypes } from '../src/rulebook/parse';

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
    expect(() => rulebookFromRows([['page', 'notes'], ['x', '']])).toThrow(/No user-type columns/);
    expect(() => rulebookFromRows([['page', 'Owner'], ['x', 'Rahul']])).toThrow(/Owner \(not Yes\/No values/);
  });
});

describe('column detection', () => {
  const sheet = [
    ['Internal User Personas', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Page', 'Name', 'Site Admin', 'Channel Manager', 'Owner', 'Unused', 'Icon'],
    ['/#setup/roles', 'Roles', 'Yes', 'No', 'Rahul', '', 'fa-user'],
    ['/#setup/users/list', 'Users', 'Y', 'N', 'Priya', '', 'fa-users'],
    ['/#connections/contacts', 'Contacts', 'Yes', '', 'Rahul', '', ''],
  ];

  it('skips title rows above the real header', () => {
    const rb = rulebookFromRows(sheet.filter((r) => r.some((c) => c)));
    expect(rb.headerRow).toBe(2); // the title row, then the header (empty rows are already dropped by the readers)
    expect(rb.rules.map((r) => r.route)).toEqual(['setup/roles', 'setup/users/list', 'connections/contacts']);
  });

  it('decides user types by values: Yes/No columns only; empty and text columns are info', () => {
    const rb = rulebookFromRows(sheet.filter((r) => r.some((c) => c)));
    expect(rb.userTypes).toEqual(['site_admin', 'channel_manager']);
    const roles = Object.fromEntries(rb.columns!.map((c) => [c.label, c.role + (c.reason ? `: ${c.reason}` : '')]));
    expect(roles).toEqual({
      Page: 'page',
      Name: 'name',
      'Site Admin': 'user',
      'Channel Manager': 'user',
      Owner: 'info: not Yes/No values (e.g. "Rahul")',
      Unused: 'info: empty column',
      Icon: 'info: descriptive column',
    });
  });

  it('a user-type column with a typo points at the cell instead of being dropped', () => {
    expect(() =>
      rulebookFromRows([
        ['page', 'Partner'],
        ['a', 'Yes'],
        ['b', 'No'],
        ['c', 'Yes'],
        ['d', 'No'],
        ['e', 'Yse'],
      ]),
    ).toThrow(/Row 6 \(e\), column "Partner": expected Yes\/No\/empty, got "Yse"/);
  });

  it('the tester can untick a detected column', () => {
    const rb = rulebookFromRows(sheet.filter((r) => r.some((c) => c)));
    expect(selectUserTypes(rb, ['channel_manager']).userTypes).toEqual(['channel_manager']);
    expect(selectUserTypes(rb, undefined)).toBe(rb);
    expect(() => selectUserTypes(rb, [])).toThrow(/at least one/);
  });
});

describe('user types come from the sheet', () => {
  it('keeps the header text as written, in sheet order, whatever the client calls them', () => {
    const rb = rulebookFromRows([
      ['Page', 'Channel Manager', 'Partner User', 'Corporate PRM Admin'],
      ['/#setup/roles', 'No', 'No', 'Yes'],
    ]);
    expect(rb.userTypes).toEqual(['channel_manager', 'partner_user', 'corporate_prm_admin']);
    expect(rb.userTypeLabels).toEqual({ channel_manager: 'Channel Manager', partner_user: 'Partner User', corporate_prm_admin: 'Corporate PRM Admin' });
    expect(rulebookSummary(rb).userTypeLabels.corporate_prm_admin).toBe('Corporate PRM Admin');
  });
});

describe('Excel (.xlsx) rulebooks', () => {
  it('reads the first sheet, including URLs Excel turned into hyperlinks', async () => {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Rules');
    ws.addRow(['Page', 'Site Admin', 'Normal User']);
    ws.addRow(['/#intel/clientsentiment', 'Yes', 'No']);
    const url = 'https://itbydesign.sb.amp.vg/#intel/account';
    ws.addRow(['', 'Yes', 'Yes']);
    ws.getCell('A3').value = { text: url, hyperlink: url };
    const rb = await parseRulebook('itbd.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
    expect(rb.userTypes).toEqual(['site_admin', 'normal_user']);
    expect(rb.rules.map((r) => r.route)).toEqual(['intel/clientsentiment', 'intel/account']);
    expect(rb.rules[1]!.expected).toEqual({ site_admin: 'Yes', normal_user: 'Yes' });
  }, 20000); // first load of the Excel library can be slow on a cold start

  it('gives a clear message for a broken file and for old .xls', async () => {
    await expect(parseRulebook('broken.xlsx', Buffer.from('not a zip'))).rejects.toThrow(/not a valid Excel/);
    await expect(parseRulebook('old.xls', Buffer.from('x'))).rejects.toThrow(/\.xls files are not supported/);
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
