/**
 * MCP Connector Health page e2e (P09 T-FE3). Follows tests/e2e/ui-e2e.ts.
 * The P08 T5 backend routes do not exist yet, so the page (served statically
 * from src/modules/mcp/mcp.html) is driven against an in-process stub of the
 * /api/mcp/* contract with synthetic jwts. No real AMP, no real token.
 * Run: npm run e2e:mcp
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { scanForSecrets } from './leak-scan';

const JWT_ADMIN = 'mcp-e2e-admin-jwt-0123456789abcdef';
const JWT_DEFAULT = 'mcp-e2e-default-jwt-0123456789abcdef';
const EVIL = '<img src=x onerror=alert(1)>';

interface E2EServer { id: number; name: string; state: string; bucket: string; tools: number; toolNames: string[]; detail: string; hint: string }
interface E2ENode { workflow: string; tool: string; server: number; state: string; bucket: string; hint: string }
interface E2EAccount { title: string; sub: string; servers: E2EServer[]; nodes: E2ENode[] }

const RESULT: { host: string; when: string; order: string[]; accounts: Record<string, E2EAccount>; changes: Record<string, unknown[]>; firstRun: Record<string, boolean>; notCovered: { webRequestNodes: number } } = {
  host: 'e2e.stub',
  when: '2026-10-06T00:00:00.000Z',
  order: ['default', 'combined'],
  accounts: {
    default: {
      title: 'default',
      sub: '2 workflows, 3 nodes',
      servers: [
        { id: 4, name: 'Healthy MCP', state: 'OK', bucket: 'HEALTHY', tools: 1, toolNames: ['good_tool'], detail: '', hint: '' },
        { id: 5, name: 'Key MCP', state: 'KEY_REJECTED', bucket: 'BROKEN', tools: 0, toolNames: [], detail: 'rejected', hint: 'Update the key or URL.' },
        { id: 6, name: 'Dead MCP', state: 'DEAD_HOST', bucket: 'BROKEN', tools: 0, toolNames: [], detail: 'No such host', hint: 'Re-point the connector.' },
        { id: 8, name: 'OAuth MCP', state: 'NOT_CONNECTED', bucket: 'NEEDS_YOU', tools: 0, toolNames: [], detail: 'not connected', hint: 'Connect it as this user.' },
        { id: 9, name: EVIL, state: 'URL_404', bucket: 'BROKEN', tools: 0, toolNames: [], detail: '404', hint: 'Edit the URL.' },
        { id: 10, name: '=cmd|calc', state: 'URL_404', bucket: 'BROKEN', tools: 0, toolNames: [], detail: '404', hint: 'Edit the URL.' },
      ],
      nodes: [
        { workflow: 'WF1', tool: 'good_tool', server: 4, state: 'OK', bucket: 'HEALTHY', hint: '' },
        { workflow: 'WF1', tool: 'missing_tool', server: 4, state: 'TOOL_MISSING: missing_tool', bucket: 'BROKEN', hint: 'Wrong server?' },
      ],
    },
    combined: { title: 'Combined', sub: '', servers: [], nodes: [] },
  },
  changes: { default: [] },
  firstRun: { default: true },
  notCovered: { webRequestNodes: 2 },
};
RESULT.accounts.combined!.servers = RESULT.accounts.default!.servers;
RESULT.accounts.combined!.nodes = RESULT.accounts.default!.nodes;

const ENUMS = ['UNKNOWN_ERROR', 'BROKEN', 'NEEDS_YOU', 'DEAD_HOST', 'TOOL_MISSING', 'KEY_REJECTED', 'NOT_CONNECTED', 'NOT_VISIBLE', 'OAUTH_EXPIRED', 'URL_404', 'REDIRECT', 'HTML_NOT_MCP', 'UNREACHABLE', 'RATE_LIMITED', 'FORBIDDEN', 'NO_TOOLS', 'API_ERROR', 'MISCONFIGURED', 'NOT_CHECKED', 'SERVER_'];

function stub(): Promise<{ server: Server; baseUrl: string }> {
  const root = process.cwd();
  let polls = 0;
  let started = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : String(body));
    };
    if (url.pathname === '/mcp') return send(200, readFileSync(join(root, 'src', 'modules', 'mcp', 'mcp.html'), 'utf8'), 'text/html');
    if (url.pathname === '/api/mcp/check' && req.method === 'POST') {
      return send(200, { users: [{ key: 'default', ok: true, identity: { name: 'E2E User', persona: 'admin', company: 'E2E Co' } }] });
    }
    if (url.pathname === '/api/mcp/plan' && req.method === 'POST') {
      return send(200, { accounts: 1, workflows: { reachable: true, count: 2 }, estimateSeconds: 30 });
    }
    if (url.pathname === '/api/mcp/runs' && req.method === 'POST') {
      polls = 0;
      started = true;
      return send(202, { run: { id: 'e2e-run' } });
    }
    if (url.pathname === '/api/mcp/runs/current' && req.method === 'GET') {
      if (!started) return send(200, { run: null });
      polls += 1;
      if (polls < 2) {
        return send(200, { run: { id: 'e2e-run', status: 'running', stage: 'tools', stageLabel: 'Asking AMP to connect', current: 'Dead MCP', done: 1, total: 5, lines: [], lineCount: 0 } });
      }
      return send(200, { run: { id: 'e2e-run', status: 'done', stage: 'report', stageLabel: 'Done', current: '', done: 5, total: 5, lines: [], lineCount: 0, outcome: { result: RESULT } } });
    }
    return send(404, { error: 'stub: not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function main(): Promise<number> {
  const failures: string[] = [];
  const { server, baseUrl } = await stub();
  const dlDir = mkdtempSync(join(tmpdir(), 'mcp-e2e-dl-'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, acceptDownloads: true });
    page.on('pageerror', (err) => failures.push(`page script error: ${err.message}`));
    await page.goto(`${baseUrl}/mcp`);
    await page.fill('#env-url', 'https://ai.sb.amp.vg');
    await page.click('#next-1');
    await page.fill('#key-1', 'admin');
    await page.fill('#jwt-1', JWT_ADMIN);
    await page.click('#btn-add');
    await page.fill('#key-2', 'default');
    await page.fill('#jwt-2', JWT_DEFAULT);
    await page.click('#btn-check');
    await page.waitForFunction(() => (document.getElementById('users-msg')?.textContent ?? '').length > 0);
    await page.click('#next-2');
    await page.waitForFunction(() => (document.getElementById('plan-words')?.textContent ?? '').length > 0);
    await page.click('#next-3');
    await page.click('#btn-run');
    await page.waitForFunction(() => (document.getElementById('summary')?.textContent ?? '').length > 0, null, { timeout: 15000 });

    // Plain wording + expected rows on the Servers tab.
    const bodyText = (await page.evaluate(() => document.body.innerText)) as string;
    for (const want of ['need a fix', 'Dead MCP', 'Key MCP', 'OAuth MCP', 'Who acts']) {
      if (!bodyText.includes(want)) failures.push(`missing expected text: ${want}`);
    }
    for (const e of ENUMS) {
      if (bodyText.includes(e)) failures.push(`internal enum leaks onto the page: ${e}`);
    }
    // Wrong-tool node on the Nodes tab.
    await page.click('[data-tab="nodes"]');
    const nodesText = (await page.evaluate(() => document.getElementById('view')?.innerText ?? '')) as string;
    if (!nodesText.includes('missing_tool') || !nodesText.includes('does not exist')) failures.push('wrong-tool node missing on nodes tab');
    // Escaping: the evil connector name must be inert text, never an element.
    const imgs = await page.evaluate(() => document.querySelectorAll('#view img, table img').length);
    if (imgs !== 0) failures.push(`evil connector name created ${imgs} <img> element(s)`);
    // jwts: not in storage, not in the URL.
    const stored = (await page.evaluate(() => JSON.stringify([Object.values({ ...localStorage }), Object.values({ ...sessionStorage })]))) as string;
    for (const jwt of [JWT_ADMIN, JWT_DEFAULT]) {
      if (stored.includes(jwt)) failures.push('jwt found in web storage');
      if (page.url().includes(jwt)) failures.push('jwt found in the URL');
    }
    // Downloads contain no jwt; CSV neutralises the formula-shaped evil cell.
    await page.click('[data-tab="servers"]');
    for (const [btn, ext] of [['#dl-csv', '.csv'], ['#dl-json', '.json']] as const) {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click(btn)]);
      const path = join(dlDir, `mcp${ext}`);
      await dl.saveAs(path);
      const text = readFileSync(path, 'utf8');
      for (const jwt of [JWT_ADMIN, JWT_DEFAULT]) if (text.includes(jwt)) failures.push(`jwt found in download ${ext}`);
      if (ext === '.csv') {
        if (!text.includes(EVIL)) failures.push('CSV missing the evil connector row');
        if (!text.split('\n').some((l) => l.startsWith(`'=cmd|calc,`))) failures.push('CSV does not neutralise the formula-shaped cell');
      }
    }
    const hits = scanForSecrets([dlDir], [JWT_ADMIN, JWT_DEFAULT]);
    if (hits.length) failures.push(`leak-scan hits: ${hits.join('; ')}`);
  } finally {
    await browser.close();
    server.close();
    rmSync(dlDir, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`mcp-ui-e2e FAILURES:\n- ${failures.join('\n- ')}`);
    return 1;
  }
  console.log('mcp-ui-e2e: all checks passed');
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
