import type { RequestGate } from '../../../core/safety/gate';
import type { Credentials } from '../../../core/types';
import type { MenuLink, MenuResult } from '../types';
import { isLoginPath, isNoAccessPath, normalizeRoute, routeMatches, urlPath } from '../../../core/util/route';

/**
 * Finds the JSON literal assigned by `var navigation = ...` in AMP's main page
 * (default.cshtml embeds the per-user menu built by default.navigation.cs).
 */
export function extractNavigation(html: string): unknown | null {
  const m = /var\s+navigation\s*=\s*/.exec(html);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < html.length && /\s/.test(html[i]!)) i++;
  const open = html[i];
  if (open !== '[' && open !== '{') return null;

  let depth = 0;
  let inStr: string | null = null;
  for (let j = i; j < html.length; j++) {
    const c = html[j]!;
    if (inStr) {
      if (c === '\\') j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        const literal = html.slice(i, j + 1);
        try {
          return JSON.parse(literal);
        } catch {
          return { __unparsed: literal };
        }
      }
    }
  }
  return null;
}

/** Walks the navigation tree and returns every item that has a link. */
export function collectMenuLinks(nav: unknown): MenuLink[] {
  const out: MenuLink[] = [];
  const seen = new Set<string>();

  if (nav && typeof nav === 'object' && '__unparsed' in nav) {
    // Fallback: pull "link":"..." pairs out of the raw literal.
    const raw = String((nav as { __unparsed: string }).__unparsed);
    for (const m of raw.matchAll(/"link"\s*:\s*"([^"]*)"/g)) {
      const link = normalizeRoute(m[1]);
      if (link && !seen.has(link)) {
        seen.add(link);
        out.push({ name: '', link, key: '' });
      }
    }
    return out;
  }

  const walk = (node: unknown, depth: number) => {
    if (depth > 20 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, depth + 1));
      return;
    }
    const o = node as Record<string, unknown>;
    if (typeof o.link === 'string') {
      const link = normalizeRoute(o.link);
      if (link && !seen.has(link)) {
        seen.add(link);
        out.push({ name: typeof o.name === 'string' ? o.name : '', link, key: typeof o.key === 'string' ? o.key : '' });
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(nav, 0);
  return out;
}

/** Loads AMP's main page as the user (following same-host redirects) and extracts their menu. */
export async function fetchMenu(
  gate: RequestGate,
  userType: string,
  creds: Credentials,
  shellPath: string,
): Promise<MenuResult> {
  let url = gate.resolve(shellPath);
  for (let hop = 0; hop < 6; hop++) {
    const res = await gate.fetch(userType, 'GET', url, creds);
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get('location') ?? '/', url);
      const path = urlPath(next.href);
      if (isLoginPath(path)) return { userType, ok: false, reason: `redirected to ${path} - token expired or wrong`, links: [] };
      if (isNoAccessPath(path)) return { userType, ok: false, reason: 'main page redirected to /noaccess', links: [] };
      if (next.host.toLowerCase() !== gate.baseHost) {
        return { userType, ok: false, reason: `main page redirected off-site to ${next.host}`, links: [] };
      }
      url = next;
      continue;
    }
    if (!res.ok) return { userType, ok: false, reason: `main page returned HTTP ${res.status}`, links: [] };

    const nav = extractNavigation(await res.text());
    if (nav === null) {
      return { userType, ok: false, reason: `no "var navigation" found on ${url.pathname}; check shellPath in config`, links: [] };
    }
    return { userType, ok: true, links: collectMenuLinks(nav) };
  }
  return { userType, ok: false, reason: 'too many redirects loading main page', links: [] };
}

export function menuHasRoute(menu: MenuResult, route: string): boolean {
  return menu.links.some((l) => routeMatches(l.link, route));
}

/**
 * How the route is in the menu: the route itself ("exact"), only a sub-page of it ("sub", e.g. the
 * menu links "collateral/internal-playbook/marketing/overview" but not "collateral/internal-playbook"),
 * or not at all (null).
 */
export function menuMatch(menu: MenuResult, route: string): { kind: 'exact' } | { kind: 'sub'; link: string } | null {
  const r = normalizeRoute(route);
  if (menu.links.some((l) => normalizeRoute(l.link) === r)) return { kind: 'exact' };
  const sub = menu.links.find((l) => routeMatches(l.link, route));
  return sub ? { kind: 'sub', link: normalizeRoute(sub.link) } : null;
}
