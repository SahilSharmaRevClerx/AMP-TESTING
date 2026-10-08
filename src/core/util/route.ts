/**
 * Normalizes any form of an AMP route to "a/b/c":
 * "/#setup/roles", "#setup/roles/", "https://x/#setup/roles?y=1", "/setup/roles" -> "setup/roles".
 */
export function normalizeRoute(raw: string | undefined | null): string {
  let r = (raw ?? '').trim();
  if (/^https?:\/\//i.test(r)) {
    try {
      const u = new URL(r);
      r = u.hash ? u.hash : u.pathname;
    } catch {
      // not a URL after all; fall through
    }
  }
  r = r.replace(/^[/#]+/, '');
  r = r.split('?')[0] ?? '';
  r = r.replace(/\/+$/, '');
  return r.toLowerCase();
}

/**
 * A menu link covers a rule route when it is the same route or a sub-route of it,
 * e.g. rule "coursecatalog" is covered by menu link "coursecatalog/courses",
 * rule "dashboard" by "dashboard/channelmanager".
 */
export function routeMatches(menuLink: string, ruleRoute: string): boolean {
  const m = normalizeRoute(menuLink);
  const r = normalizeRoute(ruleRoute);
  if (!m || !r) return false;
  return m === r || m.startsWith(r + '/');
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'x';
}

/** Path of a URL, lower-cased, without query/hash. */
export function urlPath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase().replace(/\/+$/, '') || '/';
  } catch {
    return '';
  }
}

const LOGIN_PATHS = [/^\/login\b/, /^\/sessionexpired\b/, /^\/public\/login\b/];
export function isLoginPath(path: string): boolean {
  return LOGIN_PATHS.some((re) => re.test(path));
}
export function isNoAccessPath(path: string): boolean {
  return /^\/noaccess\b/.test(path);
}
export function isNotFoundPath(path: string): boolean {
  return /^\/notfound\b/.test(path);
}
export function isErrorPath(path: string): boolean {
  return /^\/error(500)?\b/.test(path);
}
