const secrets = new Set<string>();

/** Registers a secret so it is masked wherever scrub() is applied. */
export function registerSecret(value: string): void {
  if (value && value.length >= 8) secrets.add(value);
}

/** Drops secrets that are no longer in use, so they aren't kept in memory longer than needed. */
export function forgetSecrets(values: Iterable<string>): void {
  for (const v of values) secrets.delete(v);
}

export function maskToken(value: string): string {
  if (!value) return '(empty)';
  if (value.length <= 10) return '***';
  return `${value.slice(0, 5)}…${value.slice(-3)}`;
}

/** Replaces every registered secret in a string with its masked form. */
export function scrub(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join(maskToken(s));
  return out;
}

/**
 * Cleans what a tester pasted: whitespace, quotes, a leading "jwt=" (copied as a cookie pair),
 * a trailing ";" or other cookies after it.
 */
export function cleanJwt(raw: string): string {
  let v = raw.trim().replace(/^["']|["']$/g, '');
  const m = /(?:^|;\s*)jwt=([^;]+)/i.exec(v);
  if (m) v = m[1]!;
  return v.replace(/;+$/, '').trim();
}
