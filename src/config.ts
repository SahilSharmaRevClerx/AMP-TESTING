import { existsSync, readFileSync } from 'node:fs';
import type { Credentials, RunConfig } from './types';
import { registerSecret } from './util/mask';

const DEFAULTS: Omit<RunConfig, 'environment' | 'userTypes' | 'calibrationUserType'> = {
  rulebook: 'rulebook/internal-user-personas.csv',
  shellPath: '/',
  delayMs: 500,
  pageTimeoutMs: 20000,
  settleMs: 1000,
  fingerprintThreshold: 0.6,
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
  cfg.environment = { ...cfg.environment, name: cfg.environment.name?.trim() || url.host, baseUrl: url.origin };
  return cfg;
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

/** Reads AMP_JWT_<TYPE> / AMP_CSRF_<TYPE>. Returns null when either is missing. */
export function credentialsFor(userType: string): Credentials | null {
  const k = envKey(userType);
  const jwt = process.env[`AMP_JWT_${k}`]?.trim();
  const csrf = process.env[`AMP_CSRF_${k}`]?.trim();
  if (!jwt || !csrf) return null;
  registerSecret(jwt);
  registerSecret(csrf);
  return { jwt, csrf };
}
