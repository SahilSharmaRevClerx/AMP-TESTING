/**
 * MCP Connector Health (P08, Phase 0): workflow-graph node extraction.
 * Port of the working script's walk(): finds every MCP activity, its server
 * id and tool name(s). Never throws on odd shapes; numeric, text ("asana")
 * and absent ids are all returned, never guessed.
 *
 * Server id / tool live at inputs.mcpServerId.expression.value and
 * inputs.toolName.expression.value. Graphs saved by older AMP builds carry
 * the same fields directly on the activity (mcpServerId.expression.value);
 * both shapes are read. Expression types other than Literal are flagged
 * (nonLiteral) so the classifier reports NOT_CHECKED instead of guessing.
 * Fixed ArgumentsJson contributes only its top-level KEY names (argKeys):
 * values can hold customer data and are never kept.
 *
 * WebRequest nodes are NOT MCP nodes (plan section 8): they are counted and
 * reported as "not covered by this module", never probed.
 */

export interface McpNode {
  workflow: string;
  /** The definition id the graph was read for (internal: used to label the workflow kind, never shown). */
  definitionId?: string;
  /** Numeric id, text ("asana"), or undefined when absent/non-numeric. */
  serverId: number | string | undefined;
  serverName?: string;
  tool?: string;
  toolNames?: string[];
  /**
   * Top-level KEY names of the step's fixed ArgumentsJson (names only, NEVER
   * values: values can hold customer data). Absent when the arguments are not
   * a fixed JSON object (AI-agent steps, non-Literal expressions, empty or
   * unparseable text): those steps are not argument-checked.
   */
  argKeys?: string[];
  /** Expression container was present but its type was not Literal. */
  nonLiteral?: boolean;
}

export interface Extracted {
  nodes: McpNode[];
  /** Generic HTTP-call nodes: counted, not extracted, never probed. */
  webRequestNodes: number;
}

function readInput(activity: Record<string, unknown>, key: string): { value: unknown; exprType?: string; found: boolean } {
  const fromInputs = (activity.inputs as Record<string, unknown> | undefined)?.[key];
  const direct = (activity as Record<string, unknown>)[key];
  const holder = fromInputs !== undefined ? fromInputs : direct;
  if (holder === undefined) return { value: undefined, found: false };
  if (holder && typeof holder === 'object' && 'expression' in (holder as Record<string, unknown>)) {
    const expr = (holder as { expression?: unknown }).expression;
    if (expr && typeof expr === 'object') {
      const e = expr as Record<string, unknown>;
      return { value: e.value, exprType: typeof e.type === 'string' ? e.type : undefined, found: true };
    }
    return { value: undefined, exprType: undefined, found: true };
  }
  return { value: holder, exprType: undefined, found: true };
}

function toServerId(value: unknown): number | string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return undefined;
    const n = Number(t);
    return t !== '' && Number.isFinite(n) ? n : t;
  }
  return undefined;
}

function strList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  const out = arr.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return out;
}

function oneStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Cap on kept argument key names, so a giant arguments object cannot bloat snapshots. */
const MAX_ARG_KEYS = 50;

/**
 * Top-level key names of a fixed ArgumentsJson value (never the values).
 * Accepts a JSON-object string or an already-parsed object; arrays, empty or
 * unparseable text yield undefined (not checked, never guessed).
 */
function argKeysOf(value: unknown): string[] | undefined {
  let obj: unknown = value;
  if (typeof obj === 'string') {
    if (!obj.trim()) return undefined;
    try {
      obj = JSON.parse(obj);
    } catch {
      return undefined;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const keys = Object.keys(obj as Record<string, unknown>).filter((k) => k.length > 0);
  if (!keys.length) return undefined;
  return keys.slice(0, MAX_ARG_KEYS).map((k) => k.slice(0, 80));
}

/**
 * Extracts MCP nodes from one parsed workflow-definition graph.
 * @param graph parsed JSON of GET /api/elsa-agents/workflow-definitions/:id
 * @param workflow display name of the workflow (for node rows)
 */
export function extractMcpNodes(graph: unknown, workflow = ''): Extracted {
  const nodes: McpNode[] = [];
  let webRequestNodes = 0;
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      for (const x of o) walk(x);
      return;
    }
    if (!o || typeof o !== 'object') return;
    const rec = o as Record<string, unknown>;
    if (typeof rec.type === 'string') {
      if (/webrequest/i.test(rec.type)) webRequestNodes += 1;
      if (/mcp/i.test(rec.type)) {
        const sid = readInput(rec, 'mcpServerId');
        const sname = readInput(rec, 'mcpServerName');
        const tool = readInput(rec, 'toolName');
        const tools = readInput(rec, 'toolNames');
        const nonLiteral = [sid, tool, tools].some((r) => r.found && r.exprType !== undefined && r.exprType !== 'Literal');
        // Fixed arguments (both casings, both graph shapes). Only a Literal
        // expression — or a bare value with no expression wrapper — counts as
        // fixed; anything computed at run time leaves argKeys absent.
        const lowerArgs = readInput(rec, 'argumentsJson');
        const args = lowerArgs.found ? lowerArgs : readInput(rec, 'ArgumentsJson');
        const argsFixed = args.found && (args.exprType === undefined || args.exprType === 'Literal');
        const argKeys = argsFixed ? argKeysOf(args.value) : undefined;
        nodes.push({
          workflow,
          serverId: toServerId(sid.value),
          serverName: oneStr(sname.value),
          tool: oneStr(tool.value),
          toolNames: strList(tools.value),
          ...(nonLiteral ? { nonLiteral: true } : {}),
          ...(argKeys ? { argKeys } : {}),
        });
      }
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(graph);
  return { nodes, webRequestNodes };
}
