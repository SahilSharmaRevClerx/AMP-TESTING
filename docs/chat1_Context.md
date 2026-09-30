# Context handoff — AMP Permission Testing Platform (chat 1)

Paste this into a new chat to continue the work. Written 2026-09-30, **updated 2026-10-01** (parallel users, scroll-based welcome page, AMP role/persona findings, speed decisions). Everything below reflects the code at that time.

---

## 1. What we are working on

**Problem.** AMP (MindMatrix's PRM/marketing platform) is heavily role-based: every page should be reachable only by the right user types. QA testers used to check this by hand, logging in as each user type and clicking through every page against a spreadsheet ("rulebook"). That is slow, error-prone, and misses cases like "hidden from the menu but still opens by URL".

**What we built.** A **standalone permission-testing platform**, outside the AMP codebase. A tester:
1. enters a client environment URL,
2. uploads that client's rulebook (Excel/CSV: page + Yes/No per user type),
3. pastes a **jwt** for each user type to test,
4. runs it.

The tool opens every rulebook page **as each user** in a real headless browser, decides whether that user got a usable page, compares with the rulebook, and produces a report with screenshots and a tester review (Confirm / False alarm).

**Scope v1:** page-level access only. API data-leak testing is a planned v2 and not built.

**Design principles agreed with the user:**
- **Deterministic, no LLM.** Code decides every verdict. An LLM was considered for rulebook column detection and page judgement and was rejected: less reliable, sends client data outside, costs money.
- **Read-only and safe.** The browser only navigates. Write API calls, logout, AI calls and third-party POSTs are blocked. Production is refused unless explicitly allowed.
- **Everything is entered in the UI per run.** Each client has a different URL and different user types, so nothing is hardcoded and there are no config files for testers.
- **No special role.** Site Admin is a MindMatrix-internal role; clients have Super Admin / users / channel managers / partners. User types come only from the rulebook's columns.
- **When unsure → "Review" with screenshots**, never a guessed Pass.

---

## 2. Repositories on this machine

| Repo | Local path | Remote | Branch (at handoff) | Role |
|---|---|---|---|---|
| **Permission testing tool** (what we build) | `D:\Ampcode\AMP-PERMISSION-TESTING-REPO` | `https://github.com/SahilSharmaRevClerx/AMP-TESTING.git` | `feature/testing-phase2` (clean) | The platform itself. Node/TypeScript |
| **AMP** (the product under test) | `D:\Ampcode\AMP` | `https://github.com/MindMatrix/AMP.git` | `ai-ontology-from-context-rewamp` | **Read-only reference.** We read its code to learn how auth, menus, page gating and APIs work. Nothing in AMP was changed for this project |

Note: there is an unrelated `D:\AMPProjects` repo on this machine, which is not part of this work. An older AMP branch `feature/permission-testing` exists (a merge of llmwrapper-dde-sb + dynamic-derivation-engine); it is **unrelated** to this tool despite the name.

Recent commits in the tool repo:
```
3ed0318 parallel users (commit message is the before/after diagram)
0fc5a99 improved : improved mechanism of how model sees that page is accesible or not to user
b16086d IMPROVED : rule book and jwt safely handling
25a3254 - stable with jwt only  - new frontend update
bdba8f8 Initial commit: AMP permission testing tool
```
Uncommitted at update time: `src/server/ui.html` (scroll-based welcome page, see 4.1) and this doc.

### Dependencies between the two
- **No code dependency.** The tool does not import AMP code, share a build, or need AMP running locally.
- **Runtime dependency:** the tool talks over HTTPS to a **deployed** AMP environment (e.g. `https://itbydesign.sb.amp.vg`, `https://ai.sb.amp.vg`), or to a local AMP at `http://localhost` (plain HTTP is allowed only for localhost).
- **Behavioural dependency:** the tool relies on these AMP behaviours, all verified in AMP source. If AMP changes them, the tool needs updating:

| AMP behaviour | AMP source | Used by (tool) |
|---|---|---|
| Session = cookie `jwt`; the jwt maps to a server-side session checked for `Revoked`/`ExpiresOn` on every request; **logout revokes it** | `Libraries/MindMatrix.Libraries.Infrastructure/Services/Auth/Authentication.cs` (Verify ~l.506, Logout ~l.688) | whole tool; "log out when done" advice |
| CSRF = double-submit: header `X-CSRF-Token` must equal cookie `X-CSRF-Token`; value **not tied to the session**; AMP issues a random GUID cookie if missing | `Libraries/MindMatrix.Libraries.Bridge/Pipeline/APIRequest.cs` ~l.906, `BeginRequest.cs` ~l.233 | tool generates its own CSRF value → **tester gives jwt only** |
| `getpermissiondataforuser` returns userName, personna, isSiteAdmin, organizationName/userCompanyName, version | `Libraries/MindMatrix.Libraries.Bridge/LegacyAPI/user/GetPermissionDataForUser.cs` | token check ("Who is it?") |
| Main page embeds the user's menu as `var navigation = [...]` (items have `link`, `name`, `key`); companies can have custom menu layouts (`ModuleSetups`) | `Libraries/MindMatrix.Libraries.Pages/navin/default.cshtml` ~l.454, `default.navigation.cs` | menu read (information only) |
| Hash routes (`#setup/roles`) are loaded as server pages via `web-navin-routing.xml`; gated pages extend `ModuleAwareRazorModel` → `module.HasAccess(user)` → **302 to `/noaccess`** | `Libraries/MindMatrix.Libraries.Infrastructure/Routing/web-navin-routing.xml`, `Libraries/MindMatrix.Libraries.Pages/ModuleAwareRazorModel.cs`, `Libraries/MindMatrix.Libraries.Entities/Module.cs` | blocked detection |
| No-access page has element `.error-text-2` | `Libraries/MindMatrix.Libraries.Pages/navin/public/noaccess.cshtml` | blocked detection |
| Deployed pages call data APIs as `POST /api/<FuncName>` (older: `/services/api.ashx?func=`); response `{status, result}`; denial = HTTP 401 / `"Not authorized."` / `{code, message}` | `APIRequest.cs`, `ashx/services/api.ashx.cs` | safety gate (read-only allowlist), "opens empty" detection |
| API pipeline only checks authentication/MFA/CSRF; **permission checks are per handler** (hence the v2 API-leak idea) | `APIRequest.cs` | v2 plan |
| Site Admin sees all modules only when MFA is enabled | `Entities/Module.cs` `HasAccess`, `Entities/User.cs` | background knowledge |
| Effective permissions = **max-merge of roles** linked to the user, the **company** (applies to everyone), the user's **user groups**, their **organization** and **org groups**; no deny rules | `Libraries/MindMatrix.Libraries.Entities/Roles/Role.cs` `GetRolesAppliedToUser` (~l.126), `AccessibilityManager.cs` `UpdateMaxRole` (~l.1493) | background for §9 (not used in code yet) |
| `IsSiteOrSuperAdmin` → Owner on every feature, so a client **Super Admin sees all modules** (except company-disabled modules and persona-restricted custom modules) | `AccessibilityManager.cs` (~l.1430) | background for §9 |
| Personas (Channel Manager, Partner…) mainly choose the dashboard; roles can be tagged with a persona; a few custom menu modules are persona-restricted; users may switch persona if `SwitchRolePersonaEnabled` | `Entities/User.cs` `GetPersona`, `Role.cs` `GetAssociatedRolesForCompany`, `Module.cs` (~l.2771) | background for §9 |
| AMP rate-limits APIs and emails `ratelimit@amp.vg` on bursts | `APIRequest.cs` | tool opens one page at a time per user with a delay; users run in parallel (separate sessions, so separate rate-limit keys) |

---

## 3. Tech stack of the tool and why

| Choice | Why |
|---|---|
| **Node.js 22+ (machine has v24.21.0) + TypeScript**, run with `tsx` (no build step) | Playwright is native to Node; one language for server, CLI and tests |
| **Playwright 1.63 (headless Chromium)** | A real browser runs AMP's JavaScript exactly like a user, so we judge what the user actually sees, not just HTTP status |
| **exceljs** | Read `.xlsx` rulebooks (CSV via a small built-in parser) |
| **node:http** server + a single-file vanilla-JS page (`src/server/ui.html`) | No framework, no build, easy to audit; runs on the tester's own machine |
| **vitest** | Unit tests |
| Fake AMP server (`tests/e2e/fake-amp.ts`) | End-to-end tests that mimic real AMP behaviours without a live environment |

Install once: `npm install` then `npx playwright install chromium`.

---

## 4. What we built — part by part (current state)

### 4.1 Tester web UI (`npm start` → http://127.0.0.1:4545)
Files: `src/server/index.ts` (server), `src/server/ui.html` (page).
- **Welcome page (redesigned 2026-10-01, uncommitted at update time):** three **full-screen, centred scenes** with scroll-snap (`html.snap`, mandatory on desktop, proximity on phones), content fading/sliding in via `IntersectionObserver` (`.reveal` → `.in`, staggered with `--d`), clickable animated mouse "scroll" cues, dot navigation on the right (hidden on phones), soft drifting background glows (welcome only), light/dark, `prefers-reduced-motion` respected:
  1. Scene 1: floating logo, "Welcome to the **Permission Testing Platform**" (gradient), one-line explanation, "Scroll to see how it works".
  2. Scene 2: "How it works — Five steps, a few minutes", 5 numbered cards (Environment → Rulebook → Users & tokens → Run → Report) appearing one by one with arrows (vertical on phones).
  3. Scene 3: "Ready to test permissions?", gradient **Start new test** (`#btn-start`) + **View past runs** (`#btn-welcome-history`), trust badges.
  Snap turns off when leaving the welcome page (`show()` toggles `html.snap`, `body.welcome-on`, `main.welcome`). Gotcha fixed: `.reveal.in { transform:none }` overrides any transform on the same element, so centring/rotation must not rely on `transform` there (scroll cue uses `margin:auto; width:max-content`; mobile arrows rotate the inner `svg`).
- **Wizard with stepper**, one step at a time, Back/Next, each step validates:
  1. **Environment:** name + base URL (recent URLs remembered, never tokens); production needs an explicit approval tick.
  2. **Rulebook:** pick from `rulebook/` or upload/drag-drop `.xlsx`/`.csv`. Shows detected user-type columns as **tick boxes** (tester can untick) and how every other column was understood; notes skipped title rows.
  3. **Users & tokens:** one row per ticked user type, **named exactly as the Excel header**; **jwt only** (masked text field, not a password field); row auto-ticks when a jwt is pasted; `jwt=…;` pastes are cleaned; **Check tokens** (Next also checks) shows "✓ Logged in as <name> · persona · company"; **Clear jwts** button. Row names are labels only: the tool does not enforce that a jwt matches the role (the user wants it that way).
  4. **Run:** plan tiles (site, users, pages, est. time), Advanced options (first N pages, delay ms, match threshold %, **users tested at the same time** (default 3), show browser), live progress (phase chips, bar, expandable live log), Cancel.
  5. **Results:** Failed / Review / Passed tiles, per-user-type table, **Open full report**, **Test again** (keeps env + rulebook), reminder to **log out** of the AMP windows the jwts came from.
- **Past runs** screen.
- One run at a time; closing the page doesn't stop a run; reconnects on refresh.
- **After any code change the tester must restart the server** (`Ctrl+C`, `npm start`) and hard-refresh (`Ctrl+Shift+R`).

### 4.2 Rulebook reader (`src/rulebook/parse.ts`)
- Format: a **page column** (`page` / `page url` / `url` / `route` / `link` / `path`; accepts `/#setup/roles`, `#setup/roles`, `setup/roles` or a full URL; only the part after `#` is kept) + **one Yes/No column per user type** (any names).
- **Header row** = first of the top 10 rows containing a page column; title rows above are skipped.
- **Column classification by values, not names:** page / name (`name`, `page name`, `title`, `main menu`, `sub menu`) / known info (`notes`, `comments`, `description`, `icon`, `info tip`, `module`, `type`, `parent`) / otherwise a **user type if ≥80% of filled cells are Yes/No** (Y/N, true/false, 1/0) with at least one filled. Empty or text columns are ignored, with the reason shown. A user-type column with an odd value (e.g. `Yse`) errors with the exact row and column.
- Header text is kept as the display label (`userTypeLabels`). Empty cell = "Not specified" (never guessed). Rows without a page, `mailto:`/`javascript:` links, duplicates, and `type=external/group` rows are skipped.
- Files: `template.csv`, `itbd-demo.csv` (ITBD intel pages, incl. two No/No/No rows), `internal-user-personas.csv` (older persona sheet transcribed from the user's PDF, standard PRM menu), `rulebook/README.md`.

### 4.3 Run engine (`src/run.ts`, `executeRun`, shared by UI and CLI)
1. **Token check** per user (`src/sessions/validate.ts`) → identity; an invalid token stops the run.
2. **Menu read** per user (`src/probe/menu.ts`), used as information only.
3. **Open every page as each user** (`src/probe/browser.ts`), with a fresh Chromium per user. **Users run in parallel** (added 2026-10-01): `parallelUsers` (default 3, 1–5, always 1 on production) via `runLimited()` in `src/util/limit.ts`; each user has its own browser + session, pages within a user stay one at a time; log lines are prefixed `[user]`; progress counts all users; results are collected in rulebook order so they never depend on finish order; one user's browser failing doesn't stop the others. Measured on the fake AMP: 2 users × 14 pages, 36.8 s → 18.6 s. Per user:
   - cookies `jwt` (**HttpOnly**, SameSite Lax, only this host) + a tool-generated `X-CSRF-Token`;
   - first loads AMP's main page, then a **frame-only snapshot** (opens nonexistent route `#__permission_test_frame_only__`, so only the AMP frame renders);
   - for each page: sets `location.hash`, waits for network idle, then **waits until the page stops changing** (element/text signature stable, max 8 s);
   - collects: final URL, page request status/redirect, `.error-text-2`, visible **denial text** ("you do not have permission", "access denied", "not authorized"…), visible **error text** ("something went wrong", "an error occurred", "internal server error"…), element ids + headings (same-origin iframes included), each API call (func, status, denied, **hasData**), blocked requests, JS errors, screenshot.
   **How the browser moves through pages (per user):** one Chromium, **one tab, kept open** for all that user's pages — it does not open/close per page. It loads the AMP main page once, then for each rulebook page changes `location.hash` (exactly like clicking a menu item in AMP's single-page app), waits, records, pauses `delayMs`, moves on. A fresh evidence collector per page keeps pages isolated; if a page leaves the main page (full redirect to `/noaccess` or `/login`) the main page is reloaded first; a redirect to login stops that user (remaining pages → Review). The browser is closed after the user's last page (jwt gone with it). Each user gets a brand-new browser.
4. **Decide each page** (`src/verdict/state.ts`, `fingerprint.ts`, `compare.ts`), see 4.4.
5. **Report** (`src/report/write.ts`).

### 4.4 How a page is judged (the core; redesigned several times, current version)
**Question: "did this user get a usable page?"** (not "does it look like another user's view"; dashboards legitimately differ per user).

- **AMP frame** = elements/APIs from each user's frame-only snapshot, plus anything on ≥50% of clean page views (when ≥4 views). Ignored when judging content.
- **Page state** per user:
  - `BLOCKED`: `.error-text-2`, redirect to `/noaccess`, visible denial text, or nothing shown and the page's data calls were denied
  - `BAD_TOKEN`: ended at `/login` or `/sessionexpired`
  - `NOT_FOUND`: 404 / `/notfound`
  - `ERROR`: 5xx / `/error`, error text with <3 page elements, or JS crash with nothing rendered
  - `OPENED`: page content beyond the frame (**≥2 page-specific elements, or ≥1 plus a data call that returned data**)
  - `OPENED_EMPTY`: content, but its own data calls were denied
  - `BLANK`: only the frame rendered
- **Verdict** (rulebook × state, cross-checked with other users on the same page):

| Rulebook | Usable (OPENED/OPENED_EMPTY) | Not usable (BLOCKED/BLANK/ERROR/NOT_FOUND) |
|---|---|---|
| Yes | PASS (FAIL_OPENS_EMPTY if data denied) | FAIL_MISSING_ACCESS; but BLANK/ERROR/NOT_FOUND with **no other user getting the page** → REVIEW ("broken page or wrong route?") |
| No | FAIL_EXTRA_ACCESS (in menu) / **FAIL_SECURITY_GAP** (hidden from menu, opens by URL) | PASS |

  Plus NOT_SPECIFIED (empty cell) and REVIEW (bad token / not tested).
- "No No No" rows need no reference: nobody usable → all pass.
- **Reference view** (`pickReference`): the tested user **expected Yes** who got the most page content. **Informational only** ("% of X's view" in reasons, reference screenshot in the report) plus spotting data calls answered differently. Never the pass/fail gate.
- The menu never decides pass/fail; it only upgrades extra access → security gap.
- History of this design: v1 used a Site Admin "calibration" run and fingerprint matching → replaced because Site Admin is internal-only → then "per-page richest view" matching → replaced because dashboards differ per user and No-No-No rows have no reference → current "usable content" model.

### 4.5 Report (`output/<env>-<timestamp>/`)
`report.html` (summary, matrix with "in menu / not in menu" hints, issues with the reference user's screenshot next to the tested user's, Confirm/False-alarm review saved in the browser with CSV export, "Menu items not covered by the rulebook" section), `results.json`, `results.csv`, `summary.json` (Past runs), `audit.jsonl` (every request allowed/blocked, tokens masked), `rulebook-<name>` copy, `shots/<user>/<page>.png`. Served by the UI at `/output/...`.

### 4.6 Safety and jwt protection
- **Request gates** (`src/safety/gate.ts`):
  - Tool requests: configured host only, GET pages, POST only `getpermissiondataforuser`, throttled.
  - Browser requests: GET allowed; `/api/<Func>` and `api.ashx` allowed only for read-only names (`get|load|check|has|is|can|search|find|fetch|list|count|view|lookup|preview|verify` prefixes, excluding hidden writes like `getoradd…`, `…andsave…`); every other non-GET (incl. `/bridge/ask/ai`, WalkMe tracking) and any logout blocked + logged.
- Production refused unless approved; remote URLs must be HTTPS.
- **jwt handling:**
  - in memory only; dropped after the token check / run (`forgetSecrets`);
  - masked (`eyJhb…x9Q`) in every log, audit entry, error and report;
  - never written to disk or browser storage;
  - HttpOnly cookie in the test browser (third-party page scripts can't read it);
  - fresh browser profile per user.
- **Server:**
  - listens on `127.0.0.1:4545` only;
  - token APIs require an `X-Amp-Ui: 1` header + same origin;
  - **Host-header check** (DNS-rebinding guard);
  - `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, CSP limited to self.
- **Tests prove it:** leak scan of all output files and the server's terminal output for raw jwts; a fake third-party script tries to read the jwt cookie; a foreign Host header gets 403; no password inputs; browser storage checked.
- Tester guidance (README "Keeping jwts safe"): log out when done (revokes the jwt), use test users on QA/staging, don't paste jwts into chat, clear clipboard history.

### 4.7 Developer logging (`src/util/logger.ts`)
Format `HH:MM:SS.mmm LEVEL [tag] message key=value`, coloured on a TTY, tokens always masked.
- `npm start` shows info level: startup, API requests, rulebook loads, token checks, menus, run start/finish, failures with reasons, per-user totals, warnings, errors with stack.
- `npm run start:debug` adds debug level: per-page evidence, every tool request, every blocked browser request, AMP JS errors, frame/reference details.
- Tags: `[server] [http] [run] [gate] [browser] [run-log]`. `LOG_LEVEL`, `NO_COLOR` env supported. CLI defaults to warn unless `--debug`.

### 4.8 CLI (optional, automation)
`npm run check | menu | run -- [--config run.config.json] [--only a,b] [--limit n] [--dry-run] [--headed] [--debug]`. Reads `run.config.json` (copy from `run.config.example.json`) and tokens from `AMP_JWT_<TYPE>` env or `.env.local` (`AMP_CSRF_<TYPE>` optional). Only tests rulebook columns listed in config `userTypes`. Exit codes: 0 pass, 2 failures, 1 error, 130 cancelled.

### 4.9 Tests
- `npm test`: **91 unit tests** (rulebook parsing and column detection, routes/menu, gate, logger, masking, verdict/state/frame/reference, `tests/parallel.test.ts`: `runLimited` limit/order/errors, `parallelUsers` clamp + production = 1, parallel-aware time estimate). The `.xlsx` hyperlink test has a 20 s timeout (first exceljs load can take >5 s on a cold start).
- `npm run e2e`: full CLI pipeline against the fake AMP with two users (site_admin, partner_sales). Scenarios: redirect, security gap, blocked-but-in-menu, inline no-access, custom "no permission" message, data denied, per-user dashboard, blank with No, blank with Yes (other user has it), error box, No No No, broken for everyone, write-API blocking, leak scan, and **parallel proof** (the two users' page loads must overlap in time; fake AMP records request timestamps). `PARALLEL=1 npm run e2e` runs users one after another (then only the overlap check fails, by design).
- `npm run e2e:ui`: drives the wizard in a real browser (Start → env incl. rejected bad URL → upload rulebook with title row + ignored "Owner" + unticked "Reviewed" column → tokens → run → results; Test again with one user; Test again with the other; Past runs; paste cleaning; Clear jwts; security headers; Host guard; storage and leak checks). `fillUser` re-types and verifies each jwt box (one flaky run seen when rows redrew mid-typing — a test timing issue, not a tool bug). Passing repeatedly after the welcome redesign.
- `npm run typecheck`. All passing at handoff.

### 4.10 Docs in the repo
- `README.md`: setup, usage, judging rules, jwt safety, logs, CLI.
- `docs/PRD.md`: original spec, with an update note at the top.
- `docs/how-it-works.html`: offline visual guide. **Partly outdated:** its state/verdict tables still describe the older fingerprint/UNCLEAR model and it doesn't mention parallel users; the README is current.
- `rulebook/README.md`: rulebook format and detection rules.
- this file.

---

## 5. Real-environment results so far
- **ai.sb.amp.vg** (company Pinnacle LLC, Site Admin "Chris Dsouza"): token check and menu read work (94 menu links, `shellPath "/"` correct); pages open. Found that deployed pages use `/api/<Func>` (gate fixed) and that this client's **custom AI-heavy menu** doesn't match the persona rulebook, so each client needs its own rulebook.
- **itbydesign.sb.amp.vg (ITBD)**: **jwt-only works** (confirmed by the user). Tested `itbd-demo.csv` intel pages.
- **Not yet proven on a live site:** a real **blocked** page (only opens seen so far); the frame-only snapshot staying on the main page (check the debug log line `frame baseline kept=true`); pages with little/no ids/headings.

---

## 6. Speed

Time grows with pages × users. Each page open ≈ 3–5 s (load, network idle, wait-until-stable up to 8 s, screenshot, `delayMs` 500 ms).

| | One user after another | 3 users in parallel (default) |
|---|---|---|
| 100 pages × 3 users | ~20–25 min | ~7–8 min |

Measured on the fake AMP: 2 users × 14 pages → 36.8 s sequential vs 18.6 s parallel.

**Parallel pages per user (several tabs per user)** was discussed with the user (pros: 3–5× faster per user; cons: more load on the client's AMP, AMP rate limiting → false "blocked"/"opens empty", slower pages → false blanks, same session in many tabs, heavier on the tester's PC, harder debugging, moderate build effort). The user chose **parallel users only** ("done this only for now"). **Do not build parallel tabs unless asked.** If ever built: 2–3 tabs per user, total cap, adaptive back-off, rate-limit detection + retry, re-check uncertain pages alone, production = 1.

---

## 7. Open items / next steps
1. **Validation run on ITBD** with a high-access user (e.g. Super Admin) and a normal User, on pages the User must not see (incl. the No/No/No intel rows). Compare against manual results.
2. **Risk: content measured by ids/headings.** Proposed fix (not built): also count **visible text beyond the frame** (e.g. >~200 chars) as usable content.
3. **Risk: short smoke runs (<4 pages)** rely fully on the frame snapshot; verify `frame baseline kept=true` on real AMP.
4. Update `docs/how-it-works.html` to the current judging model.
5. Optional: auto-logout of tested users after a run (AMP logout endpoint not yet identified).
6. Optional: "save uploaded rulebook to saved list" checkbox.
7. **v2:** API data-leak testing with a developer-reviewed read-only API allowlist; hidden-field checks; cross-org/tenant checks; regression diff between runs; CI.
8. Role/persona-aware enhancements from §9 (user said they'll look into it later).
9. Commit the welcome-page redesign (`src/server/ui.html`) and this doc update.

---

## 8. How to run (quick)
```powershell
cd D:\Ampcode\AMP-PERMISSION-TESTING-REPO
npm start                 # or: npm run start:debug
# browser: http://127.0.0.1:4545 → Start new test → URL → rulebook → paste jwt(s) → Run → Open report
npm test; npm run e2e; npm run e2e:ui; npm run typecheck
```
Getting a jwt: log in to the client site in an incognito window as that user → F12 → Application → Cookies → copy the `jwt` value. Log out afterwards.

---

## 9. AMP roles, groups and personas — findings and proposed (NOT built) enhancements

**What a rulebook column is.** In the user's persona sheet ("Internal User Personas"), Channel Manager / Corporate PRM Admin / Partner Sales are **personas**, not user groups. A persona is a label on the user (chooses the dashboard); **roles** are what grant access. So a column means "a user of that persona, set up the normal way (with the roles that persona usually gets)". Pick test users accordingly; the "Who is it?" line shows the persona.

**Why one user per column can mislead.** A user's access = max of roles from user + company + user groups + organization + org groups. Two users with the same persona can differ if they are in different groups/orgs. A **company-level role** grants to everyone — the most common source of "extra access". A **Super Admin** gets everything, so a "Super Admin: No" rulebook row will always fail (rulebook issue, not an AMP bug). A page blocked for everyone including Super Admin usually means the module is disabled for that company.

**Proposed enhancements (user will decide later; none built):**
1. Show why a user has access: per jwt also read (read-only) roles applied, groups, org, org groups, persona/persona option, Super/Site Admin — shown on "Who is it?" and in the report. Needs checking which self-service read API works for non-admins (`GetRolesAppliedToMe` is a candidate but lives under `admin/`); add it to the gate allowlist.
2. More than one test user per column (e.g. Partner in Org A + Partner in Org B), judged against the same Yes/No.
3. A recommended "baseline" user with no groups/org roles (reveals company-wide grants).
4. Smarter hints: Super Admin expected No but opens → "Super Admin has all modules; check the rulebook"; blocked for everyone incl. Super Admin → "module likely disabled for this company"; dashboard row resolved per persona.
5. Optional persona-mismatch **warning** (not a block) when a jwt's persona doesn't match its column.
6. A test-user matrix template (user type × org × group × persona + baseline).
7. Later: generate expected results from AMP's own role/module configuration for a three-way compare (rulebook vs AMP config vs reality).

---

## 10. Working preferences observed (for the next assistant)
- User: Sahil Sharma (AMP developer). Wants practical, visual, tester-friendly results; asks for honest "is this reliable?" answers.
- Explain before large redesigns, then build. Prove changes with tests (unit + fake-AMP e2e + browser UI e2e) and screenshots (UI changes: check desktop light/dark and a 390 px phone).
- Build **only what the user picks** from a list of options (e.g. parallel users yes, parallel tabs no; role enhancements "later").
- Remind the user to **restart the server** after code changes.
- In the AMP repo: never build with msbuild directly (use `dotnet nuke compile` / IIS Express). This project doesn't modify AMP.
