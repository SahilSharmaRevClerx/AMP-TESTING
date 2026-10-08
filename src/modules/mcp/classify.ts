/**
 * MCP Connector Health (P08, Phase 0): classification of live server answers.
 * Port of the working script's classify() (temp-notes/mcp-health-check.mjs):
 * same states, same buckets, same order, same hints.
 *
 * KNOWN BLIND SPOT (same as the script, not a bug): NOT_CONNECTED is checked
 * before the host/key patterns, so an OAuth server that is both unconnected
 * for this user AND pointed at a dead host still reports NOT_CONNECTED
 * ("Connect it as this user, then rerun") instead of DEAD_HOST. Reconnecting
 * and rerunning resolves the ambiguity: a real host problem then shows up.
 */
import type { McpBucket, McpNodeRow, McpServerRow, McpServerState, McpCertainty } from './types';

export type { McpBucket, McpServerState };

interface Verdict {
  state: McpServerState;
  bucket: McpBucket;
  hint: string;
  /** high = structured flag or AMP's exact phrase; medium = status code or keyword; low = guess. */
  certainty: McpCertainty;
}

/** Bump on EVERY change to the rules below, so a rule change is never shown as a connector change (see diffSnapshots). */
export const RULES_VERSION = '2026-10-07.1';

const S = (state: McpServerState, bucket: McpBucket, hint: string, certainty: McpCertainty): Verdict => ({ state, bucket, hint, certainty });

const H = {
  NOT_VISIBLE: 'This user cannot see the server. Rerun as a user/admin who can, then judge it.',
  API_ERROR: 'AMP API call failed. Check the jwt/CSRF and rerun.',
  NOT_CONNECTED: 'Connect it as this user (profile settings), then rerun.',
  KEY_REJECTED: 'API key in the connector headers is rejected. Update the key or URL.',
  OAUTH_EXPIRED: 'Reconnect this server as this user and rerun. If it still fails, raise a ticket.',
  FORBIDDEN: 'The server refused this account or key (403): it lacks permission. Ask the connector owner to grant access, then rerun.',
  URL_404: 'Server URL returns 404. Edit the connector URL.',
  RATE_LIMITED: 'Rate limited. Wait and rerun.',
  DEAD_HOST: 'Host no longer resolves (often an expired tunnel). Remove or re-point the connector.',
  REDIRECT: 'URL redirects instead of serving MCP. Point the connector at its final URL.',
  HTML_NOT_MCP: 'URL returns a web page, not MCP. Wrong URL or not an MCP endpoint.',
  UNREACHABLE: 'Server unavailable (5xx/timeout). Retry later; if persistent, raise a ticket.',
  UNKNOWN_ERROR: "AMP returned an error this tool does not recognise yet. Read AMP's answer; if it is a new kind of error, ask for a rule to be added.",
  MISCONFIGURED: 'An admin needs to fix the connector setup (missing URL or endpoint).',
  NO_TOOLS: 'Reachable but exposes zero tools. Check the server setup.',
} as const;

const STATUS_NAMES = 'Not Found|Unauthorized|Forbidden|Too Many Requests|Service Unavailable|Bad Gateway|Gateway Timeout|Internal Server Error';
const QUOTED_STATUS = new RegExp(
  `\\((\\d{3})\\)|\\bHTTP(?:/[\\d.]+)?\\s+(\\d{3})\\b|\\bstatus(?:\\s*code)?\\s*[:=]?\\s*(\\d{3})\\b|\\b(\\d{3})\\s+(?:${STATUS_NAMES})\\b`,
  'i',
);

/**
 * An HTTP status AMP quotes in its error text, read only from fixed shapes: "(404)", "HTTP 404",
 * "status code 404", "status: 404" or "404 Not Found". A number anywhere else (a port, an id, a URL) is ignored.
 */
export function quotedStatus(err: string): number | null {
  const m = QUOTED_STATUS.exec(err);
  const v = m ? Number(m[1] ?? m[2] ?? m[3] ?? m[4]) : NaN;
  return v >= 100 && v <= 599 ? v : null;
}

/** State for an HTTP status, or null for codes that say nothing about the connector. */
function byStatus(code: number, certainty: McpCertainty): Verdict | null {
  if (code === 401) return S('OAUTH_EXPIRED', 'MAYBE', H.OAUTH_EXPIRED, certainty);
  if (code === 403) return S('FORBIDDEN', 'BROKEN', H.FORBIDDEN, certainty);
  if (code === 404) return S('URL_404', 'BROKEN', H.URL_404, certainty);
  if (code === 429) return S('RATE_LIMITED', 'MAYBE', H.RATE_LIMITED, certainty);
  if (code >= 500) return S('UNREACHABLE', 'BROKEN', H.UNREACHABLE, certainty);
  return null;
}

/** Unwraps AMP's envelope shapes ({data|result|d|items}) like the script does. */
export function unwrapResponse(j: unknown): unknown {
  if (j && !Array.isArray(j) && typeof j === 'object' && !('tools' in j) && !('error' in j)) {
    const o = j as Record<string, unknown>;
    return o.data ?? o.result ?? o.d ?? o.items ?? j;
  }
  return j;
}

/**
 * Classifies one GetMCPServerTools answer. Checks run from most to least specific:
 * structured signals (visibility, our own HTTP status, the authRequired flag) and AMP's exact
 * phrases, then a status code quoted in a fixed shape, then looser keywords, then weak hints.
 * Anything left is UNKNOWN_ERROR (low certainty) instead of a guessed cause.
 * @param status HTTP status of the AMP call
 * @param body parsed JSON body (null when the body was not JSON)
 * @param visible whether this server id was in the user's visible list
 */
export function classifyServerResponse(status: number, body: unknown, visible: boolean): Verdict & { toolNames: string[]; detail: string } {
  if (!visible) return { ...S('NOT_VISIBLE', 'NEEDS_YOU', H.NOT_VISIBLE, 'high'), toolNames: [], detail: '' };
  if (status !== 200 || body === null || body === undefined) {
    return { ...S('API_ERROR', 'MAYBE', H.API_ERROR, 'high'), toolNames: [], detail: `HTTP ${status}` };
  }
  const j = unwrapResponse(body);
  const err = (j as { error?: unknown })?.error ? String((j as { error?: unknown }).error) : '';
  const rawTools = Array.isArray((j as { tools?: unknown }).tools) ? ((j as { tools: unknown[] }).tools) : [];
  const toolNames = rawTools.map((t) => (t as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string');
  const done = (v: Verdict): Verdict & { toolNames: string[]; detail: string } => ({ ...v, toolNames, detail: err });

  // AMP's own sentence ends where a vendor quote begins: only text shaped by
  // AMP ("returned NNN: <detail>" -> " Server said: <detail>", MCPPromptRunner.cs:1089-1093)
  // is quoted. Vendor patterns below must never outrank these rules.
  const cut = err.indexOf('Server said:');
  const amp = cut < 0 ? err : err.slice(0, cut);

  // 1. AMP's exact sentences and the structured flag (high). NOT_CONNECTED first:
  // KNOWN BLIND SPOT, it hides host problems of OAuth servers (the no-token resolve in
  // MCPPromptRunner.cs:1193-1198 runs before any network, so no host fact can exist yet).
  if (/not connected to your account/i.test(amp)) return done(S('NOT_CONNECTED', 'NEEDS_YOU', H.NOT_CONNECTED, 'high')); // MCPPromptRunner.cs:1195
  if ((j as { authRequired?: unknown })?.authRequired) return done(S('OAUTH_EXPIRED', 'MAYBE', H.OAUTH_EXPIRED, 'high')); // GetMCPServerTools.cs:58
  // AMP's own sentence for a rejected API key (a 401 caused by the key in the connector's headers). Seen in the DEPLOYED AMP
  // (28+ real answers on ai.sb.amp.vg) but not found in D:\git branch temp-ontology-wiring-test: the sandbox runs newer wording
  // than that source. It must outrank the generic "(401)" status rule below: a rejected key is fixed by the connector owner
  // (Fix needed), not by the user reconnecting.
  if (/rejected the key in this connector'?s Headers/i.test(amp)) return done(S('KEY_REJECTED', 'BROKEN', H.KEY_REJECTED, 'high'));
  if (/authentication failed \(401\)/i.test(amp)) return done(S('OAUTH_EXPIRED', 'MAYBE', H.OAUTH_EXPIRED, 'high')); // MCPPromptRunner.cs:1066
  if (/access denied \(403\)/i.test(amp)) return done(S('FORBIDDEN', 'BROKEN', H.FORBIDDEN, 'high')); // MCPPromptRunner.cs:1068
  if (/endpoint not found \(404\)/i.test(amp)) return done(S('URL_404', 'BROKEN', H.URL_404, 'high')); // MCPPromptRunner.cs:1070
  if (/rate limit exceeded \(429\)/i.test(amp)) return done(S('RATE_LIMITED', 'MAYBE', H.RATE_LIMITED, 'high')); // MCPPromptRunner.cs:1072
  if (/currently unavailable \(\d{3}\)/i.test(amp)) return done(S('UNREACHABLE', 'BROKEN', H.UNREACHABLE, 'high')); // MCPPromptRunner.cs:1073-1074
  if (/is misconfigured \(missing endpoint URL\)/i.test(amp)) return done(S('MISCONFIGURED', 'BROKEN', H.MISCONFIGURED, 'high')); // MCPPromptRunner.cs:1200
  if (/has no configuration/i.test(amp)) return done(S('MISCONFIGURED', 'BROKEN', H.MISCONFIGURED, 'high')); // MCPPromptRunner.cs:1263
  if (/your session has expired/i.test(amp)) return done(S('OAUTH_EXPIRED', 'MAYBE', H.OAUTH_EXPIRED, 'high')); // MCPPromptRunner.cs:1187,1238
  if (/was not found\. It may have been deleted/i.test(amp)) return done(S('URL_404', 'BROKEN', H.URL_404, 'high')); // MCPPromptRunner.cs:1245
  if (/returned non-JSON response/i.test(amp)) return done(S('HTML_NOT_MCP', 'BROKEN', H.HTML_NOT_MCP, 'high')); // MCPClientService.cs:325-326
  if (/returned a \d{3} redirect to/i.test(amp)) return done(S('REDIRECT', 'BROKEN', H.REDIRECT, 'high')); // MCPClientService.cs:305-306
  // 2. A status code quoted in a fixed shape in AMP's part (medium): it beats loose words such as "expired" on a 404 page.
  const quoted = quotedStatus(amp);
  const fromCode = quoted === null ? null : byStatus(quoted, 'medium');
  if (fromCode) return done(fromCode);
  // 3. Looser AMP-side keywords (medium).
  if (/no such host|\bDNS\b|name or service not known|could not resolve host/i.test(amp)) return done(S('DEAD_HOST', 'BROKEN', H.DEAD_HOST, 'medium'));
  if (/authentication failed|token (?:has )?expired|please reconnect|reconnect (?:this|the) server/i.test(amp)) {
    return done(S('OAUTH_EXPIRED', 'MAYBE', H.OAUTH_EXPIRED, 'medium'));
  }
  if (/access denied/i.test(amp)) return done(S('FORBIDDEN', 'BROKEN', H.FORBIDDEN, 'medium'));
  if (/\bnot found\b|no configuration/i.test(amp)) return done(S('URL_404', 'BROKEN', H.URL_404, 'medium'));
  if (/\bredirect/i.test(amp)) return done(S('REDIRECT', 'BROKEN', H.REDIRECT, 'medium'));
  if (/non-JSON/i.test(amp)) return done(S('HTML_NOT_MCP', 'BROKEN', H.HTML_NOT_MCP, 'medium')); // truncated MCPClientService.cs:326
  if (/timed? ?out|service unavailable|bad gateway/i.test(amp)) return done(S('UNREACHABLE', 'BROKEN', H.UNREACHABLE, 'medium'));
  // 4. Vendor/BCL wording (medium): absent from AMP's source (searched bridgeai handlers,
  // orchestrator Dispatch and the MCP client), so it only ever arrives via "Server said:"
  // quotes or the unquoted default branch (MCPPromptRunner.cs:1076). Matched on the whole
  // text so unquoted passthrough still classifies, but only after every AMP-side rule above.
  if (/rejected the key/i.test(err)) return done(S('KEY_REJECTED', 'BROKEN', H.KEY_REJECTED, 'medium'));
  if (/No such host/i.test(err)) return done(S('DEAD_HOST', 'BROKEN', H.DEAD_HOST, 'medium'));
  // 5. Weak hints (low): a bare known code anywhere, or a word that only suggests a cause.
  const bare = /\b(401|403|404|429|5\d\d)\b/.exec(err);
  const fromBare = bare ? byStatus(Number(bare[1]), 'low') : null;
  if (fromBare) return done(fromBare);
  if (/\bHeaders\b/.test(err)) return done(S('KEY_REJECTED', 'BROKEN', H.KEY_REJECTED, 'low'));
  if (/incorrect/i.test(err)) return done(S('URL_404', 'BROKEN', H.URL_404, 'low'));
  if (/expired|reconnect/i.test(err)) return done(S('OAUTH_EXPIRED', 'MAYBE', H.OAUTH_EXPIRED, 'low'));
  // 6. Nothing matched: say so instead of guessing a cause.
  if (err) return done(S('UNKNOWN_ERROR', 'BROKEN', H.UNKNOWN_ERROR, 'low'));
  if (toolNames.length) return { ...S('OK', 'HEALTHY', '', 'high'), toolNames, detail: '' };
  return { ...S('NO_TOOLS', 'BROKEN', H.NO_TOOLS, 'high'), toolNames, detail: '' };
}

export interface ClassifiedNode {
  serverId: number | string | undefined;
  wantedTools: string[];
}

/**
 * Node verdict for one workflow node against its server's classification.
 * serverRow is undefined when the node points at a server nobody classified
 * (e.g. an id the live loop never queried): treated like a server the user
 * cannot judge (SERVER_NOT_VISIBLE is never "broken").
 */
export function classifyNode(
  node: { workflow: string; tool?: string; toolNames?: string[]; serverId: number | string | undefined; nonLiteral?: boolean },
  serverRow: Pick<McpServerRow, 'state' | 'bucket' | 'hint' | 'toolNames'> | undefined,
): McpNodeRow {
  const base = { workflow: node.workflow, tool: node.tool ?? '' };
  if (node.nonLiteral || node.serverId === undefined || (typeof node.serverId === 'number' && !Number.isFinite(node.serverId))) {
    return {
      ...base,
      server: typeof node.serverId === 'string' && node.serverId ? node.serverId : '(none)',
      state: 'NOT_CHECKED',
      bucket: 'NEEDS_YOU',
      hint: 'Node has no numeric server id (resolved by name/provider at runtime). Check manually.',
    };
  }
  const id = node.serverId;
  if (typeof id === 'string') {
    // Text ids (e.g. "asana") resolve by name/provider at runtime; never guessed.
    return { ...base, server: id, state: 'NOT_CHECKED', bucket: 'NEEDS_YOU', hint: 'Node uses a text server id (resolved by name/provider at runtime). Check manually.' };
  }
  if (!serverRow) {
    return { ...base, server: id, state: 'SERVER_NOT_VISIBLE', bucket: 'NEEDS_YOU', hint: 'This user cannot see the server. Rerun as a user/admin who can, then judge it.' };
  }
  const wanted = [node.tool, ...(Array.isArray(node.toolNames) ? node.toolNames : [])].filter((t): t is string => !!t);
  if (serverRow.state === 'OK') {
    const missing = wanted.filter((t) => !serverRow.toolNames.includes(t));
    if (missing.length) {
      return {
        ...base,
        server: id,
        state: `TOOL_MISSING: ${missing.join(',')}`,
        bucket: 'BROKEN',
        hint: 'Server is healthy but lacks this tool. Node may point at the wrong server, or the tool was renamed.',
      };
    }
    return { ...base, server: id, state: 'OK', bucket: 'HEALTHY', hint: '' };
  }
  return { ...base, server: id, state: `SERVER_${serverRow.state}`, bucket: serverRow.bucket, hint: serverRow.hint };
}

/** Best-verdict rank for combine(): lower wins. Order: HEALTHY, BROKEN, MAYBE, NEEDS_YOU. */
export function bucketRank(b: McpBucket): number {
  return { HEALTHY: 0, BROKEN: 1, MAYBE: 2, NEEDS_YOU: 3 }[b];
}

export interface ToolSchemaFields {
  name: string;
  fields: { name: string; type: string }[];
}

/**
 * Tool input-schema field names/types from a GetMCPServerTools body.
 * Reads ONLY property names and `type` strings (never values); caps at 40
 * tools × 30 fields so snapshots stay small. Used for AI triage (P11).
 */
export function toolSchemasOf(body: unknown): ToolSchemaFields[] {
  const j = unwrapResponse(body);
  const raw = Array.isArray((j as { tools?: unknown }).tools) ? ((j as { tools: unknown[] }).tools) : [];
  const out: ToolSchemaFields[] = [];
  for (const t of raw.slice(0, 40)) {
    if (!t || typeof t !== 'object') continue;
    const rec = t as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !rec.name) continue;
    const fields: { name: string; type: string }[] = [];
    const schema = rec.inputSchema;
    const props = schema && typeof schema === 'object' ? (schema as Record<string, unknown>).properties : undefined;
    if (props && typeof props === 'object') {
      for (const [fname, fdef] of Object.entries(props as Record<string, unknown>).slice(0, 30)) {
        const ftype = fdef && typeof fdef === 'object' ? (fdef as Record<string, unknown>).type : undefined;
        fields.push({ name: fname.slice(0, 80), type: typeof ftype === 'string' ? ftype.slice(0, 40) : 'unknown' });
      }
    }
    out.push({ name: rec.name.slice(0, 120), fields });
  }
  return out;
}

/**
 * Tool names with AMP's own description, trimmed, for the tester's tool lists. Descriptions are vendor text:
 * stored locally, escaped on the page, and never put into the AI prompt (buildTriagePrompt reads other fields).
 */
export function toolInfoOf(body: unknown): { name: string; description?: string }[] {
  const j = unwrapResponse(body);
  const raw = Array.isArray((j as { tools?: unknown }).tools) ? ((j as { tools: unknown[] }).tools) : [];
  const out: { name: string; description?: string }[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const rec = t as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !rec.name) continue;
    const d = typeof rec.description === 'string' ? rec.description.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    out.push(d ? { name: rec.name.slice(0, 120), description: d } : { name: rec.name.slice(0, 120) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
