import { writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { CheckResult, Identity, MenuResult, RunConfig, Verdict } from '../types';
import { VERDICT_ORDER } from '../verdict/compare';
import { describeIdentity } from '../sessions/validate';
import { routeMatches } from '../util/route';

export interface RunMeta {
  runId: string;
  startedAt: string;
  finishedAt: string;
  ampVersion?: string;
  rulebookFile: string;
  identities: Identity[];
  menus: MenuResult[];
  calibrationUserType: string | null;
  calibrationShots: Record<string, string | null>;
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
      const rows = extra.map((l) => `<tr><td><code>#${esc(l.link)}</code></td><td>${esc(l.name)}</td></tr>`).join('');
      return `<details><summary>${esc(label(m.userType))}: ${extra.length} of ${m.links.length} menu links are not in the rulebook</summary><table><thead><tr><th>Route</th><th>Menu label</th></tr></thead><tbody>${rows}</tbody></table></details>`;
    })
    .filter(Boolean);
  if (sections.length === 0) return '';
  return `<h2>Menu items not covered by the rulebook</h2><p class="meta">These are in the user's menu on this environment but have no rulebook row, so they were not tested. Add rows for them to cover this client's menu.</p>${sections.join('')}`;
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

  const summaryRows = userTypes
    .map((ut) => {
      const c = counts(ut);
      return `<tr><th>${esc(label(ut))}</th>${VERDICT_ORDER.map((v) => `<td class="${(c.get(v) ?? 0) > 0 && v.startsWith('FAIL') ? 'hot' : ''}">${c.get(v) ?? 0}</td>`).join('')}</tr>`;
    })
    .join('');

  const identityRows = meta.identities
    .map((id) => {
      const menu = meta.menus.find((m) => m.userType === id.userType);
      const role = id.userType === meta.calibrationUserType ? ' <em>(reference)</em>' : '';
      return `<tr><th>${esc(label(id.userType))}${role}</th><td>${esc(describeIdentity(id))}</td><td>${menu ? (menu.ok ? `${menu.links.length} links` : esc(menu.reason)) : '-'}</td></tr>`;
    })
    .join('');

  const matrixRows = ruleIds
    .map((id) => {
      const first = results.find((r) => r.ruleId === id)!;
      const cells = userTypes
        .map((ut) => {
          const r = byKey.get(`${id}|${ut}`);
          if (!r) return '<td></td>';
          const tip = `${r.reason}${r.state ? ` | state: ${r.state}` : ''} | expected: ${r.expected ?? '-'} | menu: ${r.inMenu ? 'yes' : 'no'}`;
          const link = r.verdict !== 'PASS' ? `<a href="#i-${esc(id)}-${esc(ut)}">` : '<span>';
          const menuHint = `<div class="route">${r.inMenu ? 'in menu' : 'not in menu'}</div>`;
          return `<td title="${esc(tip)}" data-v="${r.verdict}">${link}${badge(r.verdict)}${r.verdict !== 'PASS' ? '</a>' : '</span>'}${menuHint}</td>`;
        })
        .join('');
      return `<tr data-row><th>${esc(first.label)}<div class="route">${esc(first.route ? '#' + first.route : '')}</div></th>${cells}</tr>`;
    })
    .join('');

  const issues = results
    .filter((r) => r.verdict !== 'PASS')
    .sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict))
    .map((r) => {
      const ev = r.evidence;
      const calShot = rel(meta.calibrationShots[r.route]);
      const userShot = rel(ev?.screenshot);
      const details: string[] = [];
      if (ev) {
        details.push(`<li>Final URL: <code>${esc(ev.finalUrl)}</code></li>`);
        if (ev.fragmentStatus !== null) details.push(`<li>Page request: HTTP ${ev.fragmentStatus}${ev.fragmentRedirect ? ` â†’ <code>${esc(ev.fragmentRedirect)}</code>` : ''}</li>`);
        if (r.fingerprintScore !== null) details.push(`<li>Fingerprint match: ${Math.round(r.fingerprintScore * 100)}%</li>`);
        const denied = ev.apiCalls.filter((a) => a.denied);
        if (denied.length) details.push(`<li>Denied API calls: ${denied.map((a) => `<code>${esc(a.func)}</code>`).join(', ')}</li>`);
        if (ev.blockedRequests.length) details.push(`<li>Blocked by safety gate: ${ev.blockedRequests.slice(0, 5).map((b) => `<code>${esc(b)}</code>`).join(', ')}</li>`);
        if (ev.pageErrors.length) details.push(`<li>Page errors: ${ev.pageErrors.slice(0, 3).map((e) => `<code>${esc(e)}</code>`).join(', ')}</li>`);
        if (ev.error) details.push(`<li>Probe error: <code>${esc(ev.error)}</code></li>`);
      }
      const key = `${r.ruleId}|${r.userType}`;
      const shots =
        calShot || userShot
          ? `<div class="shots">${calShot ? `<figure><a href="${esc(calShot)}" target="_blank"><img loading="lazy" src="${esc(calShot)}"></a><figcaption>${esc(label(meta.calibrationUserType ?? ''))} (reference)</figcaption></figure>` : ''}${userShot ? `<figure><a href="${esc(userShot)}" target="_blank"><img loading="lazy" src="${esc(userShot)}"></a><figcaption>${esc(label(r.userType))}</figcaption></figure>` : ''}</div>`
          : '';
      return `<section class="issue" id="i-${esc(r.ruleId)}-${esc(r.userType)}" data-v="${r.verdict}">
  <header>${badge(r.verdict)} <strong>${esc(r.label)}</strong> <span class="route">${esc(r.route ? '#' + r.route : '(group)')}</span> â€” ${esc(label(r.userType))}</header>
  <p>${esc(r.reason)}</p>
  <p class="facts">Expected: <b>${esc(r.expected ?? 'not specified')}</b> Â· In menu: <b>${r.inMenu ? 'yes' : 'no'}</b>${r.state ? ` Â· Page state: <b>${esc(r.state)}</b>` : ''}</p>
  ${details.length ? `<ul>${details.join('')}</ul>` : ''}
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
<title>AMP Permission Report</title>
<style>
:root{--bg:#f7f7f8;--fg:#1b1c1f;--muted:#6b6f76;--card:#fff;--line:#e3e4e8;--pass:#1f7a4d;--pass-bg:#e3f4ea;--fail:#b42318;--fail-bg:#fde8e6;--warn:#9a5b00;--warn-bg:#fdf1dc;--info:#3b4a9c;--info-bg:#e7eafb;--mute-bg:#eceef1}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15161a;--fg:#e8e9ec;--muted:#9aa0a8;--card:#1d1f24;--line:#2d3038;--pass:#6fd39c;--pass-bg:#173526;--fail:#ff8a80;--fail-bg:#3d1c1a;--warn:#f5c26b;--warn-bg:#3a2d12;--info:#aab6ff;--info-bg:#232a4d;--mute-bg:#2a2d34}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1280px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 10px}
.meta{color:var(--muted)}table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line)}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}thead th{position:sticky;top:0;background:var(--card);z-index:1}
td.hot{color:var(--fail);font-weight:600}.child{padding-left:24px}.route{color:var(--muted);font:12px ui-monospace,Consolas,monospace}.kind{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.scroll{overflow-x:auto}.b{display:inline-block;border-radius:4px;padding:1px 6px;font-size:12px;font-weight:600;white-space:nowrap}
.b-PASS{background:var(--pass-bg);color:var(--pass)}.b-FAIL_SECURITY_GAP,.b-FAIL_EXTRA_ACCESS,.b-FAIL_MISSING_ACCESS,.b-FAIL_OPENS_EMPTY{background:var(--fail-bg);color:var(--fail)}
.b-REVIEW{background:var(--warn-bg);color:var(--warn)}.b-NOT_SPECIFIED{background:var(--info-bg);color:var(--info)}
a{color:inherit}.filters{margin:8px 0;display:flex;gap:8px;flex-wrap:wrap}.filters button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:4px 10px;cursor:pointer}.filters button.on{border-color:var(--fg)}
.issue{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:12px 0}.issue header{font-size:15px}.issue p{margin:6px 0}.facts{color:var(--muted)}
code{font:12px ui-monospace,Consolas,monospace;background:var(--mute-bg);padding:0 4px;border-radius:3px;word-break:break-all}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:8px}figure{margin:0}figure img{width:100%;border:1px solid var(--line);border-radius:4px}figcaption{color:var(--muted);font-size:12px}
.review{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}.review .note{flex:1;min-width:200px;padding:4px 8px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg)}
.warn{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:8px 14px;margin:16px 0}.btn{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:6px 12px;cursor:pointer}
</style></head><body><main>
<h1>AMP Permission Report â€” ${esc(cfg.environment.name)}</h1>
<div class="meta">${esc(cfg.environment.baseUrl)} Â· run ${esc(meta.runId)} Â· ${esc(meta.startedAt)} â†’ ${esc(meta.finishedAt)}${meta.ampVersion ? ` Â· AMP build ${esc(meta.ampVersion)}` : ''} Â· rulebook ${esc(meta.rulebookFile)} Â· fingerprint threshold ${Math.round(cfg.fingerprintThreshold * 100)}%</div>
${warnings}
<h2>Test users</h2>
<table><thead><tr><th>User type</th><th>Logged-in identity</th><th>Menu</th></tr></thead><tbody>${identityRows}</tbody></table>
${renderUncovered(meta, results, label)}
<h2>Summary</h2>
<div class="scroll"><table><thead><tr><th>User type</th>${VERDICT_ORDER.map((v) => `<th>${badge(v)}</th>`).join('')}</tr></thead><tbody>${summaryRows}</tbody></table></div>
<h2>Matrix</h2>
<div class="filters" id="f"><button class="on" data-f="all">All</button><button data-f="fail">Failures only</button><button data-f="attn">Needs attention</button></div>
<div class="scroll"><table id="m"><thead><tr><th>Page</th>${userTypes.map((ut) => `<th>${esc(label(ut))}</th>`).join('')}</tr></thead><tbody>${matrixRows}</tbody></table></div>
<h2>Issues (${results.filter((r) => r.verdict !== 'PASS').length})</h2>
<p class="meta">Mark each issue after checking the screenshots. Reviews are saved in this browser; use the button to export them.</p>
<button class="btn" id="dl">Download review CSV</button>
${issues || '<p>No issues.</p>'}
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
    document.querySelectorAll('#m tr[data-row]').forEach(function(tr){
      if (f === 'all') { tr.style.display = ''; return; }
      var re = f === 'fail' ? fail : attn; var hit = false;
      tr.querySelectorAll('td[data-v]').forEach(function(td){ if (re.test(td.getAttribute('data-v'))) hit = true; });
      tr.style.display = hit ? '' : 'none';
    });
  });
})();
</script>
</body></html>`;
}
