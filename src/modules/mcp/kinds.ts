/**
 * MCP Connector Health (P14): workflow-kind labels.
 * Tells live workflows apart from drafts and shared templates using AMP's own
 * workflow lists (POST /api/GetAIAutomationWorkflows, read-only). Every step
 * is labelled per account: Template, Live, Draft only, Not in AMP's lists, or
 * Unknown when the lists cannot be read. No tool calls, nothing is run.
 */
import type { McpWorkflowKind } from './types';

export type { McpWorkflowKind };

/** Most informative first: the order the Combined view shows when accounts disagree. */
export const KIND_PRECEDENCE: McpWorkflowKind[] = ['live', 'template', 'draft', 'unlisted', 'unknown'];

/** The 8 folder reads that cover every tab of AMP's workflow grid (T1 verdict). */
export interface KindListFlags {
  isPublished: boolean;
  isPublic: boolean;
  hasCategory: boolean;
  isAgentic: boolean;
}

interface KindListRequest {
  /** Short name for logs (never shown on screen). */
  key: string;
  flags: KindListFlags;
}

export const KIND_LIST_REQUESTS: KindListRequest[] = [
  { key: 'published-automation', flags: { isPublished: true, isPublic: false, hasCategory: false, isAgentic: false } },
  { key: 'published-business', flags: { isPublished: true, isPublic: false, hasCategory: true, isAgentic: false } },
  { key: 'published-agentic', flags: { isPublished: true, isPublic: false, hasCategory: false, isAgentic: true } },
  { key: 'draft-automation', flags: { isPublished: false, isPublic: false, hasCategory: false, isAgentic: false } },
  { key: 'draft-business', flags: { isPublished: false, isPublic: false, hasCategory: true, isAgentic: false } },
  { key: 'draft-agentic', flags: { isPublished: false, isPublic: false, hasCategory: false, isAgentic: true } },
  { key: 'public-automation', flags: { isPublished: false, isPublic: true, hasCategory: false, isAgentic: false } },
  { key: 'public-business', flags: { isPublished: false, isPublic: true, hasCategory: true, isAgentic: false } },
];

/** Page size for the list reads: every sandbox tab fits one page; loop on row_count regardless. */
export const KIND_LIST_PAGE_SIZE = 1000;
/** Hard stop on paging one folder, so a pathological install cannot page forever. */
const KIND_LIST_MAX_PAGES = 10;

/**
 * The exact pinned body for one folder read. type is always "definitions"
 * (the "instances" listing is the run log, not workflows); every flag is sent
 * explicitly because the server reads an omitted flag as false. Passes
 * checkWorkflowListBody in src/core/safety/gate.ts.
 */
export function workflowListBody(flags: KindListFlags, page: number): Record<string, unknown> {
  return {
    type: 'definitions',
    isPublished: flags.isPublished,
    isPublic: flags.isPublic,
    hasCategory: flags.hasCategory,
    isAgentic: flags.isAgentic,
    page,
    pageSize: KIND_LIST_PAGE_SIZE,
    Page: page,
    PageSize: KIND_LIST_PAGE_SIZE,
    sort: 'updatedon',
    ascending: false,
    search: '',
    filters: [],
    condition: false,
    format: 4,
  };
}

export interface WorkflowListSets {
  /** Definition ids in any Published folder (Automation, Business, Agentic). */
  published: Set<string>;
  /** Definition ids in any Draft folder. */
  draft: Set<string>;
  /** Definition ids in any Public Templates folder (read at Latest, so drafts included). */
  public: Set<string>;
  /** False when any folder read failed: every step must then read Unknown. */
  ok: boolean;
  /** How many folder reads were sent (for the stage list and log). */
  reads: number;
}

export interface KindListTransport {
  postWorkflowList(body: unknown): Promise<{ status: number; json: unknown }>;
}

function idsOf(item: unknown): string[] {
  const out: string[] = [];
  const list = Array.isArray(item) ? item : [];
  for (const row of list) {
    if (row && typeof row === 'object' && typeof (row as { definitionId?: unknown }).definitionId === 'string') {
      out.push((row as { definitionId: string }).definitionId);
    }
  }
  return out;
}

/** Unwraps the legacy {status, result} envelope around the {item, row_count} grid answer. */
function gridOf(json: unknown): { item: unknown; rowCount: number } | null {
  const u = ((): unknown => {
    if (json && !Array.isArray(json) && typeof json === 'object' && !('item' in (json as Record<string, unknown>))) {
      const o = json as Record<string, unknown>;
      return o.data ?? o.result ?? o.d ?? json;
    }
    return json;
  })();
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  const inner = o.result && typeof o.result === 'object' ? (o.result as Record<string, unknown>) : o;
  if (!Array.isArray(inner.item)) return null;
  return { item: inner.item, rowCount: typeof inner.row_count === 'number' ? inner.row_count : inner.item.length };
}

/**
 * Reads the 8 folder lists once (paged on row_count). All-or-nothing: if any
 * folder fails, ok is false and the caller labels every step Unknown rather
 * than mislabelling templates as live. Never throws.
 */
export async function readWorkflowLists(t: KindListTransport): Promise<WorkflowListSets> {
  const sets: WorkflowListSets = { published: new Set(), draft: new Set(), public: new Set(), ok: true, reads: 0 };
  for (const req of KIND_LIST_REQUESTS) {
    const ids = new Set<string>();
    try {
      for (let page = 0; page < KIND_LIST_MAX_PAGES; page++) {
        const r = await t.postWorkflowList(workflowListBody(req.flags, page));
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const g = gridOf(r.json);
        if (!g) throw new Error('unreadable list answer');
        sets.reads += 1;
        for (const id of idsOf(g.item)) ids.add(id);
        const got = (g.item as unknown[]).length;
        if (got < KIND_LIST_PAGE_SIZE || ids.size >= g.rowCount) break;
      }
    } catch {
      return { published: new Set(), draft: new Set(), public: new Set(), ok: false, reads: sets.reads };
    }
    if (req.key.startsWith('published-')) for (const id of ids) sets.published.add(id);
    else if (req.key.startsWith('draft-')) for (const id of ids) sets.draft.add(id);
    else for (const id of ids) sets.public.add(id);
  }
  return sets;
}

/**
 * The 5-way rule (T1 verdict): Template wins over Live, Live over Draft only,
 * then Not in AMP's lists for workflows our endpoint lists but no UI list has,
 * else Unknown. listsOk false forces Unknown for every step.
 */
export function kindOfWorkflow(
  definitionId: string,
  sets: Pick<WorkflowListSets, 'published' | 'draft' | 'public' | 'ok'>,
  inOurList: boolean,
): McpWorkflowKind {
  if (!sets.ok) return 'unknown';
  if (sets.public.has(definitionId)) return 'template';
  if (sets.published.has(definitionId)) return 'live';
  if (sets.draft.has(definitionId)) return 'draft';
  return inOurList ? 'unlisted' : 'unknown';
}

/** Combined-view precedence: the most informative kind seen for the step wins. */
export function betterKind(a: McpWorkflowKind, b: McpWorkflowKind): McpWorkflowKind {
  return KIND_PRECEDENCE.indexOf(a) <= KIND_PRECEDENCE.indexOf(b) ? a : b;
}
