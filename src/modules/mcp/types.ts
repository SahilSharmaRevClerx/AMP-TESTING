/**
 * MCP Connector Health (P08, Phase 0, read-only): shared row shapes.
 * Internal enums (states/buckets) stay in code and JSON only; tester-facing
 * plain wording lives in the page (src/modules/mcp/mcp.html, plan 5c).
 */

export type McpBucket = 'BROKEN' | 'MAYBE' | 'NEEDS_YOU' | 'HEALTHY';

export type McpCertainty = 'high' | 'medium' | 'low';

export type McpServerState =
  | 'OK'
  | 'NOT_CONNECTED'
  | 'NOT_VISIBLE'
  | 'KEY_REJECTED'
  | 'OAUTH_EXPIRED'
  | 'FORBIDDEN'
  | 'URL_404'
  | 'DEAD_HOST'
  | 'REDIRECT'
  | 'HTML_NOT_MCP'
  | 'UNREACHABLE'
  | 'UNKNOWN_ERROR'
  | 'MISCONFIGURED'
  | 'SERVICE_ACCOUNT_REFUSED'
  | 'RATE_LIMITED'
  | 'NO_TOOLS'
  | 'API_ERROR';

/** One connector row: same fields as the working script's JSON. */
export interface McpServerRow {
  id: number;
  name: string;
  state: McpServerState;
  bucket: McpBucket;
  /** How many tools came back. */
  tools: number;
  toolNames: string[];
  /** Scrubbed one-line error text (values the tester may read; never a token). */
  detail: string;
  /** One-line fix hint; empty for healthy servers. */
  hint: string;
  /** How sure the rule that chose `state` is: high = structured flag or AMP's exact phrase, medium = status code or keyword, low = guess. Absent on older runs. */
  certainty?: McpCertainty;
  /** HTTP status of the live tools call (for triage; additive, ignored by older readers). */
  httpStatus?: number;
  /** Tool names with AMP's own one-line description (trimmed). Shown to the tester only; never sent to the AI. Absent on older runs. */
  toolInfo?: { name: string; description?: string }[];
  /** Tool input-schema field names/types/required only — never values (for triage and the argument check). */
  toolSchemas?: { name: string; fields: { name: string; type: string }[]; required: string[] }[];
  /** AI triage note (P11). Absent when triage did not run or judged nothing. */
  ai?: { diagnosis: string; nextStep: string; confidence: 'high' | 'medium' | 'low' };
  /** Relative URL of the saved raw-answer file, when one exists. */
  rawUrl?: string;
}

/** What kind of workflow a step belongs to (P14): the UI lists decide per account. Absent on older runs. */
export type McpWorkflowKind = 'live' | 'draft' | 'template' | 'unlisted' | 'unknown';

/** One workflow-node row. state is OK | TOOL_MISSING[: tools] | NOT_CHECKED | SERVER_<state>. */
export interface McpNodeRow {
  workflow: string;
  tool: string;
  server: number | string;
  state: string;
  bucket: McpBucket;
  hint: string;
  /** Which list the workflow came from (additive, optional so older snapshots still read). */
  workflowKind?: McpWorkflowKind;
  /**
   * Fixed-arguments check against the tool's input schema (additive, optional).
   * A separate note only: never changes the health bucket. Absent on older runs
   * and on steps whose arguments are not a fixed JSON object.
   */
  argCheck?: { state: 'ok' | 'missing' | 'extra' | 'not_checked'; missing?: string[]; extra?: string[] };
  /** AI triage note (P11). Absent when triage did not run or judged nothing. */
  ai?: { diagnosis: string; nextStep: string; confidence: 'high' | 'medium' | 'low' };
}

export interface McpToolChange {
  id: number;
  name: string;
  added: string[];
  removed: string[];
}

export interface McpStateChange {
  what: 'server';
  id: number;
  name: string;
  from: string;
  to: string;
  added: string[];
  removed: string[];
}

/** Per-account result: the P09 API contract's Result.accounts[key]. */
export interface McpAccountResult {
  title: string;
  sub: string;
  servers: McpServerRow[];
  nodes: McpNodeRow[];
  limitedNote?: string;
}

/** The P09 API contract's Result. */
export interface McpResult {
  host: string;
  when: string;
  order: string[];
  accounts: Record<string, McpAccountResult>;
  changes: Record<string, McpStateChange[]>;
  firstRun: Record<string, boolean>;
  /** Per account: set when the previous run used different classification rules, so state flips were not compared. */
  rulesChanged?: Record<string, { from: string; to: string }>;
  rulesVersion?: string;
  /** False when the run was connector-only: no workflows were read, so nodes are empty. */
  workflowsChecked?: boolean;
  /** How many problems got an AI note (absent when AI review was off or the run predates it). */
  aiCoverage?: { noted: number; eligible: number; cap: number };
  notCovered: { webRequestNodes: number };
}
