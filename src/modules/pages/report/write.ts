import { writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Identity } from '../../../core/types';
import type { CheckResult, MenuResult, RunConfig, Verdict } from '../types';
import { VERDICT_ORDER } from '../verdict/compare';
import { describeIdentity } from '../../../core/sessions/validate';
import { routeMatches } from '../../../core/util/route';

export interface RunMeta {
  runId: string;
  startedAt: string;
  finishedAt: string;
  ampVersion?: string;
  rulebookFile: string;
  identities: Identity[];
  menus: MenuResult[];
  /** Per page: the user whose view was the reference (saw the most of it) and their screenshot. */
  referenceShots: Record<string, { user: string; shot: string | null }>;
  warnings: string[];
}

const LABEL: Record<Verdict, string> = {
  PASS: 'Pass',
  FAIL_SECURITY_GAP: 'Security gap',
  FAIL_EXTRA_ACCESS: 'Extra access',
  FAIL_MISSING_ACCESS: 'Missing access',
  FAIL_OPENS_EMPTY: 'Opens empty',
  REVIEW: 'Review',
  NOT_SPECIFIED: 'Not specified',
};

export function writeReports(outDir: string, cfg: RunConfig, meta: RunMeta, results: CheckResult[]): string {
  const rel = (p: string | null | undefined) => (p ? relative(outDir, p).split(sep).join('/') : null);

  writeFileSync(
    join(outDir, 'results.json'),
    JSON.stringify(
      {
        meta: { ...meta, environment: cfg.environment, userTypes: cfg.userTypes, fingerprintThreshold: cfg.fingerprintThreshold },
        results: results.map((r) => ({ ...r, evidence: r.evidence && { ...r.evidence, screenshot: rel(r.evidence.screenshot) } })),
      },
      null,
      2,
    ),
  );

  const csvCols = ['label', 'parent', 'route', 'type', 'userType', 'expected', 'inMenu', 'state', 'fingerprintScore', 'verdict', 'reason', 'finalUrl', 'screenshot'];
  const csv = [
    csvCols.join(','),
    ...results.map((r) =>
      [r.label, r.parent, r.route, r.type, r.userType, r.expected ?? '', r.inMenu, r.state ?? '', r.fingerprintScore ?? '', r.verdict, r.reason, r.evidence?.finalUrl ?? '', rel(r.evidence?.screenshot) ?? '']
        .map(csvCell)
        .join(','),
    ),
  ].join('\n');
  writeFileSync(join(outDir, 'results.csv'), csv);

  const htmlFile = join(outDir, 'report.html');
  writeFileSync(htmlFile, renderHtml(cfg, meta, results, rel));
  return htmlFile;
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Menu links the rulebook doesn't cover, per user. Clients often have custom menus, so this is
 * the list a tester needs to extend the rulebook for that client.
 */
function renderUncovered(meta: RunMeta, results: CheckResult[], label: (ut: string) => string): string {
  const routes = [...new Set(results.filter((r) => r.type === 'page').map((r) => r.route))];
  const sections = meta.menus
    .filter((m) => m.ok)
    .map((m) => {
      const extra = m.links.filter((l) => /^[a-z0-9][a-z0-9/_\-.]*$/.test(l.link) && !routes.some((r) => routeMatches(l.link, r)));
      if (extra.length === 0) return '';
      const rows = extra.map((l) => `<div class="urow"><code>#${esc(l.link)}</code><span>${esc(l.name)}</span></div>`).join('');
      return `<details class="grp"><summary><b>${esc(label(m.userType))}</b><span class="dim">${extra.length} of ${m.links.length} menu links are not in the rulebook</span><span class="tag warn">${extra.length} to add</span></summary><div class="gb">${rows}</div></details>`;
    })
    .filter(Boolean);
  if (sections.length === 0) return '';
  return `<h2>Menu items not covered</h2><p class="meta">These are in the user's menu on this environment but have no rulebook row, so they were not tested. Add rows for them to cover this client's menu.</p><div class="stack">${sections.join('')}</div>`;
}

function menuText(r: CheckResult): string {
  return r.inMenu ? 'yes' : 'no';
}

/** What the user actually got, in plain words (the verdict alone says only whether it matched the rulebook). */
function gotText(r: CheckResult): string {
  const ev = r.evidence;
  switch (r.state) {
    case 'OPENED':
      return /sections without permission|one section says/.test(r.reason) ? 'page opened (some sections locked)' : 'page opened';
    case 'OPENED_EMPTY':
      return 'page opened, data denied';
    case 'BLOCKED':
      return ev?.noAccessMarker || /noaccess/.test(ev?.fragmentRedirect ?? ev?.finalUrl ?? '') ? 'no access page' : ev?.denialText ? 'no-permission message' : 'blocked (data denied)';
    case 'BLANK':
      return ev?.stillLoading ? 'still loading' : 'blank page';
    case 'ERROR':
      return 'error page';
    case 'NOT_FOUND':
      return 'page not found (404)';
    case 'BAD_TOKEN':
      return 'logged out';
    default:
      return 'not tested';
  }
}

function badge(v: Verdict): string {
  return `<span class="b b-${v}">${esc(LABEL[v])}</span>`;
}

function renderHtml(cfg: RunConfig, meta: RunMeta, results: CheckResult[], rel: (p: string | null | undefined) => string | null): string {
  const userTypes = [...new Set(results.map((r) => r.userType))];
  const ruleIds = [...new Set(results.map((r) => r.ruleId))];
  const byKey = new Map(results.map((r) => [`${r.ruleId}|${r.userType}`, r]));
  const label = (ut: string) => cfg.userTypes[ut]?.label ?? ut;

  const counts = (ut: string) => {
    const c = new Map<Verdict, number>();
    for (const r of results) if (r.userType === ut) c.set(r.verdict, (c.get(r.verdict) ?? 0) + 1);
    return c;
  };

  const totals = { pass: 0, fail: 0, review: 0, other: 0 };
  for (const r of results) {
    if (r.verdict === 'PASS') totals.pass++;
    else if (r.verdict === 'REVIEW') totals.review++;
    else if (r.verdict.startsWith('FAIL')) totals.fail++;
    else totals.other++;
  }
  const issueCount = results.filter((r) => r.verdict !== 'PASS').length;
  const okAll = totals.fail === 0 && totals.review === 0;

  const summaryCards = userTypes
    .map((ut) => {
      const c = counts(ut);
      const fails = VERDICT_ORDER.filter((v) => v.startsWith('FAIL')).reduce((n, v) => n + (c.get(v) ?? 0), 0);
      const revs = c.get('REVIEW' as Verdict) ?? 0;
      const passes = c.get('PASS' as Verdict) ?? 0;
      const tone = fails > 0 ? 'mint' : revs > 0 ? 'mint' : 'mint';
      return `<div class="stat ${tone}">
        <div class="stop"><span class="avatar">${esc(label(ut).charAt(0).toUpperCase())}</span>
        <span class="num">${fails + revs === 0 ? '?' : fails}<small>${fails + revs === 0 ? 'CLEAN' : 'NEED ATTENTION'}</small></span></div>
        <h3>${esc(label(ut))}</h3>
        <p><b>${passes}</b> passed · <b>${fails}</b> failed · <b>${revs}</b> review</p>
      </div>`;
    })
    .join('');

  const identityCards = meta.identities
    .map((id) => {
      const menu = meta.menus.find((m) => m.userType === id.userType);
      return `<div class="ucard"><span class="avatar sm">${esc(label(id.userType).charAt(0).toUpperCase())}</span>
        <div><b>${esc(label(id.userType))}</b><div class="dim">${esc(describeIdentity(id))}</div>
        <div class="dim">${menu ? (menu.ok ? `${menu.links.length} menu links` : esc(menu.reason)) : '-'}</div></div></div>`;
    })
    .join('');

  // Matrix as compact cards (no giant table): one card per page, pills per user.
  const matrixCards = ruleIds
    .map((id) => {
      const first = results.find((r) => r.ruleId === id)!;
      const pills = userTypes
        .map((ut) => {
          const r = byKey.get(`${id}|${ut}`);
          if (!r) return `<span class="pill dim">—</span>`;
          const tip = `${r.reason} | state: ${r.state ?? '-'} | expected: ${r.expected ?? '-'} | menu: ${menuText(r)}`;
          const inner = r.verdict !== 'PASS'
            ? `<a href="#i-${esc(id)}-${esc(ut)}" title="${esc(tip)}">${badge(r.verdict)}</a>`
            : `<span title="${esc(tip)}">${badge(r.verdict)}</span>`;
          return `<span class="cell" data-v="${r.verdict}">${inner}<span class="got">exp <b>${esc(r.expected ?? '–')}</b> · ${esc(gotText(r))}</span></span>`;
        })
        .join('');
      return `<div class="mcard" data-row><div class="mhead"><b>${esc(first.label)}</b><code>${esc(first.route ? '#' + first.route : '')}</code></div><div class="mcells">${pills}</div></div>`;
    })
    .join('');

  const issues = results
    .filter((r) => r.verdict !== 'PASS')
    .sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict))
    .map((r) => {
      const ev = r.evidence;
      const refInfo = meta.referenceShots[r.route];
      const calShot = refInfo && refInfo.user !== r.userType ? rel(refInfo.shot) : null;
      const userShot = rel(ev?.screenshot);
      const details: string[] = [];
      if (ev) {
        details.push(`<li>Final URL: <code>${esc(ev.finalUrl)}</code></li>`);
        if (ev.fragmentStatus !== null) details.push(`<li>Page request: HTTP ${ev.fragmentStatus}${ev.fragmentRedirect ? ` ? <code>${esc(ev.fragmentRedirect)}</code>` : ''}</li>`);
        if (r.fingerprintScore !== null) details.push(`<li>Fingerprint match: ${Math.round(r.fingerprintScore * 100)}%</li>`);
        const denied = ev.apiCalls.filter((a) => a.denied);
        if (denied.length) details.push(`<li>Denied API calls: ${denied.map((a) => `<code>${esc(a.func)}</code>`).join(', ')}</li>`);
        if (ev.blockedRequests.length) details.push(`<li>Blocked by safety gate: ${ev.blockedRequests.slice(0, 5).map((b) => `<code>${esc(b)}</code>`).join(', ')}</li>`);
        if (ev.pageErrors.length) details.push(`<li>Page errors: ${ev.pageErrors.slice(0, 3).map((e) => `<code>${esc(e)}</code>`).join(', ')}</li>`);
        if (ev.error) details.push(`<li>Probe error: <code>${esc(ev.error)}</code></li>`);
        if (ev.stillLoading) details.push(`<li>Still loading when the time limit was reached: <code>${esc(ev.waitLog?.at(-1) ?? '')}</code></li>`);
        if (ev.debugDir) details.push(`<li>Step-by-step screenshots and decision: <code>${esc(ev.debugDir)}</code></li>`);
      }
      const key = `${r.ruleId}|${r.userType}`;
      const shots =
        calShot || userShot
          ? `<div class="shots">${calShot ? `<figure><a href="${esc(calShot)}" target="_blank"><img loading="lazy" src="${esc(calShot)}"></a><figcaption>${esc(label(refInfo?.user ?? ''))} — reference (saw the most)</figcaption></figure>` : ''}${userShot ? `<figure><a href="${esc(userShot)}" target="_blank"><img loading="lazy" src="${esc(userShot)}"></a><figcaption>${esc(label(r.userType))}</figcaption></figure>` : ''}</div>`
          : '';
      return `<section class="issue" id="i-${esc(r.ruleId)}-${esc(r.userType)}" data-v="${r.verdict}">
  <header>${badge(r.verdict)} <strong>${esc(r.label)}</strong> <code>${esc(r.route ? '#' + r.route : '(group)')}</code> <span class="dim">— ${esc(label(r.userType))}</span></header>
  <p>${esc(r.reason)}</p>
  <p class="facts">Expected: <b>${esc(r.expected ?? 'not specified')}</b> · In menu: <b>${esc(menuText(r))}</b>${r.state ? ` · Page state: <b>${esc(r.state)}</b>` : ''}</p>
  ${details.length ? `<details class="tech"><summary>Technical evidence (${details.length})</summary><ul>${details.join('')}</ul></details>` : ''}
  ${shots}
  <div class="review" data-key="${esc(key)}">
    <label><input type="radio" name="rv-${esc(key)}" value="confirmed"> Confirmed issue</label>
    <label><input type="radio" name="rv-${esc(key)}" value="false-alarm"> False alarm</label>
    <input type="text" placeholder="Tester note" class="note">
  </div>
</section>`;
    })
    .join('\n');

  const warnings = meta.warnings.length ? `<div class="warn"><b>Warnings</b><ul>${meta.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AMP Permission Report — ${esc(cfg.environment.name)}</title>
<style>
/* Manrope — self-hosted (Google's CSS is blocked by this app's CSP, so the font is served from
   the same origin, which default-src 'self' already allows). */
@font-face{font-family:'Manrope';src:url('/assets/manrope-latin.woff2') format('woff2');font-weight:200 800;font-style:normal;font-display:swap}
:root{--font:'Manrope','Segoe UI',system-ui,-apple-system,sans-serif;--paper:#F6F6F7;--ink:#0B0B0C;--muted:#5C6470;--card:#fff;--line:#E6E7EA;--line-strong:#D3D5DA;--code:#F2F3F5;
--accent:#0B0B0C;--accent-hov:#000000;--accent-fg:#fff;--accent-soft:#FDF0EA;--accent-line:#FAD9C8;--accent-ink:#C2410C;--accent-2:#F2501B;
--fail:#B42318;--fail-bg:#FDECEA;--warn:#9A5B00;--warn-bg:#FDF3E2;--ok:#0F7A44;--ok-bg:#E4F4EA;--info:#3b4a9c;--info-bg:#DDE3FF;
--shadow:0 1px 2px rgba(11,11,12,.06);--shadow-hover:0 1px 2px rgba(11,11,12,.06),0 10px 24px rgba(11,11,12,.10);
--ease:cubic-bezier(.2,.7,.2,1);--dur:140ms;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#0B0C0E;--ink:#F7F7F8;--muted:#A3AAB5;--card:#131417;--line:#25272B;--line-strong:#34363B;--code:#191B1E;
--accent:#FFFFFF;--accent-hov:#E6E6E7;--accent-fg:#0B0B0C;--accent-soft:#241409;--accent-line:#4A2A17;--accent-ink:#FF8A50;--accent-2:#FF7A45;
--fail:#FF9B92;--fail-bg:#3D1C1A;--warn:#F2C46B;--warn-bg:#3A2D12;--ok:#6FD39C;--ok-bg:#173526;--info:#AAB6FF;--info-bg:#232A4D;
--shadow:0 1px 2px rgba(0,0,0,.5);--shadow-hover:0 1px 2px rgba(0,0,0,.5),0 10px 28px rgba(0,0,0,.4);color-scheme:dark}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.6 var(--font);-webkit-font-smoothing:antialiased;letter-spacing:-.005em}
main{max-width:1080px;margin:0 auto;padding:20px 18px 64px}
:focus-visible{outline:2px solid var(--accent-2);outline-offset:2px;border-radius:6px}
::selection{background:var(--ink);color:var(--card)}
a{color:inherit}
code,.urow code,.mhead code,.issue code,.tech code{font:12px ui-monospace,Consolas,monospace;background:var(--code);border:1px solid var(--line);padding:0 5px;border-radius:5px;word-break:break-all}
/* strip + header: dark one-liner, logo left, section links right */
.strip{background:var(--ink);color:var(--paper);text-align:center;font-size:12.5px;font-weight:500;padding:8px 16px}
.strip .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent-2);margin-right:8px;vertical-align:1px}
.topbar{position:sticky;top:12px;z-index:10;display:flex;align-items:center;gap:10px;background:color-mix(in srgb,var(--card) 94%,transparent);backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:10px;padding:8px 10px 8px 14px;box-shadow:var(--shadow);margin-bottom:20px}
.topbar .logo{font-weight:700;font-size:15px;letter-spacing:-.015em;display:flex;align-items:center;gap:9px}
.topbar .logo i{width:26px;height:26px;border-radius:6px;background:var(--ink);color:var(--accent-2);display:grid;place-items:center;font-style:normal;font-size:13px}
.topbar nav{display:flex;gap:2px;margin-left:auto;background:var(--code);border-radius:6px;padding:3px}
.topbar nav a{font-size:13px;font-weight:600;padding:7px 13px;border-radius:4px;text-decoration:none;color:var(--muted);transition:background var(--dur) var(--ease),color var(--dur) var(--ease)}
.topbar nav a:hover{background:var(--card);color:var(--ink)}
/* hero */
.eyebrow{display:inline-block;font:700 11px/1 var(--font);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);background:var(--code);border:1px solid var(--line);padding:6px 12px;border-radius:6px}
h1{font-family:"Manrope","Segoe UI",system-ui,sans-serif;font-weight:700;font-size:clamp(26px,3.4vw,36px);line-height:1.12;letter-spacing:-.03em;margin:14px 0 4px}
h1 em{font-style:normal;color:var(--accent-2)}
.lead{color:var(--muted);font-size:15px;margin:0}
.meta{color:var(--muted);font-size:12.5px;margin-top:10px}
h2{font-weight:700;font-size:19px;letter-spacing:-.02em;margin:34px 0 10px}
/* overview */
.hero-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 6px}
.hstat{border:1px solid var(--line);border-radius:10px;padding:14px;text-align:center;box-shadow:var(--shadow);transition:transform var(--dur) var(--ease),box-shadow var(--dur) var(--ease)}
.hstat:hover{transform:translateY(-2px);box-shadow:var(--shadow-hover)}
.hstat .v{font:700 30px/1 var(--font);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.hstat .l{font:700 11px/1 var(--font);letter-spacing:.1em;text-transform:uppercase;margin-top:6px}
.hstat.fail{background:var(--fail-bg);color:var(--fail)}.hstat.rev{background:var(--warn-bg);color:var(--warn)}.hstat.pass{background:var(--ok-bg);color:var(--ok)}.hstat.total{background:var(--ink);color:var(--paper)}
/* user cards — uniform */
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin:12px 0}
.stat{border:1px solid var(--line);border-radius:14px;padding:16px;background:var(--card);box-shadow:var(--shadow);transition:transform var(--dur) var(--ease),box-shadow var(--dur) var(--ease)}
.stat:hover{transform:translateY(-2px);box-shadow:var(--shadow-hover)}
.stat .stop{display:flex;justify-content:space-between;align-items:flex-start}
.avatar{width:40px;height:40px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font:700 15px/1 var(--font);border:1px solid var(--accent-line)}
.avatar.sm{width:34px;height:34px;font-size:13px}
.stat .num{font:700 28px/1 var(--font);font-variant-numeric:tabular-nums;letter-spacing:-.02em;text-align:right}
.stat .num small{display:block;font:700 10px/1 var(--font);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-top:6px}
.stat h3{font:700 15px/1.3 var(--font);letter-spacing:-.015em;margin:12px 0 4px}
.stat p{margin:0;font-size:13px;color:var(--muted)}
.stat p b{color:var(--ink)}
.users{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.ucard{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line);border-radius:10px;background:var(--card);padding:12px 14px;box-shadow:var(--shadow)}
.ucard .dim{color:var(--muted);font-size:12.5px}
/* filters */
.filters{position:sticky;top:68px;z-index:5;display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:color-mix(in srgb,var(--paper) 92%,transparent);backdrop-filter:blur(8px);padding:8px 0}
.filters button{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:6px;padding:7px 14px;cursor:pointer;font-weight:600;font-size:13px;box-shadow:var(--shadow);transition:all var(--dur) var(--ease)}
.filters button:hover{border-color:var(--fg);transform:translateY(-1px)}
.filters button.on{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.btn{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:6px;padding:9px 15px;cursor:pointer;font-weight:600;box-shadow:var(--shadow);transition:all var(--dur) var(--ease)}
.btn:hover{border-color:var(--ink);transform:translateY(-1px);box-shadow:var(--shadow-hover)}
.btn.dark{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.btn.dark:hover{background:var(--accent-hov);border-color:var(--accent-hov)}
/* matrix cards — compact, no giant table */
.matrix{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:12px}
.mcard{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;box-shadow:var(--shadow);content-visibility:auto;contain-intrinsic-size:140px;transition:transform var(--dur) var(--ease),box-shadow var(--dur) var(--ease)}
.mcard:hover{transform:translateY(-2px);box-shadow:var(--shadow-hover)}
.mhead b{display:block;font-size:14px;letter-spacing:-.015em}
.mhead code{color:var(--muted)}
.mcells{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.cell{display:inline-flex;flex-direction:column;gap:3px;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:6px 9px}
.cell .got{font-size:11px;color:var(--muted)}
.b{display:inline-block;border-radius:5px;padding:2px 8px;font-size:11.5px;font-weight:700;white-space:nowrap}
.b-PASS{background:var(--ok-bg);color:var(--ok)}.b-FAIL_SECURITY_GAP,.b-FAIL_EXTRA_ACCESS,.b-FAIL_MISSING_ACCESS,.b-FAIL_OPENS_EMPTY{background:var(--fail-bg);color:var(--fail)}
.b-REVIEW{background:var(--warn-bg);color:var(--warn)}.b-NOT_SPECIFIED{background:var(--info-bg);color:var(--info)}
/* issues */
.issue{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0;box-shadow:var(--shadow);content-visibility:auto;contain-intrinsic-size:300px;scroll-margin-top:120px}
.issue header{font-size:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.issue p{margin:8px 0}.facts{color:var(--muted);font-size:13px}
.tech{margin:8px 0;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:8px 12px}
.tech summary{cursor:pointer;font-weight:600;font-size:13px}
.tech ul{margin:8px 0 4px;padding-left:18px;color:var(--muted);font-size:12.5px}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:10px}figure{margin:0}figure img{width:100%;border:1px solid var(--line);border-radius:8px}figcaption{color:var(--muted);font-size:12px;margin-top:4px}
.review{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px dashed var(--line-strong)}
.review label{font-size:13px;font-weight:600;display:flex;gap:6px;align-items:center;cursor:pointer}
.review .note{flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink)}
.review .note:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent-2) 18%,transparent)}
/* uncovered */
.grp{border:1px solid var(--line);border-radius:10px;margin-bottom:10px;overflow:hidden;background:var(--card);box-shadow:var(--shadow)}
.grp>summary{list-style:none;cursor:pointer;display:flex;gap:10px;align-items:center;padding:11px 14px;background:var(--code);font-size:13.5px}
.grp>summary::-webkit-details-marker{display:none}
.grp .gb{padding:6px 14px 12px}
.urow{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid var(--line);font-size:13px}
.urow:first-child{border-top:0}
.tag{font-size:11px;font-weight:800;padding:3px 10px;border-radius:5px;white-space:nowrap}
.tag.warn{background:var(--warn-bg);color:var(--warn)}
.dim{color:var(--muted)}
.stack{display:grid;gap:10px}
.warn{background:var(--warn-bg);color:var(--warn);border:1px solid var(--line);border-radius:10px;padding:10px 16px;margin:16px 0;box-shadow:var(--shadow)}
.foot{text-align:center;color:var(--muted);font-size:12px;margin-top:40px;padding-top:18px;border-top:1px solid var(--line)}
.foot b{color:var(--ink)}
@media(max-width:720px){.hero-stats{grid-template-columns:repeat(2,1fr)}.topbar nav{display:none}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.hstat,.stat,.mcard{transition:none}}
</style></head><body><main>
<div class="topbar"><span class="logo"><i>?</i> qa studio</span><nav><a href="#overview">Overview</a><a href="#matrix">Matrix</a><a href="#issues">Issues (${issueCount})</a></nav></div>
<span class="eyebrow">AMP · PERMISSION TESTING</span>
<h1>Permission report — <em>${esc(cfg.environment.name)}</em></h1>
<p class="lead">Every page, every user type, with the evidence needed to confirm each verdict.</p>
<div class="meta">${esc(cfg.environment.baseUrl)} · run ${esc(meta.runId)} · ${esc(meta.startedAt)} ? ${esc(meta.finishedAt)}${meta.ampVersion ? ` · AMP build ${esc(meta.ampVersion)}` : ''} · rulebook ${esc(meta.rulebookFile)} · threshold ${Math.round(cfg.fingerprintThreshold * 100)}%</div>
${warnings}
<section id="overview">
<h2>Overview</h2>
<div class="hero-stats">
<div class="hstat total"><div class="v">${results.length}</div><div class="l">checks</div></div>
<div class="hstat pass"><div class="v">${totals.pass}</div><div class="l">passed</div></div>
<div class="hstat fail"><div class="v">${totals.fail}</div><div class="l">failed</div></div>
<div class="hstat rev"><div class="v">${totals.review}</div><div class="l">review</div></div>
</div>
<h2>By user type</h2>
<div class="stats">${summaryCards}</div>
<h2>Test users</h2>
<div class="users">${identityCards}</div>
${renderUncovered(meta, results, label)}
</section>
<section id="matrix">
<h2>Matrix</h2>
<p class="meta" style="margin:0 0 10px"><b>Pass</b> means the user got what the rulebook expects, not that the page opened: a page the rulebook says <b>No</b> to that shows AMP's "No Access" page is a Pass. Each card shows what was expected and what the user actually got.</p>
<div class="filters" id="f"><button class="on" data-f="all">All</button><button data-f="fail">Failures only</button><button data-f="attn">Needs attention</button><span class="dim">${ruleIds.length} pages · ${userTypes.length} user types</span></div>
<div class="matrix" id="m">${matrixCards}</div>
</section>
<section id="issues">
<h2>Issues (${issueCount})</h2>
<p class="meta">Mark each issue after checking the screenshots. Reviews are saved in this browser; use the button to export them. ${okAll ? 'No failures — everything matches the rulebook.' : ''}</p>
<button class="btn dark" id="dl">Download review CSV</button>
${issues || '<p>No issues.</p>'}
</section>
<div class="foot"><b>qa studio</b> · ${esc(cfg.environment.name)} · ${esc(meta.runId)}</div>
</main>
<script>
(function(){
  var runId = ${JSON.stringify(meta.runId)};
  var store = {};
  try { store = JSON.parse(localStorage.getItem('amp-review-' + runId) || '{}'); } catch (e) {}
  function save(){ try { localStorage.setItem('amp-review-' + runId, JSON.stringify(store)); } catch (e) {} }
  document.querySelectorAll('.review').forEach(function(el){
    var k = el.getAttribute('data-key'); var s = store[k] || {};
    el.querySelectorAll('input[type=radio]').forEach(function(r){ if (r.value === s.status) r.checked = true;
      r.addEventListener('change', function(){ store[k] = Object.assign({}, store[k], { status: r.value }); save(); }); });
    var n = el.querySelector('.note'); n.value = s.note || '';
    n.addEventListener('input', function(){ store[k] = Object.assign({}, store[k], { note: n.value }); save(); });
  });
  document.getElementById('dl').addEventListener('click', function(){
    var rows = [['page_id','user_type','verdict','review','note']];
    document.querySelectorAll('.issue').forEach(function(sec){
      var k = sec.querySelector('.review').getAttribute('data-key').split('|'); var s = store[k.join('|')] || {};
      rows.push([k[0], k[1], sec.getAttribute('data-v'), s.status || '', s.note || '']);
    });
    var csv = rows.map(function(r){ return r.map(function(v){ v = String(v); return /[",\\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v; }).join(','); }).join('\\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'review-' + runId + '.csv'; a.click();
  });
  var fail = /^FAIL/, attn = /^(FAIL|REVIEW)/;
  document.getElementById('f').addEventListener('click', function(e){
    var f = e.target.getAttribute && e.target.getAttribute('data-f'); if (!f) return;
    document.querySelectorAll('#f button').forEach(function(b){ b.classList.toggle('on', b === e.target); });
    document.querySelectorAll('#m [data-row]').forEach(function(card){
      if (f === 'all') { card.style.display = ''; return; }
      var re = f === 'fail' ? fail : attn; var hit = false;
      card.querySelectorAll('[data-v]').forEach(function(p){ if (re.test(p.getAttribute('data-v'))) hit = true; });
      card.style.display = hit ? '' : 'none';
    });
  });
})();
</script>
</body></html>`;
}
