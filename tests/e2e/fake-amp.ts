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
  partner: 'open' | 'redirect' | 'inline-noaccess' | 'open-api-denied' | 'custom-deny' | 'blank' | 'error-box' | 'dashboard' | 'slow-empty' | 'widget-deny';
  partnerMenu: boolean;
  /** How the page behaves for the admin (default: opens). */
  admin?: 'open' | 'redirect' | 'blank' | 'dashboard' | 'slow-empty' | 'widget-deny';
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
  // Slow server: the page arrives after 1.2 s with a spinner, its list call answers after 1.5 s with no rows → "No Data Found". PASS for both.
  { route: 'connections/slowlist', title: 'Slow List', apis: ['getslowlist'], partner: 'slow-empty', admin: 'slow-empty', partnerMenu: true },
  // A dashboard where one widget says "no permission": the page itself opened. PASS for both.
  // Its Journey widget's data call is denied while the other two load (like AMP's sales dashboard for a normal user).
  { route: 'insights/widgets', title: 'Widgets', apis: ['getwidgetevents', 'getwidgetvideos', 'getwidgetjourney'], partner: 'widget-deny', admin: 'widget-deny', partnerMenu: true },
];

/** In the partner's menu only as a sub-page (like AMP's ".../marketing/overview" under Internal Playbook). */
export const PARTNER_SUB_LINK = 'setup/roles/overview';

export const received: { user: User | null; method: string; path: string; func?: string; at: number }[] = [];

/** MCP Connector Health fixtures (P08 T7 / P10 T7): a healthy server, a dead host, a rejected key, a not-connected server. */
const MCP_FIXTURES = [
  { id: 4, name: 'Healthy MCP', adminScopes: ['company', 'org', 'user'], partnerScopes: ['company', 'org', 'user'] },
  { id: 5, name: 'Key MCP', adminScopes: ['company', 'org', 'user'], partnerScopes: ['company', 'org'] },
  { id: 6, name: 'Dead MCP', adminScopes: ['company'], partnerScopes: [] },
  { id: 8, name: 'OAuth MCP', adminScopes: ['company', 'org'], partnerScopes: [] },
  { id: 9, name: 'ServiceAcct MCP', adminScopes: ['company'], partnerScopes: [] },
];

/** Calls to GetMCPServerTools(4) so far: the second call lists one more tool, so a second run shows "changes". */
let healthyToolCalls = 0;

function mcpToolList(id: number): unknown {
  if (id === 4) {
    healthyToolCalls += 1;
    const tools: { name: string; description: string; inputSchema: unknown; permission: string; readOnly: boolean }[] = [
      { name: 'good_tool', description: 'a good tool', inputSchema: { type: 'object', properties: { query: { type: 'string' }, when: { type: 'string' } }, required: ['query'] }, permission: 'allow', readOnly: true },
    ];
    if (healthyToolCalls > 1) tools.push({ name: 'new_tool', description: 'a new tool', inputSchema: {}, permission: 'allow', readOnly: true });
    return { tools };
  }
  if (id === 5) return { error: 'The server rejected the key in Headers' };
  if (id === 6) return { error: 'No such host is known for this tunnel' };
  if (id === 8) return { error: 'this server is not connected to your account' };
  // P15 T1: service-account mint failure, exact AMP templates (MCP fixtures are source-shaped, synthetic hosts).
  if (id === 9) return { error: "This connector's service account could not sign in: The token endpoint login.example.com refused the service account (HTTP 401): invalid_client" };
  return { error: 'not connected to your account' };
}

const mcpLiteral = (value: unknown) => ({ expression: { type: 'Literal', value } });

const MCP_WORKFLOWS = [
  { definitionId: 'w1', name: 'WF Orders' },
  { definitionId: 'w2', name: 'WF Support' },
  { definitionId: 'w4', name: 'WF Archive' },
];

/**
 * P14 workflow-kind fixtures: which definition ids AMP's own UI lists hold.
 * w1 is published (Automation tab), w2 is draft-only, w3 is a public template
 * our endpoint does not list at all, w4 is in no UI list (unlisted).
 */
const KIND_FOLDERS: Record<string, { definitionId: string; name: string }[]> = {
  'true|false|false|false': [{ definitionId: 'w1', name: 'WF Orders' }],
  'true|false|true|false': [],
  'true|false|false|true': [],
  'false|false|false|false': [{ definitionId: 'w2', name: 'WF Support' }],
  'false|false|true|false': [],
  'false|false|false|true': [],
  'false|true|false|false': [{ definitionId: 'w3', name: 'Template Zoho' }],
  'false|true|true|false': [],
};

/** Test-only switch: when true, the UI-list POSTs fail (P14 "failing list" case). */
let kindsShouldFail = false;

function kindRow(definitionId: string, name: string, flags: { isPublished: boolean; isPublic: boolean }): unknown {
  return {
    definitionId, name, description: `${name} description`,
    isPublished: flags.isPublished, isPublic: flags.isPublic,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', version: 1,
    createdByName: 'Fake Admin', updatedByName: 'Fake Admin', category: 0,
  };
}

function mcpWorkflowDetail(id: string): unknown {
  if (id === 'w1') {
    return {
      activities: [
        { type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: mcpLiteral(4), toolName: mcpLiteral('good_tool') } },
        { type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: mcpLiteral(4), toolName: mcpLiteral('missing_tool') } },
        // P15 T3: fixed arguments missing the tool's required 'query' field.
        { type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: mcpLiteral(4), toolName: mcpLiteral('good_tool'), argumentsJson: mcpLiteral('{"when":"weekly"}') } },
      ],
    };
  }
  if (id === 'w4') {
    return {
      activities: [
        { type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: mcpLiteral(4), toolName: mcpLiteral('good_tool') } },
      ],
    };
  }
  if (id === 'w3') {
    // A shared template with a step calling a tool its connector lacks, plus a
    // fixed-arguments step missing the required field (noted, never counted).
    return {
      name: 'Template Zoho',
      activities: [
        { type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: mcpLiteral(4), toolName: mcpLiteral('template_gone') } },
        { type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: mcpLiteral(4), toolName: mcpLiteral('good_tool'), argumentsJson: mcpLiteral('{"when":"once"}') } },
      ],
    };
  }
  return {
    activities: [
      { type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: mcpLiteral(99), toolName: mcpLiteral('t') } },
      { type: 'ElsaServer.Activities.GmailMCP', inputs: { toolName: mcpLiteral('no_server_tool') } },
      { type: 'Elsa.HttpWebRequest', inputs: {} },
    ],
  };
}

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
  if (user === 'partner') links.push({ name: 'Roles overview', link: '#' + PARTNER_SUB_LINK, key: 'Roles overview' });
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
    if (el) el.getAttribute('data-apis').split(',').filter(Boolean).forEach(function(f){ api(f).then(function(res){
      // List pages: drop the spinner, then show rows or the page's own empty message.
      el.querySelectorAll('.loading-spinner').forEach(function(s){ s.remove(); });
      var empty = res && Array.isArray(res.result) && res.result.length === 0;
      if (res && res.status === 0) { var p = document.createElement('p'); p.textContent = empty ? 'No Data Found' : 'rows loaded'; el.appendChild(p); }
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
    received.push({ user, method: req.method ?? '', path, func, at: Date.now() });

    const send = (status: number, body: string, type = 'text/html', headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(body);
    };

    if (path === '/leak-probe') return send(204, '');
    if (path === '/login') return send(200, '<h1>Login</h1>');
    if (path === '/noaccess') return send(200, NOACCESS);

    // MCP workflow graphs need no login on AMP (security finding); mirror that here.
    if (req.method === 'GET' && path === '/api/elsa-agents/workflow-definitions') {
      return send(200, JSON.stringify(MCP_WORKFLOWS), 'application/json');
    }
    const wfDetail = /^\/api\/elsa-agents\/workflow-definitions\/([\w-]+)$/.exec(path);
    if (req.method === 'GET' && wfDetail) {
      const wf = MCP_WORKFLOWS.find((w) => w.definitionId === wfDetail[1]);
      if (!wf) return send(404, '');
      return send(200, JSON.stringify(mcpWorkflowDetail(wf.definitionId)), 'application/json');
    }

    // P14 designer read for shared templates our endpoint does not list:
    // Latest answers for every known graph, Published 404s for draft-only w3.
    const designer = /^\/elsa\/api\/workflow-definitions\/by-definition-id\/([\w-]+)$/.exec(path);
    if (req.method === 'GET' && designer) {
      const version = url.searchParams.get('versionOptions') ?? 'Latest';
      const id = designer[1]!;
      if (id === 'w3' && version === 'Published') return send(404, JSON.stringify({ error: 'No published workflow' }), 'application/json');
      if (id === 'w1' || id === 'w2' || id === 'w3' || id === 'w4') return send(200, JSON.stringify(mcpWorkflowDetail(id)), 'application/json');
      return send(404, '');
    }

    // P14 UI workflow lists (AMP's own grid). Test-only failure switch for the "failing list" case.
    if (req.method === 'POST' && path === '/test/kinds-fail') {
      let bodyText = '';
      req.on('data', (c: Buffer) => (bodyText += c));
      req.on('end', () => {
        try {
          kindsShouldFail = (JSON.parse(bodyText || '{}') as { fail?: unknown }).fail === true;
        } catch {
          kindsShouldFail = false;
        }
        send(200, JSON.stringify({ fail: kindsShouldFail }), 'application/json');
      });
      return;
    }
    if (req.method === 'POST' && path === '/api/GetAIAutomationWorkflows') {
      let bodyText = '';
      req.on('data', (c: Buffer) => (bodyText += c));
      req.on('end', () => {
        if (kindsShouldFail) return send(500, JSON.stringify({ status: 1, error: 'fake list failure' }), 'application/json');
        const csrfCookie = cookiesOf(req)['X-CSRF-Token'];
        if (!csrfCookie || req.headers['x-csrf-token'] !== csrfCookie) {
          return send(200, JSON.stringify({ status: 3, result: { code: 'c', message: 'CSRF mismatch' } }), 'application/json');
        }
        let body: { type?: unknown; isPublished?: unknown; isPublic?: unknown; hasCategory?: unknown; isAgentic?: unknown; page?: unknown; pageSize?: unknown } = {};
        try {
          body = JSON.parse(bodyText || '{}');
        } catch {
          /* empty */
        }
        if (body.type !== 'definitions') return send(200, JSON.stringify({ status: 1, error: 'fake: only definitions' }), 'application/json');
        const key = [body.isPublished === true, body.isPublic === true, body.hasCategory === true, body.isAgentic === true].join('|');
        const all = (KIND_FOLDERS[key] ?? []).map((w) => kindRow(w.definitionId, w.name, { isPublished: body.isPublished === true, isPublic: body.isPublic === true }));
        const page = typeof body.page === 'number' && body.page >= 0 ? Math.floor(body.page) : 0;
        const pageSize = typeof body.pageSize === 'number' && body.pageSize > 0 ? Math.floor(body.pageSize) : 15;
        const slice = all.slice(page * pageSize, page * pageSize + pageSize);
        return send(200, JSON.stringify({ status: 0, result: { item: slice, row_count: all.length } }), 'application/json');
      });
      return;
    }

    if (!user) return send(302, '', 'text/html', { Location: '/login' });

    // MCP reads via api.ashx?func= (the route form the tool uses) or POST /api/<Func>.
    const mcpFunc = path === '/services/api.ashx' ? (func === 'getmcpservers' || func === 'getmcpservertools' ? func : null) : /^\/api\/(getmcpservers|getmcpservertools)$/i.exec(path)?.[1]?.toLowerCase() ?? null;
    if (req.method === 'POST' && mcpFunc) {
      let bodyText = '';
      req.on('data', (c: Buffer) => (bodyText += c));
      req.on('end', () => {
        let body: { scope?: unknown; mcpServerId?: unknown } = {};
        try {
          body = JSON.parse(bodyText || '{}');
        } catch {
          /* empty */
        }
        const csrfCookie = cookiesOf(req)['X-CSRF-Token'];
        if (!csrfCookie || req.headers['x-csrf-token'] !== csrfCookie) {
          return send(200, JSON.stringify({ status: 3, result: { code: 'c', message: 'CSRF mismatch' } }), 'application/json');
        }
        if (mcpFunc === 'getmcpservers') {
          const scope = typeof body.scope === 'string' ? body.scope : 'company';
          const list = MCP_FIXTURES.filter((s) => (user === 'admin' ? s.adminScopes : s.partnerScopes).includes(scope)).map((s) => ({ id: s.id, name: s.name }));
          return send(200, JSON.stringify({ result: list }), 'application/json');
        }
        return send(200, JSON.stringify(mcpToolList(Number(body.mcpServerId))), 'application/json');
      });
      return;
    }

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
      if (func === 'getwidgetjourney') return send(200, JSON.stringify({ status: 3, result: 'Not authorized.' }), 'application/json');
      if (func === 'getslowlist') {
        setTimeout(() => send(200, JSON.stringify({ status: 0, result: [] }), 'application/json'), 1500);
        return;
      }
      return send(200, JSON.stringify({ status: 0, result: { rows: [1, 2, 3] } }), 'application/json');
    }

    // Like AMP (BeginRequest): issue a random CSRF cookie when the browser has none.
    if (path === '/') {
      const extra: Record<string, string> = cookiesOf(req)['X-CSRF-Token'] ? {} : { 'Set-Cookie': `X-CSRF-Token=${randomUUID()}; Path=/` };
      return send(200, shell(user), 'text/html', extra);
    }

    const page = PAGES.find((p) => '/' + p.route === path);
    // Like AMP: an unknown route renders its "Looks like you're lost / ERROR CODE: 404" screen.
    if (!page) return send(200, '<div class="error-404"><h2>Looks like you’re lost</h2><p>ERROR CODE: 404</p><p>It might have been moved or deleted.</p></div>');
    const content = `<div id="${page.route.replace(/\//g, '-')}-grid" data-apis="${page.apis.join(',')}"><h2>${page.title}</h2><table id="${page.route.replace(/\//g, '-')}-table"><tr><td>data</td></tr></table></div>`;
    const dashboard = (who: User) => who === 'admin'
      ? '<div id="dash"><h2>Company overview</h2><div id="widget-revenue">Revenue</div><div id="widget-pipeline">Pipeline</div></div>'
      : '<div id="dash-partner"><div id="widget-my-deals">My deals</div><div id="widget-training">Training</div></div>';
    const kind = user === 'admin' ? (page.admin ?? 'open') : page.partner;
    if (kind === 'slow-empty') {
      // Only a heading (no ids) plus a spinner: usable only once the list call answered and "No Data Found" shows.
      const html = `<div data-apis="${page.apis.join(',')}"><h2>${page.title}</h2><div class="loading-spinner" style="width:30px;height:30px">…</div></div>`;
      setTimeout(() => send(200, html), 1200);
      return;
    }
    if (kind === 'widget-deny') {
      return send(200, `<div id="wgrid" data-apis="${page.apis.join(',')}"><h2>Overview</h2><div id="w-events"><h3>Events</h3></div><div id="w-videos"><h3>Videos</h3></div>` +
        '<div id="w-journey"><h3>Journey</h3><h4>Permission Needed</h4><p>You do not have the permission. Please go to the "Help" menu above to contact support.</p></div></div>');
    }
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
