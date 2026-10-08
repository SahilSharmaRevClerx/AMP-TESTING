import { existsSync, readFileSync } from 'node:fs';
import type { RunConfig } from './types';

const DEFAULTS: Omit<RunConfig, 'environment' | 'userTypes' | 'calibrationUserType'> = {
  rulebook: 'rulebook/internal-user-personas.csv',
  shellPath: '/',
  delayMs: 500,
  // Longest wait for one page to finish loading (slow dev servers took 25 s); fast pages finish in ~1-2 s.
  pageTimeoutMs: 30000,
  settleMs: 1000,
  fingerprintThreshold: 0.6,
  parallelUsers: 3,
  headless: true,
  outputDir: 'output',
  debugShots: true,
  debugDir: 'debug',
};

/** Applies defaults and validates a config, whether it came from a file (CLI) or the web UI. */
export function buildConfig(raw: Partial<RunConfig>, source = 'config'): RunConfig {
  if (!raw.environment?.baseUrl || raw.environment.baseUrl.includes('REPLACE-WITH')) {
    throw new Error(`Set environment.baseUrl in ${source}`);
  }
  let url: URL;
  try {
    url = new URL(raw.environment.baseUrl);
  } catch {
    throw new Error(`Base URL is not a valid URL: ${raw.environment.baseUrl}`);
  }
  if (!raw.userTypes || Object.keys(raw.userTypes).length === 0) throw new Error(`Set userTypes in ${source}`);
  if (raw.calibrationUserType && !raw.userTypes[raw.calibrationUserType]) {
    throw new Error(`calibrationUserType "${raw.calibrationUserType}" must also be listed in userTypes`);
  }
  const cfg = { ...DEFAULTS, ...raw, calibrationUserType: raw.calibrationUserType || null } as RunConfig;
  cfg.parallelUsers = effectiveParallelUsers(cfg);
  cfg.environment = { ...cfg.environment, name: cfg.environment.name?.trim() || url.host, baseUrl: url.origin };
  return cfg;
}

/** Max user types tested at the same time. */
export const MAX_PARALLEL_USERS = 5;

/**
 * How many user types are tested at the same time (each in its own browser and session).
 * 1–5; production is always 1 so a run never adds more than one user's load there.
 */
export function effectiveParallelUsers(cfg: Pick<RunConfig, 'parallelUsers' | 'environment'>): number {
  if (cfg.environment.isProduction) return 1;
  const n = Math.round(Number(cfg.parallelUsers));
  return Number.isFinite(n) ? Math.min(MAX_PARALLEL_USERS, Math.max(1, n)) : 3;
}

export function loadConfig(file: string): RunConfig {
  if (!existsSync(file)) {
    throw new Error(`Config not found: ${file}. Copy run.config.example.json to run.config.json and fill in the environment.`);
  }
  return buildConfig(JSON.parse(readFileSync(file, 'utf8')) as Partial<RunConfig>, file);
}
