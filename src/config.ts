import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Credentials, RunConfig } from './types';
import { cleanJwt, registerSecret } from './util/mask';

const DEFAULTS: Omit<RunConfig, 'environment' | 'userTypes' | 'calibrationUserType'> = {
  rulebook: 'rulebook/internal-user-personas.csv',
  shellPath: '/',
  delayMs: 500,
  pageTimeoutMs: 20000,
  settleMs: 1000,
  fingerprintThreshold: 0.6,
  parallelUsers: 3,
  headless: true,
  outputDir: 'output',
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

export function envKey(userType: string): string {
  return userType.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** Loads .env.local if present (tester convenience), without overriding existing variables. */
export function loadLocalEnv(file = '.env.local'): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const [, k, v] = m;
    if (k && v && process.env[k] === undefined) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
}

/**
 * Credentials for one user. Only the jwt identifies the user. AMP's CSRF check is a double-submit
 * (the X-CSRF-Token header must equal the X-CSRF-Token cookie; the value is not tied to the session,
 * and AMP itself issues a random GUID when the cookie is missing), so when none is given we generate one
 * and send it as both cookie and header.
 */
export function makeCredentials(jwt: string, csrf?: string): Credentials {
  const c = { jwt: cleanJwt(jwt), csrf: csrf?.trim() || randomUUID() };
  registerSecret(c.jwt);
  registerSecret(c.csrf);
  return c;
}

/** Reads AMP_JWT_<TYPE> (required) and AMP_CSRF_<TYPE> (optional). Returns null without a jwt. */
export function credentialsFor(userType: string): Credentials | null {
  const k = envKey(userType);
  const jwt = process.env[`AMP_JWT_${k}`]?.trim();
  if (!jwt) return null;
  return makeCredentials(jwt, process.env[`AMP_CSRF_${k}`]);
}
