import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { Expected, Rule, Rulebook, RulebookColumn, RuleType } from '../types';
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

const YES = ['yes', 'y', 'true', '1'];
const NO = ['no', 'n', 'false', '0'];
function yesNo(raw: string): Expected | undefined {
  const v = raw.trim().toLowerCase();
  if (v === '') return null;
  if (YES.includes(v)) return 'Yes';
  if (NO.includes(v)) return 'No';
  return undefined;
}

/** How many header rows to search for the real header (title rows above it are skipped). */
const HEADER_SEARCH_ROWS = 10;
/** A column is a user type when at least this share of its filled cells are Yes/No. */
const USER_TYPE_MIN_YES_NO = 0.8;

/**
 * Reads a rulebook sheet.
 *
 * 1. Header row: the first of the top rows that has a page column (page / url / route …).
 *    Title rows above it (e.g. "Internal User Personas") are skipped.
 * 2. Columns: the page column; an optional name column; known info columns (notes, icon …);
 *    every other column is judged by its VALUES: it is a user type when its filled cells are Yes/No
 *    (at least one filled). Empty columns and columns with other text are treated as info.
 *    A user-type column with a few odd values (typos) is an error pointing at the cell.
 * 3. Rows without a page (menu headings) and rows typed "external"/"group" are skipped.
 */
export function rulebookFromRows(rows: string[][]): Rulebook {
  if (rows.length === 0) throw new Error('Rulebook is empty');
  const headerIdx = rows.slice(0, HEADER_SEARCH_ROWS).findIndex((r) => r.some((c) => ROUTE_HEADERS.includes(headerKey(c))));
  if (headerIdx < 0) {
    throw new Error(`Rulebook needs a column for the page, named one of: ${ROUTE_HEADERS.join(', ')}. First row found: ${(rows[0] ?? []).filter(Boolean).join(', ')}`);
  }
  const header = rows[headerIdx]!;
  const body = rows.slice(headerIdx + 1);
  const firstLine = headerIdx + 2;
  const keys = header.map(headerKey);

  const routeIdx = keys.findIndex((k) => ROUTE_HEADERS.includes(k));
  const labelIdx = keys.findIndex((k) => LABEL_HEADERS.includes(k));
  const typeIdx = keys.indexOf('type');
  const parentIdx = keys.indexOf('parent');
  const notesIdx = keys.findIndex((k) => ['notes', 'note', 'comments', 'comment'].includes(k));
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');

  // Rows that are real pages.
  const pageRows = body
    .map((r, i) => ({ r, line: firstLine + i }))
    .filter(({ r }) => {
      const type = cell(r, typeIdx).toLowerCase();
      const route = normalizeRoute(cell(r, routeIdx));
      return type !== 'external' && type !== 'group' && !!route && !/^(mailto:|javascript:|https?:)/.test(route);
    });

  // Classify every column.
  const columns: RulebookColumn[] = [];
  const userCols: { k: string; i: number }[] = [];
  header.forEach((h, i) => {
    const k = keys[i]!;
    const label = h.trim();
    if (!k) return;
    if (i === routeIdx) return void columns.push({ key: k, label, role: 'page' });
    if (i === labelIdx) return void columns.push({ key: k, label, role: 'name' });
    if (ROUTE_HEADERS.includes(k) || LABEL_HEADERS.includes(k) || IGNORED_HEADERS.includes(k)) {
      return void columns.push({ key: k, label, role: 'info', reason: 'descriptive column' });
    }
    const filled = pageRows.map(({ r }) => cell(r, i)).filter((v) => v !== '');
    if (filled.length === 0) return void columns.push({ key: k, label, role: 'info', reason: 'empty column' });
    const yn = filled.filter((v) => yesNo(v) !== undefined).length;
    if (yn / filled.length < USER_TYPE_MIN_YES_NO) {
      const sample = filled.find((v) => yesNo(v) === undefined)!;
      return void columns.push({ key: k, label, role: 'info', reason: `not Yes/No values (e.g. "${sample.slice(0, 30)}")` });
    }
    columns.push({ key: k, label, role: 'user' });
    userCols.push({ k, i });
  });

  if (userCols.length === 0) {
    const info = columns.filter((c) => c.role === 'info').map((c) => `${c.label} (${c.reason})`);
    throw new Error(`No user-type columns found: a user-type column needs Yes/No values (e.g. Site Admin, Channel Manager).${info.length ? ` Other columns: ${info.join('; ')}` : ''}`);
  }
  const dupes = userCols.map((c) => c.k).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupes.length) throw new Error(`Duplicate user-type columns: ${[...new Set(dupes)].join(', ')}`);

  const seenRoutes = new Set<string>();
  const seenIds = new Set<string>();
  const rules: Rule[] = [];
  for (const { r, line } of pageRows) {
    const route = normalizeRoute(cell(r, routeIdx));
    if (seenRoutes.has(route)) continue;
    seenRoutes.add(route);
    const label = cell(r, labelIdx) || route;
    const expected: Record<string, Expected> = {};
    for (const { k, i } of userCols) {
      const v = yesNo(cell(r, i));
      if (v === undefined) throw new Error(`Row ${line} (${label}), column "${header[i]!.trim()}": expected Yes/No/empty, got "${cell(r, i)}"`);
      expected[k] = v;
    }
    let id = slug(route);
    while (seenIds.has(id)) id += '-x';
    seenIds.add(id);
    rules.push({ id, type: 'page' as RuleType, parent: cell(r, parentIdx), label, route, expected, notes: cell(r, notesIdx) });
  }

  if (rules.length === 0) throw new Error('Rulebook has no pages to test');
  const userTypeLabels: Record<string, string> = {};
  for (const { k, i } of userCols) userTypeLabels[k] = header[i]!.trim() || k;
  return { userTypes: userCols.map((c) => c.k), userTypeLabels, rules, columns, headerRow: headerIdx + 1 };
}

/** Keeps only the chosen user types (the tester can untick detected columns). */
export function selectUserTypes(rb: Rulebook, keys: string[] | undefined): Rulebook {
  if (!keys) return rb;
  const keep = rb.userTypes.filter((k) => keys.includes(k));
  if (keep.length === 0) throw new Error('Choose at least one user type');
  return { ...rb, userTypes: keep };
}

async function readXlsxRows(data: Buffer, name: string): Promise<string[][]> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw new Error(`${name} is not a valid Excel (.xlsx) file. Open it in Excel and save it again as .xlsx, or save as .csv.`);
  }
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

/** What the tester sees after loading: the user types exactly as named in the sheet, and counts. */
export function rulebookSummary(rb: Rulebook) {
  const missing: Record<string, number> = {};
  for (const ut of rb.userTypes) missing[ut] = rb.rules.filter((r) => r.expected[ut] === null).length;
  return {
    userTypes: rb.userTypes,
    userTypeLabels: rb.userTypeLabels,
    pages: rb.rules.length,
    missingExpectations: missing,
    columns: rb.columns ?? [],
    headerRow: rb.headerRow ?? 1,
  };
}
