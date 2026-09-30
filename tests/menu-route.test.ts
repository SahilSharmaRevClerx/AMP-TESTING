import { describe, expect, it } from 'vitest';
import { collectMenuLinks, extractNavigation, menuHasRoute } from '../src/probe/menu';
import { normalizeRoute, routeMatches } from '../src/util/route';

describe('normalizeRoute', () => {
  it.each([
    ['/#setup/roles', 'setup/roles'],
    ['#setup/roles/', 'setup/roles'],
    ['https://x.amp.vg/#Setup/Roles?tab=1', 'setup/roles'],
    ['/setup/roles', 'setup/roles'],
    ['', ''],
  ])('%s -> %s', (input, out) => expect(normalizeRoute(input)).toBe(out));
});

describe('routeMatches', () => {
  it('matches exact and sub-routes only', () => {
    expect(routeMatches('#coursecatalog/courses', 'coursecatalog')).toBe(true);
    expect(routeMatches('dashboard/channelmanager', 'dashboard')).toBe(true);
    expect(routeMatches('setup/rolesx', 'setup/roles')).toBe(false);
    expect(routeMatches('setup', 'setup/roles')).toBe(false);
  });
});

describe('extractNavigation', () => {
  const html = `<script>
    var other = 1;
    var navigation = [{"name":"Setup","link":"","items":[{"name":"Roles","link":"#setup/roles","key":"Roles"},
      {"name":"Weird ] name","link":"setup/users/list","key":"Users"}]},{"name":"Dash","link":"#dashboard/sales"}];
    var after = [1,2];
  </script>`;

  it('extracts the menu JSON even with brackets inside strings', () => {
    const nav = extractNavigation(html);
    const links = collectMenuLinks(nav).map((l) => l.link);
    expect(links).toEqual(['setup/roles', 'setup/users/list', 'dashboard/sales']);
  });

  it('returns null when there is no navigation', () => {
    expect(extractNavigation('<html></html>')).toBeNull();
  });

  it('falls back to raw link scraping when JSON is invalid', () => {
    const nav = extractNavigation(`var navigation = [{"link":"#a/b", bad}];`);
    expect(collectMenuLinks(nav).map((l) => l.link)).toEqual(['a/b']);
  });

  it('menuHasRoute uses route matching', () => {
    const menu = { userType: 'x', ok: true, links: collectMenuLinks(extractNavigation(html)) };
    expect(menuHasRoute(menu, 'dashboard')).toBe(true);
    expect(menuHasRoute(menu, 'setup/groups')).toBe(false);
  });
});
