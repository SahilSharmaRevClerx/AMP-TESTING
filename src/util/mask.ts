const secrets = new Set<string>();

/** Registers a secret so it is masked wherever scrub() is applied. */
export function registerSecret(value: string): void {
  if (value && value.length >= 8) secrets.add(value);
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
