import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { Expected, Rule, Rulebook, RuleType } from '../types';
import { normalizeRoute, slug } from '../util/route';

/** Header names (normalized) that hold the page to test. The first one found is used. */
const ROUTE_HEADERS = ['page', 'page_url', 'url', 'route', 'link', 'path', 'hash_route'];
/** Header names that hold a human-readable page name. */
const LABEL_HEADERS = ['label', 'name', 'page_name', 'title', 'sub_menu', 'main_menu'];
/** Descriptive columns that are never user types. */
const IGNORED_HEADERS = ['type', 'parent', 'notes', 'note', 'comments', 'comment', 'icon', 'info_tip', 'description', 'module'];

/** "Site Admin" -> "site_admin", "Partner-Sales " -> "partner_sales". */
export function headerKey(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function parseExpected(raw: string, where: string): Expected {
  const v = raw.trim().toLowerCase();
  if (v === '') return null;
  if (['yes', 'y', 'true', '1'].includes(v)) return 'Yes';
  if (['no', 'n', 'false', '0'].includes(v)) return 'No';
  throw new Error(`${where}: expected Yes/No/empty, got "${raw}"`);
}

/**
 * Reads a rulebook: one column with the page (page / url / route …) and one Yes/No column per user type.
 * Any column that isn't the page, a page name or a known descriptive column is a user type,
 * so each client can have its own (site_admin, super_admin, normal_user, …).
 * Rows without a page (e.g. menu headings) and rows typed "external"/"group" are skipped.
 */
export function rulebookFromRows(rows: string[][]): Rulebook {
  const [header, ...body] = rows;
  if (!header) throw new Error('Rulebook is empty');
  const keys = header.map(headerKey);

  const routeIdx = keys.findIndex((k) => ROUTE_HEADERS.includes(k));
  if (routeIdx < 0) throw new Error(`Rulebook needs a column for the page, named one of: ${ROUTE_HEADERS.join(', ')}. Found: ${header.join(', ')}`);
  const labelIdx = keys.findIndex((k) => LABEL_HEADERS.includes(k));
  const typeIdx = keys.indexOf('type');
  const parentIdx = keys.indexOf('parent');
  const notesIdx = keys.findIndex((k) => ['notes', 'note', 'comments', 'comment'].includes(k));

  const userCols = keys
    .map((k, i) => ({ k, i }))
    .filter(({ k, i }) => k && i !== routeIdx && !ROUTE_HEADERS.includes(k) && !LABEL_HEADERS.includes(k) && !IGNORED_HEADERS.includes(k));
  if (userCols.length === 0) throw new Error('Rulebook needs at least one user-type column (e.g. site_admin, super_admin, normal_user) with Yes/No values');
  const dupes = userCols.map((c) => c.k).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupes.length) throw new Error(`Duplicate user-type columns: ${[...new Set(dupes)].join(', ')}`);

  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const seenRoutes = new Set<string>();
  const seenIds = new Set<string>();
  const rules: Rule[] = [];

  body.forEach((r, i) => {
    const line = i + 2;
    const type = cell(r, typeIdx).toLowerCase();
    if (type === 'external' || type === 'group') return;
    const route = normalizeRoute(cell(r, routeIdx));
    if (!route || /^(mailto:|javascript:|https?:)/.test(route)) return;
    if (seenRoutes.has(route)) return;
    seenRoutes.add(route);

    const label = cell(r, labelIdx) || route;
    const expected: Record<string, Expected> = {};
    for (const { k, i: col } of userCols) expected[k] = parseExpected(cell(r, col), `Row ${line} (${label}) column ${header[col]}`);

    let id = slug(route);
    while (seenIds.has(id)) id += '-x';
    seenIds.add(id);
    rules.push({ id, type: 'page' as RuleType, parent: cell(r, parentIdx), label, route, expected, notes: cell(r, notesIdx) });
  });

  if (rules.length === 0) throw new Error('Rulebook has no pages to test');
  return { userTypes: userCols.map((c) => c.k), rules };
}

async function readXlsxRows(data: Buffer, name: string): Promise<string[][]> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`${name} has no worksheets`);
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = row.getCell(c).text;
      values.push(v == null ? '' : String(v));
    }
    rows.push(values);
  });
  return rows;
}

/** Parses a rulebook from file contents (.xlsx or .csv, decided by the name's extension). */
export async function parseRulebook(name: string, data: Buffer): Promise<Rulebook> {
  const ext = extname(name).toLowerCase();
  if (ext === '.xls') throw new Error('Old .xls files are not supported; save as .xlsx or .csv');
  const rows = ext === '.xlsx' ? await readXlsxRows(data, name) : parseCsv(data.toString('utf8'));
  return rulebookFromRows(rows);
}

export async function loadRulebook(file: string): Promise<Rulebook> {
  return parseRulebook(file, readFileSync(file));
}

/**
 * Adds a user-type column that expects access to every page.
 * Used for Site Admin when the rulebook has no column for it: in AMP a Site Admin with MFA
 * has access to every module (Module.HasAccess).
 */
export function withAllowAllColumn(rb: Rulebook, userType: string): Rulebook {
  if (rb.userTypes.includes(userType)) return rb;
  return {
    userTypes: [userType, ...rb.userTypes],
    rules: rb.rules.map((r) => ({ ...r, expected: { [userType]: 'Yes' as Expected, ...r.expected } })),
  };
}

/** Counts useful for showing the tester what was loaded. */
export function rulebookSummary(rb: Rulebook) {
  const missing: Record<string, number> = {};
  for (const ut of rb.userTypes) missing[ut] = rb.rules.filter((r) => r.expected[ut] === null).length;
  return { userTypes: rb.userTypes, pages: rb.rules.length, missingExpectations: missing };
}
