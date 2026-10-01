# AMP Permission Testing

A standalone tool that checks, for every user type, which AMP pages **actually open**, compares that with an expected-access rulebook, and produces a report with screenshot evidence for tester review.

A tester enters the client's site, uploads the client's rulebook (page + Yes/No per user type) and pastes a **jwt** per user type. The tool opens every page **as each user** in a real (headless) browser, decides whether that user got a usable page, and flags every mismatch.

- Handoff / full context for developers: [docs/chat1_Context.md](docs/chat1_Context.md)
- How it works (flow, files, diagrams; open in a browser): [docs/how-it-works.html](docs/how-it-works.html). Its judging tables are partly outdated; this README is current.
- Original spec: [docs/PRD.md](docs/PRD.md)
- Rulebook format: [rulebook/README.md](rulebook/README.md)

**Status:** v1 (page-level access) with a tester web UI. Used on real environments (`ai.sb.amp.vg`, `itbydesign.sb.amp.vg`, jwt-only confirmed). Verified end to end against a simulated AMP. API data-leak testing is a planned v2.

No LLM and no third-party services: every verdict is decided by code, and nothing leaves the tester's machine except requests to the AMP environment being tested.

## Setup (once per machine)

Requires Node 22+.

```powershell
npm install
npx playwright install chromium
```

## Using it (testers)

```powershell
npm start              # or: npm run start:debug  (detailed logs)
```

This opens `http://127.0.0.1:4545`. After any code update, restart (`Ctrl+C`, `npm start`) and hard-refresh the page (`Ctrl+Shift+R`).

**Home (Testing catalog):** the first screen lists the testing modules as cards (icon, Available / Coming soon, category, description, tags, **Launch**), with a search box and a grid/list toggle (remembered in the browser). **AMP Pages Testing** (this tool) shows its last run and **Launch** opens the welcome page; a "More testing modules" placeholder marks where new modules go (add one entry to `MODULES` in `src/server/ui.html`). The logo, the results page's **Home** button and **All testing modules** on the welcome page lead back here.

**Welcome page (AMP Pages Testing):** three full-screen scenes you scroll through: a welcome, a "How it works" flow (Environment → Rulebook → Users & tokens → Run → Report), then **Start new test** / **View past runs**.

**The wizard** takes one step at a time; each **Next** checks its step:

1. **Environment:** name and base URL of the client's AMP (e.g. `https://itbydesign.sb.amp.vg`). Recent URLs are remembered, never tokens. Production needs an explicit approval tick.
2. **Rulebook:** pick one from `rulebook/` or upload/drag-drop an `.xlsx`/`.csv`. The detected **user-type columns are shown as tick boxes** (untick any that isn't a user type), along with how every other column was understood.
3. **Users & tokens:** one row per user type, named exactly as in your sheet. Paste only the **`jwt` cookie** for the users you want to test (the row ticks itself). **Check tokens** (or Next) shows *"✓ Logged in as <name> · persona · company"*. **Clear jwts** empties everything. Row names are labels; the tool shows who each jwt really belongs to, so make sure it matches.
4. **Run:** plan preview (site, users, pages, estimated time). **Advanced options:** only first N pages (smoke test), delay between pages, match threshold, **users tested at the same time** (default 3), show the browser window. Then live progress with a cancel button.
5. **Results:** failed / review / passed totals per user type, **Open full report**, **Test again** (keeps site and rulebook), and a reminder to log out.

**Past runs** lists every earlier report.

**Getting a jwt:** open an incognito window per user, log in to the client site as that user, press **F12 → Application → Cookies**, and copy the value of `jwt`. **Log out when done.**

## Rulebook

One column with the page, and one Yes/No column per user type. Any user-type names work, since each client has its own:

| page | Site Admin | Channel Manager | Partner User |
|---|---|---|---|
| /#setup/roles | Yes | No | No |
| https://client.amp.vg/#connections/contacts | Yes | Yes | Yes |

- The page column can be `page`, `page url`, `url`, `route`, `link` or `path`. Only the part after `#` is used; the site comes from step 1.
- **User types are detected by their values:** a column whose filled cells are Yes/No (Y/N, true/false, 1/0) is a user type. Empty columns and text columns (e.g. "Owner") are ignored; `name`/`notes`/`icon`/`description` columns are recognised by name. A typo such as `Yse` stops the upload and names the exact row and column.
- Title rows above the header are skipped automatically. Empty cells are reported as "Not specified", never guessed.
- Examples: `rulebook/template.csv`, `rulebook/itbd-demo.csv`. Full rules: [rulebook/README.md](rulebook/README.md).

**Column names are usually personas, not user groups.** In AMP, a persona (Channel Manager, Partner…) is mainly a label that picks the dashboard; **roles** grant access, and a user's access is the combination of roles from their user record, the company, their user groups, their organization and their org groups. So use a test user set up the normal way for that persona. A client **Super Admin** gets every module in AMP, so a "Super Admin: No" row will fail by design.

## How it runs

Per user (each in a **fresh, separate browser and session**):

1. Put the user's jwt into the browser as an HttpOnly cookie for the client's host only.
2. Load AMP's main page, then take a "frame only" snapshot (a route that doesn't exist, so only the menu, header and notifications render).
3. For each rulebook page, in the **same tab**: change the `#route` (like clicking a menu item), wait until the page has **finished loading**, record the evidence and a screenshot, pause `delayMs`, then go to the next page. Finished loading means: nothing on screen changed for ~0.8 s, **no AMP request started for this page is still running**, and **no loading spinner** / "Loading..." text is visible outside the menu. Fast pages take ~1–2 s; slow dev servers can take 25 s, so the limit is 30 s per page (`pageTimeoutMs`). A page still loading at the limit is marked **Review**, not guessed.
4. Close the browser.

**User types run in parallel** (default 3 at a time, 1–5, always 1 on production). Pages within a user stay one at a time to keep load on AMP low.

| Rulebook size | One user after another | 3 users in parallel |
|---|---|---|
| 10 pages × 3 users | ~2 min | < 1 min |
| 100 pages × 3 users | ~20–25 min | ~7–8 min |

Start with **Only first N pages = 5** to check the setup, then run everything.

## How a page is judged

The question for each page and user is **"did this user get a usable page?"**, not "does it look like someone else's view?", since dashboards and many pages legitimately differ per user. The rulebook's Yes/No then says how to read a page that isn't usable.

- **Frame:** everything on the frame-only snapshot, plus whatever repeats on most pages, is the AMP frame and is ignored when judging content.
- **Evidence per page:** final URL, page request status/redirect, AMP's no-access screen, visible "no permission" or "something went wrong" messages, elements on screen (same-origin iframes included), which data calls returned data or were denied, JS errors, screenshot.

| Page state | Meaning |
|---|---|
| OPENED | Page content beyond the AMP frame (page-specific elements, or elements plus loaded data). **An empty list counts**: a heading plus the page's own "No Data Found" message, or a data call AMP answered without a denial (just no rows) |
| OPENED_EMPTY | Page content, but its own data calls were denied |
| BLOCKED | AMP no-access screen, redirect to `/noaccess`, an on-screen "no permission / access denied / not authorized" message, or nothing shown and its data calls denied. A "no permission" message inside **one widget** of an otherwise rendered page (≥ 4 other page elements, e.g. a dashboard tile saying "Permission Needed") does not block the page; the reason notes "one section says …" |
| BLANK | Only the AMP frame rendered |
| ERROR | "Something went wrong"-type message with nothing else, script crash with nothing rendered, or HTTP 5xx |
| NOT_FOUND | Route doesn't exist on this build |
| BAD_TOKEN | Sent to login / session expired |

**Verdict** (rulebook × state, with the other tested users as a cross-check):

| Rulebook | Usable (OPENED / OPENED_EMPTY) | Not usable (BLOCKED / BLANK / ERROR / NOT_FOUND) |
|---|---|---|
| **Yes** | Pass (Opens empty if data denied) | **Missing access**, or **Review** when *no* tested user got the page (broken page / wrong route, not a permission result) |
| **No** | **Extra access**, or **Security gap** if hidden from the menu | Pass |

"No No No" rows need no reference: if nobody gets usable content, everyone passes. The user's menu is read too, but only as information: it never decides pass/fail, it only upgrades "extra access" to "security gap". **In menu** means the page itself is a menu link; a page under it (e.g. `#collateral/internal-playbook/marketing/overview` for `#collateral/internal-playbook`) doesn't count. For information, each page also records a **reference view** (the tested user expected to have access who saw the most of it) and how much of it each user saw.

| Verdict | When |
|---|---|
| Pass | Matches the rulebook |
| **Security gap** | Rulebook says No, the page is hidden from the menu, but opens by URL |
| Extra access | Rulebook says No, but the page opens (and is in the menu) |
| Missing access | Rulebook says Yes, but the page is blocked, or blank/error for this user while others get it |
| Opens empty | Rulebook says Yes, the page opens but its data is denied |
| Review | Page didn't render for any tested user, or the session expired |
| Not specified | Rulebook has no Yes/No for this cell |

## Report

Written to `output/<env>-<timestamp>/` and opened from the Results step or **Past runs**:

| File | Content |
|---|---|
| `report.html` | Summary, matrix (with "in menu / not in menu" hints), issues with the reference user's screenshot next to the tested user's, tester review (Confirmed / False alarm) with CSV export, menu items not covered by the rulebook |
| `results.json`, `results.csv` | Every check with its evidence |
| `summary.json` | Used by Past runs |
| `shots/<user type>/*.png` | One screenshot per page per user |
| `audit.jsonl` | Every request made or allowed, and every request blocked (tokens masked) |
| `rulebook-<name>` | Copy of the rulebook used |

### Debug screenshots (`debug/`, git-ignored)

On by default (Advanced options → *Save step-by-step screenshots*; CLI: `"debugShots": false` to turn off). Each run gets a folder named by its local start time and site, then one per user type and one per page:

```
debug/2026-10-01_09-14_main-dvl-amp-vg/      (a 2nd run in the same minute gets _2)
  run.txt                                     run id, report path, per-user totals
  super-admin/
    00-frame-only/                            what the AMP frame looks like with no page
    01-collateral-internal-playbook/
      01-at-0.5s.png  02-at-2.5s.png ...      what the browser showed while loading (every ~2 s)
      final-decided-on-this-3.9s.png          the screen the decision is based on
      decision.txt                            evidence, the wait sample by sample, state, verdict and why
  user/ ...
```

Delete old run folders when you no longer need them. Like `output/`, they contain screenshots of client pages (never jwts).

## Safety

- The tool itself only calls `getpermissiondataforuser` (read-only, to identify the jwt) and GETs AMP's main page.
- In the browser it only navigates; it never clicks or types. Requests the page makes by itself pass a gate: GETs are allowed; `/api/<Func>` and `/services/api.ashx` calls are allowed only for read-only API names (`get*`, `load*`, `check*`…, excluding hidden writes like `getoradd*`). Every other non-GET (including AI calls and third-party tracking) and any logout is blocked and logged.
- Production environments are refused unless explicitly approved. Remote hosts must use HTTPS.
- Pages are opened one at a time per user, with `delayMs` between them (AMP rate-limits and alerts on bursts). Users run in parallel, each in its own session.
- Opening pages still writes AMP's normal usage-tracking rows; use test users on QA/staging.

## Keeping jwts safe

A jwt is a live AMP session: whoever holds it is logged in as that user until it expires or the user logs out.

| Where | Protection |
|---|---|
| Tester page | jwt boxes are masked and not password fields (password managers don't offer to save them); never written to browser storage; wiped on **Clear jwts**, **New test**, or page refresh; pasted `jwt=…;` pairs are cleaned to the bare value |
| Page → tool server | server listens on `127.0.0.1` only; token-carrying APIs require the page's own header and origin; requests with a foreign `Host` header are refused (blocks DNS-rebinding); security headers (`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a Content-Security-Policy that only allows talking to this server) |
| Tool server | jwts live in memory only for the token check / run, then are dropped (including from the masking list); never written to disk; masked (`eyJhb…x9Q`) in every log line, audit entry, error and report |
| To AMP | sent only to the environment's own host, over HTTPS (plain HTTP only for localhost); the CSRF value is generated by the tool (AMP only checks header = cookie) |
| Test browser | fresh in-memory profile per user, deleted after the run; the jwt cookie is **HttpOnly**, so scripts on AMP pages (including third-party ones) cannot read it; scoped to the environment's host only |
| Tests | every test run scans all output files and the server's terminal output for raw jwts, and checks that a page script cannot read the jwt cookie |

**Testers should:**
1. **Log out when done.** AMP revokes the session on logout, so the copied jwt stops working everywhere. This is the most effective protection.
2. Use **test users** on QA/staging, not real admin accounts on production.
3. Not paste jwts into chat, email or tickets, and clear the clipboard (Windows **Win+V** keeps clipboard history).
4. Treat `output/` as internal: reports contain screenshots of client pages (but never jwts).

## Developer logs (terminal)

```
20:56:34.346 INFO  [run] run started run=itbd-2026-… env=ITBD users=super_admin,normal_user pages=3
20:56:54.209 INFO  [run] verdict user=normal_user route=intel/account expected=No state=OPENED inMenu=false verdict=FAIL_SECURITY_GAP why="…"
```

| Start with | Shows |
|---|---|
| `npm start` | `info`: startup, API requests, rulebook loads, token checks, menus, run start/finish, users started/done, failures with reasons, per-user totals, warnings, errors with stack traces |
| `npm run start:debug` | also `debug`: every page's evidence (status, redirect, elements, data loaded, denied/blocked calls, time), every request the tool makes, every blocked browser request, AMP page JavaScript errors, AMP frame and page references, menu links |

You can also set `LOG_LEVEL=debug|info|warn|error`, and `NO_COLOR=1`. Tags: `[server]` UI server, `[http]` API requests, `[run]` run engine, `[run-log]` tester-facing log (debug), `[gate]` tool requests, `[browser]` Playwright. The live run log prefixes lines with the user (`[partner_sales] 3/14 #setup/roles …`) because users run in parallel. Tokens are always masked.

## Command line (optional, for automation)

The CLI reads the environment from `run.config.json` (copy `run.config.example.json`) and jwts from environment variables or `.env.local` (copy `.env.example`; git-ignored). It tests the rulebook columns listed in the config's `userTypes`; other columns are skipped with a warning.

```powershell
$env:AMP_JWT_PARTNER_SALES = "..."   # one per user type; AMP_CSRF_<TYPE> is optional

npm run check                       # who does each token belong to?
npm run menu                        # each user's menu vs the rulebook
npm run run -- --dry-run            # show what would be requested, send nothing
npm run run -- --limit 5            # smoke test on the first 5 pages
npm run run                         # full run
npm run run -- --only partner_sales # one user type
npm run run -- --headed             # watch the browser
npm run run -- --debug              # detailed developer logs
```

Config options include `parallelUsers` (default 3), `delayMs`, `pageTimeoutMs`, `settleMs`, `fingerprintThreshold` and `headless`. Exit code: `0` all pass, `2` failures found, `1` setup/run error, `130` cancelled. Delete `.env.local` after the run.

## Project layout

| Path | Responsibility |
|---|---|
| `src/server/index.ts`, `src/server/ui.html` | Local web server (127.0.0.1:4545) and the tester page (welcome, wizard, past runs) |
| `src/run.ts` | Run engine shared by UI and CLI: tokens → menus → pages per user (parallel users) → decide → report; CLI commands |
| `src/rulebook/parse.ts` | `.xlsx`/`.csv` reader, header-row search, value-based user-type detection |
| `src/probe/browser.ts` | Playwright: cookies, frame snapshot, open each page, wait until stable, collect evidence and screenshots |
| `src/probe/menu.ts` | Reads the user's menu from AMP's main page |
| `src/sessions/validate.ts` | Token check ("Who is it?") |
| `src/verdict/state.ts`, `fingerprint.ts`, `compare.ts` | Page state, AMP frame, reference view, verdict |
| `src/report/write.ts` | `report.html`, `results.json`, `results.csv` |
| `src/safety/gate.ts` | Environment guard, tool request gate, browser request gate |
| `src/util/` | Logger, token masking, audit log, route helpers, `runLimited` (parallel users) |
| `src/config.ts`, `src/cli.ts` | Settings/defaults, credentials, command line |
| `tests/` | Unit tests; `tests/e2e/fake-amp.ts` simulates AMP for the end-to-end tests |

## Development

```powershell
npm test          # 91 unit tests
npm run e2e       # full pipeline against a simulated AMP (tests/e2e/fake-amp.ts), incl. proof that users run in parallel
npm run e2e:ui    # the tester web UI driven in a real browser against the simulated AMP
npm run typecheck
```

`PARALLEL=1 npm run e2e` runs the users one after another (the parallel-overlap check then fails by design).
