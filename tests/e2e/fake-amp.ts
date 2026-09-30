import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

/**
 * A tiny stand-in for AMP that mimics the behaviours the tool relies on:
 * cookie auth (jwt + X-CSRF-Token), `var navigation = [...]` in the main page,
 * hash routes loaded as fragments, 302 → /noaccess, the .error-text-2 no-access page,
 * and api.ashx returning {status, result}. Each page encodes one scenario for partner_sales.
 */

export const TOKENS = {
  site_admin: { jwt: 'admin-jwt-0123456789', csrf: 'csrf-admin-0123456789' },
  partner_sales: { jwt: 'partner-jwt-0123456789', csrf: 'csrf-partner-0123456789' },
};

type User = 'admin' | 'partner';

interface PageDef {
  route: string;
  title: string;
  apis: string[];
  partner: 'open' | 'redirect' | 'inline-noaccess' | 'open-api-denied' | 'custom-deny' | 'blank' | 'error-box' | 'dashboard';
  partnerMenu: boolean;
  /** How the page behaves for the admin (default: opens). */
  admin?: 'open' | 'redirect' | 'blank' | 'dashboard';
}

export const PAGES: PageDef[] = [
  { route: 'setup/roles', title: 'Roles', apis: ['getroles'], partner: 'redirect', partnerMenu: false }, // PASS (No)
  { route: 'setup/users/list', title: 'Users', apis: ['getusers'], partner: 'open', partnerMenu: false }, // SECURITY GAP
  { route: 'setup/brand', title: 'Brand', apis: ['getbrand'], partner: 'redirect', partnerMenu: true }, // BROKEN (Yes)
  { route: 'setup/leadrouting', title: 'Lead Routing', apis: ['getleadrouting'], partner: 'inline-noaccess', partnerMenu: false }, // PASS (No), 200 + marker
  { route: 'connections/contacts', title: 'Contacts', apis: ['getcontacts'], partner: 'open', partnerMenu: true }, // PASS (Yes)
  { route: 'report/assets', title: 'Asset Report', apis: ['getassetreport'], partner: 'open-api-denied', partnerMenu: true }, // OPENS EMPTY (Yes)
  { route: 'setup/customdeny', title: 'Custom Deny', apis: ['getcustom'], partner: 'custom-deny', partnerMenu: false }, // PASS (No): page's own message, not AMP's screen
  { route: 'insights/dashboard', title: 'Dashboard', apis: [], partner: 'dashboard', admin: 'dashboard', partnerMenu: true }, // PASS both: different widgets per user
  { route: 'setup/blankno', title: 'Blank No', apis: ['getblankno'], partner: 'blank', partnerMenu: false }, // PASS (No): blank page = nothing usable
  { route: 'setup/blankyes', title: 'Blank Yes', apis: ['getblankyes'], partner: 'blank', partnerMenu: true }, // FAIL (Yes): blank for partner, admin gets it
  { route: 'setup/errorbox', title: 'Error Box', apis: ['geterrorbox'], partner: 'error-box', partnerMenu: false }, // PASS (No): error = nothing usable
  { route: 'manage/nonono', title: 'No No No', apis: ['getnonono'], partner: 'redirect', admin: 'redirect', partnerMenu: false }, // PASS for everyone
  { route: 'setup/broken', title: 'Broken', apis: ['getbroken'], partner: 'blank', admin: 'blank', partnerMenu: true }, // REVIEW: renders for nobody
  { route: 'manage/mdf/funds', title: 'Request MDF', apis: ['getfunds', 'savelastviewed'], partner: 'open', partnerMenu: true }, // PASS, write api must be blocked
];

export const received: { user: User | null; method: string; path: string; func?: string }[] = [];

function cookiesOf(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2) as [string, string][],
  );
}

/** Like AMP: the jwt alone says who the user is. */
function userOf(req: IncomingMessage): User | null {
  const jwt = cookiesOf(req).jwt;
  if (jwt === TOKENS.site_admin.jwt) return 'admin';
  if (jwt === TOKENS.partner_sales.jwt) return 'partner';
  return null;
}

function shell(user: User): string {
  const links = PAGES.filter((p) => user === 'admin' || p.partnerMenu).map((p) => ({ name: p.title, link: '#' + p.route, key: p.title }));
  const nav = [{ name: 'Main', link: '', items: links }, { name: 'Dashboard', link: '#dashboard/' + (user === 'admin' ? 'admin' : 'sales') }];
  return `<!doctype html><html><head><title>AMP</title></head><body>
<div id="nav">menu</div><div id="header"><h1>AMP</h1></div><div id="content"></div>
<script>
var navigation = ${JSON.stringify(nav)};
function csrf(){ var m = document.cookie.match(/X-CSRF-Token=([^;]+)/); return m ? m[1] : ''; }
function api(f){ return fetch('/services/api.ashx?func=' + f, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, body: '{}' }).then(function(r){ return r.json(); }).catch(function(){ return null; }); }
function load(){
  var h = location.hash.replace(/^#/, ''); if (!h) return;
  fetch('/' + h).then(function(r){ return r.text(); }).then(function(t){
    var c = document.getElementById('content'); c.innerHTML = t;
    var el = c.querySelector('[data-apis]');
    if (el) el.getAttribute('data-apis').split(',').forEach(function(f){ api(f).then(function(res){
      if (res && res.status === 0) { var p = document.createElement('p'); p.textContent = 'rows loaded'; el.appendChild(p); }
    }); });
  });
}
window.addEventListener('hashchange', load); load(); api('getnotifications');
// Plays a third-party script on the page trying to read the session: must never see the jwt (HttpOnly).
if (document.cookie.indexOf('jwt=') >= 0) fetch('/leak-probe?saw=jwt');
</script></body></html>`;
}

const NOACCESS = `<div class="error-text-2">401</div><p>You do not have access to this page.</p>`;

export function startFakeAmp(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const user = userOf(req);
    const func = url.searchParams.get('func')?.toLowerCase();
    received.push({ user, method: req.method ?? '', path, func });

    const send = (status: number, body: string, type = 'text/html', headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(body);
    };

    if (path === '/leak-probe') return send(204, '');
    if (path === '/login') return send(200, '<h1>Login</h1>');
    if (path === '/noaccess') return send(200, NOACCESS);
    if (!user) return send(302, '', 'text/html', { Location: '/login' });

    if (path === '/services/api.ashx') {
      if (req.method !== 'POST') return send(405, '');
      // Like AMP (APIRequest.VerifyHeaderCSRF): double-submit, header must equal cookie; value is not tied to the user.
      const csrfCookie = cookiesOf(req)['X-CSRF-Token'];
      if (!csrfCookie || req.headers['x-csrf-token'] !== csrfCookie) {
        return send(200, JSON.stringify({ status: 3, result: { code: 'c', message: 'CSRF mismatch' } }), 'application/json');
      }
      if (func === 'getpermissiondataforuser') {
        const result =
          user === 'admin'
            ? { userName: 'Site Admin', isSiteAdmin: true, personna: 'prmadmin', isCompanyLevelUser: true, userCompanyName: 'Fake Co' }
            : { userName: 'Pat Partner', isSiteAdmin: false, personna: 'channelpartner', isCompanyLevelUser: false, organizationID: 7, organizationName: 'Partner Org' };
        return send(200, JSON.stringify({ status: 0, result, version: 'fake-build-1' }), 'application/json');
      }
      if (user === 'partner' && func === 'getassetreport') {
        return send(200, JSON.stringify({ status: 3, result: { code: 'x1', message: 'You do not have access to this report' } }), 'application/json');
      }
      return send(200, JSON.stringify({ status: 0, result: { rows: [1, 2, 3] } }), 'application/json');
    }

    // Like AMP (BeginRequest): issue a random CSRF cookie when the browser has none.
    if (path === '/') {
      const extra: Record<string, string> = cookiesOf(req)['X-CSRF-Token'] ? {} : { 'Set-Cookie': `X-CSRF-Token=${randomUUID()}; Path=/` };
      return send(200, shell(user), 'text/html', extra);
    }

    const page = PAGES.find((p) => '/' + p.route === path);
    if (!page) return send(404, 'not found');
    const content = `<div id="${page.route.replace(/\//g, '-')}-grid" data-apis="${page.apis.join(',')}"><h2>${page.title}</h2><table id="${page.route.replace(/\//g, '-')}-table"><tr><td>data</td></tr></table></div>`;
    const dashboard = (who: User) => who === 'admin'
      ? '<div id="dash"><h2>Company overview</h2><div id="widget-revenue">Revenue</div><div id="widget-pipeline">Pipeline</div></div>'
      : '<div id="dash-partner"><div id="widget-my-deals">My deals</div><div id="widget-training">Training</div></div>';
    if (user === 'admin') {
      switch (page.admin ?? 'open') {
        case 'redirect':
          return send(302, '', 'text/html', { Location: '/noaccess' });
        case 'blank':
          return send(200, '<div></div>');
        case 'dashboard':
          return send(200, dashboard('admin'));
        default:
          return send(200, content);
      }
    }
    switch (page.partner) {
      case 'blank':
        return send(200, '<div></div>');
      case 'error-box':
        return send(200, '<div class="alert">Something went wrong. Please try again later.</div>');
      case 'dashboard':
        return send(200, dashboard('partner'));
      case 'redirect':
        return send(302, '', 'text/html', { Location: '/noaccess' });
      case 'inline-noaccess':
        return send(200, NOACCESS);
      case 'custom-deny':
        return send(200, '<div class="alert"><h3>Restricted area</h3><p>You do not have permission to view this page.</p></div>');
      default:
        return send(200, content);
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}
