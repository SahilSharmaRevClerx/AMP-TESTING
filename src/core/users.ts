import { makeCredentials } from './credentials';
import { getHandoff } from './handoff';
import { HttpError } from './http';
import type { Credentials } from './types';

/** One user row as a page sends it. */
export interface UserInput {
  key: string;
  label?: string;
  jwt?: string;
  csrf?: string;
  test?: boolean;
  /** Use the jwt this user had in another module's run (hand-off id) instead of a pasted one. */
  handoff?: string;
}

/** The jwt for a user row: pasted, or kept from a hand-off. */
export function jwtOf(u: UserInput | undefined): string | undefined {
  const pasted = u?.jwt?.trim();
  if (pasted) return pasted;
  if (!u?.handoff) return undefined;
  return getHandoff(u.handoff)?.jwts.get(u.key);
}

export function credsFrom(users: UserInput[], keys: string[]): Map<string, Credentials> {
  const creds = new Map<string, Credentials>();
  for (const key of keys) {
    const u = users.find((x) => x.key === key);
    const jwt = jwtOf(u);
    if (!jwt) throw new HttpError(400, u?.handoff ? `the jwt kept from the Permission Setter for ${u.label || key} has expired: paste it again` : `jwt missing for ${u?.label || key}`);
    creds.set(key, makeCredentials(jwt, u?.csrf));
  }
  return creds;
}
