import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Searches every file under the given folders (reports, results, audit logs, screenshots' folder
 * listings, summaries) for any of the secrets. Returns "file: secret-prefix" for each hit.
 */
export function scanForSecrets(dirs: string[], secrets: string[], extraTexts: Record<string, string> = {}): string[] {
  const hits: string[] = [];
  const check = (where: string, text: string) => {
    for (const s of secrets) if (s && text.includes(s)) hits.push(`${where}: contains ${s.slice(0, 8)}…`);
  };
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else check(p, readFileSync(p).toString('latin1'));
    }
  };
  dirs.forEach(walk);
  for (const [where, text] of Object.entries(extraTexts)) check(where, text);
  return hits;
}

/**
 * Scans the MCP module outputs (snapshots, raw answers, audit) for secrets.
 * Used by the MCP e2e suites; snapshots and raw answers must never hold a jwt.
 */
export function scanMcpOutputs(outputDir: string, secrets: string[]): string[] {
  return scanForSecrets([join(outputDir, '_mcp')], secrets);
}
