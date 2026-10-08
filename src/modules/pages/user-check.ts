import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserCheckResult, UserCheckRunner } from '../../core/contracts';
import { selectUserTypes } from '../../core/rulebook/parse';
import type { Identity } from '../../core/types';
import { buildConfig } from './config';
import { executeRun, newRunId } from './run';
import type { CheckResult } from './types';

/**
 * The Pages engine offered to other modules (today the Permission Setter, after Apply): open the
 * rulebook pages as each given column's user and say what each one saw. The run is a normal page
 * test in the output folder, so it also shows in Past runs.
 */
export function createUserCheck(dirs: { outputDir: string; debugDir: string }): UserCheckRunner {
  return async (input) => {
    const rb = selectUserTypes(input.rulebook, input.columns);
    const userTypes: Record<string, { label: string }> = {};
    for (const k of rb.userTypes) userTypes[k] = { label: rb.userTypeLabels[k] ?? k };
    const cfg = buildConfig(
      { environment: input.environment, rulebook: '(permission setter)', calibrationUserType: null, userTypes, outputDir: dirs.outputDir, debugDir: dirs.debugDir, debugShots: true, headless: input.headless },
      'permission setter',
    );
    const runId = newRunId(`${input.environment.name}-after-setter`);
    const started = new Date().toISOString();
    const outcome = await executeRun(
      { cfg, rulebook: rb, rulebookSource: input.rulebookSource, creds: input.creds, only: input.columns, signal: input.signal, reporter: { log: input.log }, notes: [input.note] },
      runId,
    );
    const out: UserCheckResult = { runId, users: {} };
    if (outcome.error) out.error = outcome.error;
    if (outcome.reportFile) out.reportUrl = `/output/${runId}/report.html`;
    try {
      writeFileSync(
        join(outcome.outDir, 'summary.json'),
        JSON.stringify({ runId, environment: { name: cfg.environment.name, baseUrl: cfg.environment.baseUrl }, rulebook: input.rulebookSource.name, startedAt: started, finishedAt: new Date().toISOString(), status: outcome.error ? 'failed' : 'done', code: outcome.code, error: outcome.error ?? null, summary: outcome.summary, reportUrl: out.reportUrl ?? null }),
      );
    } catch {
      /* history is best-effort */
    }

    const resultsFile = join(outcome.outDir, 'results.json');
    if (!existsSync(resultsFile)) return out;
    const data = JSON.parse(readFileSync(resultsFile, 'utf8')) as { results: CheckResult[]; meta?: { identities?: Identity[] } };
    for (const column of input.columns) {
      const rows = data.results.filter((x) => x.userType === column && x.type === 'page');
      out.users[column] = {
        userName: data.meta?.identities?.find((i) => i.userType === column)?.userName,
        pages: rows.map((x) => ({
          label: x.label,
          route: x.route,
          expected: x.expected ?? '-',
          verdict: x.verdict,
          state: x.state,
          reason: x.reason,
          shot: x.evidence?.screenshot ? join(outcome.outDir, x.evidence.screenshot) : undefined,
        })),
      };
    }
    return out;
  };
}
