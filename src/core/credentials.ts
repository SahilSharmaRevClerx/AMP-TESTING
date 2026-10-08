import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Credentials } from './types';
import { cleanJwt, registerSecret } from './util/mask';

export function envKey(userType: string): string {
  return userType.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** Loads .env.local if present (tester convenience), without overriding existing variables. `only` limits it to those names. */
export function loadLocalEnv(file = '.env.local', only?: string[]): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const [, k, v] = m;
    if (only && !only.includes(k ?? '')) continue;
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
