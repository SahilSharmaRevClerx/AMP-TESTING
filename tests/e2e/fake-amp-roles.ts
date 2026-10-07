import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for AMP's role screens, for the Permission Setter: Setup → Roles list
 * (tr[data-recordid][data-name] → td[data-action=view]), the role editor with jQuery-UI-like sliders
 * (#mediagridrecorditem<ID>, #systemgridrecorditem<ID>, value = step*2+1), the Advanced checkboxes,
 * the modal Save button → POST /api/SaveRole, the Navigation Layout module list (Super Admin only),
 * and two pages that open or 302 → /noaccess depending on the user's saved role.
 */

export const SETTER_TOKENS = {
  superAdmin: 'sa-jwt-0123456789abcdef',
  user: 'user-jwt-0123456789abcdef',
};

interface RoleState {
  id: number;
  name: string;
  media: Record<string, number>;
  system: Record<string, number>;
  features: Record<string, boolean>;
}

/** The "User" role: Playbooks off, Opportunity at Create. The user has only this role. */
export function freshRoles(): RoleState[] {
  return [
    { id: 11, name: 'Ayush Normal', media: { '32': 1, '16777216': 0 }, system: { '100': 0, '600': 4, '1700': 3 }, features: { '32': false } },
    { id: 12, name: 'Other Role', media: { '32': 0, '16777216': 0 }, system: { '100': 0, '600': 4, '1700': 0 }, features: { '32': false } },
  ];
}

export let roles = freshRoles();
export const saves: { roleid: number; body: unknown }[] = [];

/** Company users (Navigation Layout → Users tab). Only the Super Admin and the "User" have jwts. */
export const COMPANY_USERS = [
  { id: 1, email: 'sahil@revclerx.com', firstname: 'sahil', lastname: 'sharma' },
  { id: 2, email: 'ayushmaan@revclerx.com', firstname: 'Ayushmaan', lastname: '' },
  { id: 3, email: 'anmol.sethi@revclerx.com', firstname: 'Anmol', lastname: 'Sethi' },
];
/** Navigation Layout "Shown to" per module id: display + linked user ids (a whitelist when "specific"). */
export let navSettings: Record<number, { display: string; links: Set<number> }> = {};
export const navWrites: { func: string; body: unknown }[] = [];

export function resetRoles(): void {
  roles = freshRoles();
  saves.length = 0;
  navSettings = { 4: { display: 'all', links: new Set() } };
  navWrites.length = 0;
}
resetRoles();

/** Like Module.CustomModuleAccess: "specific" = only linked users (Super Admins too), "hidden" = nobody. */
export function navAllows(moduleId: number, userId: number): boolean {
  const n = navSettings[moduleId];
  if (!n || n.display === 'all') return true;
  if (n.display === 'specific') return n.links.has(userId);
  return false;
}

const LABELS: Record<string, string> = { 'media:32': 'Email Campaigns', 'media:16777216': 'Playbooks', 'system:100': 'Platform Users', 'system:600': 'Contacts', 'system:1700': 'Opportunity' };

const MODULES = [
  { id: 1, name: 'Internal Playbook', url: 'collateral/internal-playbook', isgroup: false },
  { id: 2, name: 'Opportunities', url: 'manage/opportunity-records', isgroup: false },
  { id: 3, name: 'Dashboard', url: 'dashboard', isgroup: false },
  { id: 4, name: 'Contacts', url: 'connections/contacts', isgroup: false },
];

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2) as [string, string][]);
}

function who(req: IncomingMessage): 'sa' | 'user' | null {
  const j = cookies(req).jwt;
  return j === SETTER_TOKENS.superAdmin ? 'sa' : j === SETTER_TOKENS.user ? 'user' : null;
}

function shell(user: 'sa' | 'user'): string {
  return `<!doctype html><html><head><title>AMP</title><style>.slider{height:10px;background:#ddd;width:400px}</style></head><body>
<script>document.addEventListener('DOMContentLoaded',function(){var m=document.getElementById('modal'); if(!m.innerHTML) m.style.display='none';});</script><div id="nav">menu</div><div id="header"><h1>AMP</h1></div><div id="content"></div><div id="modal" style="position:fixed;inset:0;overflow:auto;background:#fff"></div>
<script>
var navigation = [{ name: 'Main', link: '', items: [] }];
var USER = ${JSON.stringify(user)};
function csrf(){ var m = document.cookie.match(/X-CSRF-Token=([^;]+)/); return m ? m[1] : ''; }
function call(f, body){ return fetch('/api/' + f, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, body: JSON.stringify(body || {}) }).then(function(r){ return r.json(); }); }
// Minimal jQuery: only what the setter uses ($(sel).slider('value'[, v]) and .length).
window.jQuery = function (sel) {
  var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  return { length: el ? 1 : 0, trigger: function (e) { if (el && e === 'click') el.click(); }, slider: function (m, v) {
    if (v === undefined) return Number(el.getAttribute('data-v'));
    el.setAttribute('data-v', v);
    el.querySelector('.fill').style.width = (v / 10 * 100) + '%';
    var grid = el.id.indexOf('media') === 0 ? 'media' : 'system';
    window.roledata[grid][el.getAttribute('recordid')] = (v - 1) / 2;
    return el;
  } };
};
function rolesPage(){
  call('GetRoles').then(function(r){
    document.getElementById('content').innerHTML = '<table>' + r.result.item.map(function(x){
      return '<tr data-recordid="' + x.id + '" data-name="' + x.name + '" data-islocked="0"><td data-action="view">' + x.name + '</td></tr>'; }).join('') + '</table>';
    document.querySelectorAll('td[data-action=view]').forEach(function(td){ td.onclick = function(){ openRole(td.parentNode.getAttribute('data-recordid')); }; });
  });
}
function openRole(id){
  call('GetRolesData', { roleid: id }).then(function(r){
    var d = r.result; window.roledata = { media: d.media, system: d.system, features: d.features, id: d.id };
    var labels = ${JSON.stringify(LABELS)};
    function rows(grid){ return Object.keys(d[grid]).map(function(k){
      var hide = grid === 'system' && k === '600' ? ' style="display:none"' : '';
      return '<tr id="' + grid + 'gridrecorditem' + k + '_row1"' + hide + '><td>' + labels[grid + ':' + k] + '</td><td><div id="' + grid + 'gridrecorditem' + k + '" name="slider" recordid="' + k + '" class="slider ui-slider" data-v="' + (d[grid][k] * 2 + 1) + '"><div class="fill" style="height:10px;background:#36c;width:' + ((d[grid][k] * 2 + 1) * 10) + '%"></div></div></td></tr>' +
        '<tr id="' + grid + 'gridrecorditem' + k + '_row2"><td></td><td>View Edit Create Delete</td></tr>'; }).join(''); }
    document.getElementById('modal').style.display = 'block';
    document.getElementById('modal').innerHTML = '<div class="modal"><a data-action-name="save" href="javascript:void 0">Save</a>' +
      '<ul><li id="media_tab"><a href="javascript:void 0">Marketing Functions</a></li><li id="system_tab"><a href="javascript:void 0">Operations</a></li><li class="feature_tab"><a href="javascript:void 0">Advanced</a></li></ul>' +
      '<table>' + rows('media') + '</table><table>' + rows('system') + '</table>' +
      '<div id="featuresDiv">' + Object.keys(d.features).map(function(k){ return '<div class="settings-line"><input type="checkbox" class="settings-check" id="' + k + '" optionid="' + k + '"' + (d.features[k] ? ' checked' : '') + '>setup menu</div>'; }).join('') + '</div></div>';
    document.querySelectorAll('#featuresDiv input').forEach(function(c){ c.addEventListener('change', function(){ window.roledata.features[c.getAttribute('optionid')] = c.checked; }); });
    document.querySelector('a[data-action-name=save]').onclick = function(){
      call('SaveRole', { roleid: window.roledata.id, json: { media: window.roledata.media, system: window.roledata.system, features: window.roledata.features } }).then(function(){ document.getElementById('modal').innerHTML = ''; document.getElementById('modal').style.display = 'none'; });
    };
  });
}
function navPage(){
  document.getElementById('content').innerHTML = '<ol id="nestable-modules-added"><li class="dd-item dd3-item" data-id="4" data-name="Contacts"><div class="dd3-content">Contacts <span class="manage-module-settings" id="4">cog</span></div></li></ol>';
  document.querySelector('.manage-module-settings').onclick = function(){
    call('GetModuleSettingData', { type: 2, moduleId: 4 }).then(function(r){
      var m = document.getElementById('modal'); m.style.display = 'block';
      m.innerHTML = '<ul><li id="rid_users_li"><a href="javascript:void 0">Users</a></li></ul><div id="rid_users"><table>' + r.result.item.map(function(u){
        return '<tr data-recordid="' + u.id + '"><td>' + u.email + '</td><td>' + (u.selected === '1' ? 'Shown' : 'Hidden') + '</td></tr>'; }).join('') + '</table></div>';
    });
  };
}
function load(){
  var h = location.hash.replace(/^#/, ''); if (!h) return;
  // Like AMP: navigating does not close an open role editor.
  if (h === 'setup/roles' && USER === 'sa') return rolesPage();
  if (h === 'setup/navigationlayout' && USER === 'sa') return navPage();
  fetch('/' + h).then(function(r){ return r.text(); }).then(function(t){ document.getElementById('content').innerHTML = t; });
}
window.addEventListener('hashchange', load); load();
</script></body></html>`;
}

export function startFakeRolesAmp(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const user = who(req);
    const send = (status: number, body: string, type = 'text/html', headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(body);
    };
    const json = (result: unknown, status = 0) => send(200, JSON.stringify({ status, result, version: 'fake-roles-1' }), 'application/json');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (path === '/login') return send(200, '<h1>Login</h1>');
      if (path === '/noaccess') return send(200, '<div class="error-text-2">401</div><h2>Oops! No access</h2>');
      if (!user) return send(302, '', 'text/html', { Location: '/login' });

      const func = path.startsWith('/api/') ? path.slice(5).toLowerCase() : path === '/services/api.ashx' ? url.searchParams.get('func')?.toLowerCase() : undefined;
      if (func) {
        const csrf = cookies(req)['X-CSRF-Token'];
        if (!csrf || req.headers['x-csrf-token'] !== csrf) return json({ code: 'c', message: 'CSRF mismatch' }, 3);
        if (func === 'getpermissiondataforuser') return json(user === 'sa' ? { userName: 'sahil sharma', isSiteAdmin: false, userCompanyName: 'Rev Sparks' } : { userName: 'Ayushmaan', isSiteAdmin: false, userCompanyName: 'Rev Sparks' });
        if (func === 'getmodulesfornavigationlayout') return user === 'sa' ? json({ modulesArray: MODULES.map((m) => ({ ...m, level: navSettings[m.id]?.display ?? 'all' })) }) : json({ code: 'x', message: 'only site admin user can add/ update modules' }, 3);
        if (func === 'getmodulesettingdata' && user === 'sa') {
          const n = navSettings[Number(body.moduleId)] ?? { display: 'all', links: new Set<number>() };
          return json({ item: COMPANY_USERS.map((u) => ({ ...u, friendlyname: `${u.firstname} ${u.lastname}`.trim(), selected: n.links.has(u.id) ? '1' : '0' })), row_count: COMPANY_USERS.length });
        }
        if (func === 'togglemodulesettinglink' && user === 'sa') {
          navWrites.push({ func, body });
          const n = (navSettings[Number(body.moduleid)] ??= { display: 'all', links: new Set() });
          const id = Number(body.linktoid);
          if (n.links.has(id)) n.links.delete(id);
          else n.links.add(id);
          // Like ToggleModuleSettingLink: with a settings row, the display follows the link count.
          n.display = n.links.size ? 'specific' : 'all';
          return json(true);
        }
        if (func === 'updatemodulesetting' && user === 'sa') {
          navWrites.push({ func, body });
          const n = (navSettings[Number(body.moduleId)] ??= { display: 'all', links: new Set() });
          const display = body.configurationval?.items?.[0]?.permissions?.[0]?.display;
          if (display === 'specific' && !n.links.size) return json({ status: false, errors: ['NO_SETTINGS_ADDED'] });
          n.display = display;
          if (display !== 'specific') n.links.clear();
          return json({ status: true, errors: [] });
        }
        if (user !== 'sa') return json({ rows: [1] });
        if (func === 'getroles') return json({ item: roles.map((r) => ({ id: r.id, name: r.name })), row_count: roles.length });
        if (func === 'getrolesdata') {
          const r = roles.find((x) => x.id === Number(body.roleid))!;
          return json({ id: r.id, media: { ...r.media }, system: { ...r.system }, features: { ...r.features } });
        }
        if (func === 'saverole') {
          const r = roles.find((x) => x.id === Number(body.roleid))!;
          saves.push({ roleid: r.id, body });
          r.media = { ...body.json.media };
          r.system = { ...body.json.system };
          r.features = { ...body.json.features };
          return json(true);
        }
        return json({ rows: [1] });
      }
      if (path === '/') return send(200, shell(user));

      // Pages: open only when the user's role allows them (like Module.HasAccess → 302 /noaccess).
      const mine = roles.find((r) => r.name === 'Ayush Normal')!;
      const allowed = (route: string) => user === 'sa' || (route === 'collateral/internal-playbook' ? mine.media['16777216']! >= 1 : route === 'manage/opportunity-records' ? mine.system['1700']! >= 1 : false);
      const route = path.slice(1);
      if (route === 'connections/contacts') {
        const uid = user === 'sa' ? 1 : 2;
        if (!navAllows(4, uid)) return send(302, '', 'text/html', { Location: '/noaccess' });
        return send(200, '<div id="contacts-grid"><h2>Contacts</h2><table id="t-contacts"><tr><td>data</td></tr></table></div>');
      }
      if (route === 'collateral/internal-playbook' || route === 'manage/opportunity-records') {
        if (!allowed(route)) return send(302, '', 'text/html', { Location: '/noaccess' });
        return send(200, `<div id="${route.replace(/\//g, '-')}-grid"><h2>${route}</h2><table id="t-${route.replace(/\//g, '-')}"><tr><td>data</td></tr></table></div>`);
      }
      return send(200, '<div class="error-404"><h2>Looks like you’re lost</h2><p>ERROR CODE: 404</p></div>');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

/** A stand-in for the Gemini API (models/<model>:generateContent): records each request and answers with a fixed review. */
export function startFakeGemini(): Promise<{ server: Server; baseUrl: string; requests: { path: string; key: string; body: { contents?: { parts: { text?: string; inlineData?: unknown }[] }[] } }[] }> {
  const requests: { path: string; key: string; body: { contents?: { parts: { text?: string; inlineData?: unknown }[] }[] } }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', key: String(req.headers['x-goog-api-key'] ?? ''), body: raw ? JSON.parse(raw) : {} });
      const review = { verdict: 'pass', summary: 'Every outlined slider matches the wanted level and the user pages match the rulebook.', checks: [{ item: 'Playbooks', kind: 'slider', expected: 'View', observed: 'View', ok: 'yes', note: '' }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(review) }] }, finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
          modelVersion: 'gemini-fake',
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }));
  });
}
