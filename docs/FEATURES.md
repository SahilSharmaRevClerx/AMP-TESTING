# AMP Permission Testing Platform — Features

A standalone tool, run on a tester's own machine, that takes a client's **permission rulebook** (which user type may open which AMP page) and:

1. **Sets the permissions in AMP** to match the rulebook (module 1, *Permission Setter*), and
2. **Verifies them** by opening every page as each user in a real browser (module 2, *Pages Testing*),

with screenshot evidence and a report a tester can hand to a developer or a client.

It does not change or depend on the AMP codebase. It talks to a deployed AMP site (QA, staging, dev, or production with explicit approval) the same way a browser does.

---

## 1. The workflow it replaces

| Manual today | With the platform |
|---|---|
| Read the client's rulebook, work out which permission behind each page, open each role, drag sliders, save, then fix Navigation Layout for pages roles can't hide | **Permission Setter:** upload the rulebook, name the role per user type, Preview, Apply |
| Log in as every user type and click through every page, ticking a spreadsheet | **Pages Testing:** opens every page as every user, decides pass/fail, keeps a screenshot of each |
| Hidden-from-menu-but-opens-by-URL gaps are rarely checked | Every page is opened **by URL**, so these show up as **Security gap** |
| Results live in someone's spreadsheet | One HTML report per run, plus JSON/CSV and an audit log |

Typical flow:

**Rulebook → Step 1 Permission Setter (Preview → Apply) → "Verify in Pages Testing →" → Step 2 Pages Testing (Run) → Reports**

---

## 2. Getting started

```powershell
npm install
npx playwright install chromium
npm start            # opens http://127.0.0.1:4545   (npm run start:debug for detailed logs)
```

- **Requirements:** Node 22+ and Windows/macOS/Linux.
- **After pulling code changes:** restart the server (Ctrl+C, then `npm start`) and hard-refresh the page (Ctrl+Shift+R).

**Getting a jwt (the only credential the tool needs):**
1. Log in to the AMP site as the user in an incognito window.
2. Press F12 → Application → Cookies → copy the value of `jwt`.
3. Log out when the run is finished. That revokes the jwt.

**Home screen (Testing catalog):** cards for each module in workflow order: **Step 1 · Permission Setter** and **Step 2 · AMP Pages Testing**. There is a search box, a grid/list toggle, and each card's last result.

---

## 3. The rulebook

The client's sheet, as `.xlsx` or `.csv`:
- one column with the page link (`page` / `url` / `link` / `route` / `path`);
- one **Yes/No column per user type**, named however the client names them (Channel Manager, Partner Sales, …).

**How the tool reads it:**
- **Only the part after `#`** of a link is used (e.g. `/#manage/opportunity-records`); the site comes from the run settings.
- **User-type columns are found by their values:** Yes/No, Y/N, true/false or 1/0. Text columns (owner, notes, icon, info tip) are ignored and listed as such.
- **Title rows above the header are skipped automatically.**
- **Empty cells are "Not specified".** They are never guessed.
- **Typos are caught:** a value like `Yse` stops the upload and names the exact row and column.
- **Rows that aren't tested:**
  - group headings with no link (*Deal Management*, *Email (+)*);
  - external links (*Link to the client's IFT*);
  - `mailto:` / `javascript:` links;
  - duplicate rows.

**Rulebooks included:**

| File | What |
|---|---|
| `rulebook/template.csv` | Empty starting format |
| `rulebook/internal-user-personas.csv` | The "Internal User Personas" sheet (standard PRM menu) |
| `rulebook/revsparks-internal-personas.csv` | The same sheet set up for the Rev Sparks demo company on main.dvl |
| `rulebook/main-dvl.csv`, `main-dvl-ayush-anmol.csv`, `itbd-demo.csv` | Small rulebooks used during development and demos |

Full format rules: [rulebook/README.md](../rulebook/README.md).

---

## 4. Module 1 — Permission Setter (Step 1: set permissions)

Logs in as the company **Super Admin** (jwt only) and makes AMP match the rulebook.

### 4.1 Why it works on roles
AMP has no per-user permission sliders. Sliders live on **roles** (Setup → Roles → role → Permissions). A user gets the **highest** level from every role linked to them: their own, their user groups', their organization's, and company-wide roles. So for each rulebook column the tester names the AMP role that column's user has. That role should belong to that user only.

### 4.2 Steps in the page (`/setter`)
1. **Site:** the AMP address. Recent sites are remembered. A production site needs an explicit approval tick.
2. **Super Admin jwt:** checked against AMP. The tool confirms it really is a Super Admin, by reading AMP's Navigation Layout module list, which only Site/Super Admins can read.
3. **What to change:**
   - *Match a rulebook*, or
   - *Set every slider of one role* to one level (NA / View / Edit / Create / Delete), with no rulebook needed.
4. **Rulebook & roles:** pick or upload the rulebook. Then, per column, give the **AMP role**, and optionally the column's **user email** (used by the Navigation Layout step).
5. **Review & apply:**
   - **Show plan:** what will change, page by page.
   - **Preview in AMP (no save):** opens AMP and moves the sliders on screen without saving.
   - **Apply to AMP:** asks for confirmation, then saves.

### 4.3 Layer 1 — role sliders
- **Page → module:** each rulebook page is mapped to its AMP module, using the company's own module list (Navigation Layout): first by link, then by name.
- **Module → permissions:** each module is mapped to the role-editor controls that open it, following AMP's own rules (`Module.HasModuleAccess`):
  - Marketing Functions sliders (Email, Playbooks, Web, Social, …);
  - Operations sliders (Users, Opportunity, MDF, Deal Registration, Drip Campaigns, …);
  - Advanced options (Setup menu, Auto publishing, drip, export, …).
- **Yes** → the needed slider(s) are raised to at least View (Edit where AMP needs it), and any Advanced option the page's data needs is turned on. Example: Email Drip needs the "drip" option.
- **No** → the module's slider goes to NA.
- **Never lowers for a Yes, never turns options off:** a slider is never lowered for a Yes, and Advanced options are never turned off, because they also open other pages.
- **Conflicts are reported, not guessed:** a "No" page whose slider a "Yes" page also needs gets a clear message.
- **Pages it says it can't set, with the reason:**
  - the Dashboard (always visible);
  - Roles and other Super-Admin-only pages;
  - Rewards Catalog (a company setting);
  - pages not in the company's module list.
- **"Yes" on pages AMP gives every role** (Dashboard, Contacts, Accounts, Lists) is reported as **"nothing to set"**.

### 4.4 Layer 1b — Navigation Layout (pages roles can't hide)
- **The problem:** AMP gives every role full Contacts, so **Contacts, Lists and Import** (and company-made menu modules) can't be hidden with sliders.
- **What the tool does for a "No" on these:** sets the module's **Navigation Layout → Settings** to *Shown to: specific users*. It links **everyone in the company except** the users who must not see it. AMP then hides the menu item and redirects the page to `/noaccess`.
- **Who each column is:** the user's jwt (if pasted), or the email typed under the role. The tool matches it against the company's user list.
- **It reads before writing:** current links are read first and only the toggles that are needed are flipped. AMP's toggles are flip switches.
- **It confirms:** links are read back afterwards, and a screenshot of the module's settings is saved.
- **On by default**, with a switch on the review step. Preview changes nothing.
- **Caveats, shown in the plan and the report:**
  - It affects the **whole company**. Users added later won't see these modules until they are linked.
  - A user can still see a module through a persona, group or organization link. The check as the users catches that.

### 4.5 How it works in AMP (careful by design)
- **AMP's own screens:** a real Chromium browser opens Setup → Roles, opens the role, moves the sliders (exactly like dragging them), and clicks Save. AMP's own JavaScript and validation run.
- **Deliberately slow:** it pauses after every tab switch, slider move and save. *Speed in AMP*: 0.8 s, 1.5 s (default) or 3 s per step.
- **Each move is checked:** every slider is read back after it is moved, and retried once if AMP didn't take it.
- **Each save is checked:** AMP's `SaveRole` answer is checked. Then **the role is reopened and every change is read back**, so a change AMP silently dropped shows as a failure.
- **Every role opens from a fresh page:** the previous role's editor window can't block the next one.
- **Screenshots: 2–3 per role.** One full image per tab (Marketing Functions, Operations, and Advanced when an option is involved). Each shows **every row** of the tab, with changed rows outlined in orange.
- **Show the browser window:** an option on the review step, to watch it work.

### 4.6 Layer 2 — check as the users
- **Turning it on:** on the review step, paste the jwt of each column's user (optional).
- **What it does:** after Apply, the tool logs in as each of them and runs the Pages Testing engine on the rulebook pages.
- **The result per column** reads like "16 / 20 pages behave as the rulebook says". The full page-test report also appears in Past runs.
- **Waits for AMP's cache:** after a Navigation Layout change, it waits ~70 s before opening the pages, because AMP caches module settings for about a minute.
- **Super Admin's jwt is refused:** a user jwt that is the Super Admin's is rejected.

### 4.7 Layer 3 — AI review (optional, Google Gemini)
- **What it does:** sends each role's tab screenshots, the user-page screenshots and the results to Gemini (default `gemini-2.5-pro`). Gemini checks them against the rulebook and returns pass / fail / unsure, with one check per item.
- **Without the check as the users,** it reviews only the permissions.
- **Advisory only:** the tool's own checks decide the result. The AI has produced false alarms in testing.
- **It sends screenshots of client data to Google.** It is off by default and asks for confirmation each time. jwts are never sent.
- **Setup:** `GEMINI_API_KEY=<key>` in `.env` or `.env.local`, or set in the terminal. Optionally `GEMINI_MODEL=<model>`.

### 4.8 Hand-off to Step 2
After a rulebook **Apply**, the finished screen shows **"Verify in Pages Testing →"**:
- **Filled in:** it opens Pages Testing with the site, the rulebook and the columns whose roles were saved, and each user row shows the role that was set.
- **jwts kept in server memory:** if user jwts were pasted in the setter, they are kept **in server memory for 15 minutes** and used directly, so the tester goes straight to Run.
- **The page never receives them:** it refers to them by a hand-off id, which is removed from the address bar.

### 4.9 Setter report (`output/_setter/<run>/report.html`)
Written to be read in seconds:
- **Banner:** ✓ Done / Done, but N pages don't match / Preview done — nothing saved / Finished with problems.
- **Per user type:** one table of **Page · Rulebook says · Result now · Match** (✓ Matches / ✗ Does not match / ? Check). "Result now" is what the user actually got when they were checked by logging in, e.g. "Blocked for Anmol Sethi". Otherwise it is what the tool set.
- **What changed in AMP:** before → after for each permission, with ✓ saved.
- **The role's 2–3 tab screenshots**, and the AI verdict (details fold open).
- **Navigation Layout section:** each module, who it is hidden from, who it is shown to, the result, and a screenshot.
- **Also in the folder:** `results.json`, `audit.jsonl` and `shots/`.

---

## 5. Module 2 — AMP Pages Testing (Step 2: verify)

Opens every rulebook page **as each user** and decides whether that user got a usable page.

### 5.1 Steps in the page
1. **Environment:** the site address and an optional display name. Production needs approval.
2. **Rulebook:** pick or upload. Detected user-type columns are shown as tick boxes, and the tester can untick any.
3. **Users & tokens:**
   - one row per user type, named exactly as in the sheet;
   - paste only the jwt, and the row ticks itself;
   - **Check tokens** shows "✓ Logged in as <name> · persona · company";
   - **Clear jwts** removes them all.
4. **Run:**
   - **Plan:** site, users, pages and estimated time.
   - **Advanced options:**
     - only the first N pages, for a smoke test;
     - delay between pages;
     - page wait limit;
     - users at the same time (1–5, default 3);
     - step-by-step debug screenshots;
     - show the browser.
   - **Live progress,** with a Cancel button.
5. **Results:** failed / review / passed per user type, **Open full report**, **Test again**, and a reminder to log out.

**Past runs** lists every earlier report.

### 5.2 How it opens pages
- **Per user:** a fresh, separate browser profile, with the jwt set as an **HttpOnly** cookie for the site only.
- **Browser start is retried:** Chromium occasionally dies while starting (seen on Windows right after a Setter run). Starting is tried up to 4 times, about 10 s in all, and every failed attempt is logged with Playwright's full message. If one user's browser still won't start, the report says that user was not tested. If no user's browser starts, the run stops with "No pages were tested" instead of writing a report where every page is Review. The Setter's role editor uses the same retry.
- **The AMP frame first:** it loads AMP's main page, then takes a **"frame only" snapshot** (menu, header and notifications) so they can be ignored when judging page content.
- **Each page in the same tab,** like clicking a menu item. It waits until the page has **finished loading**:
  - nothing on screen has changed for ~0.8 s;
  - none of the page's AMP requests is still running;
  - no loading spinner is visible.

  The limit is 30 s by default. A page still loading at the limit is marked Review, not guessed.
- **Evidence kept per page:**
  - the final URL and the page request's status or redirect;
  - AMP's no-access screen, if shown;
  - visible "no permission" / "something went wrong" / "page not found" messages;
  - page-specific elements;
  - which data calls returned data or were denied;
  - JavaScript errors;
  - a screenshot.
- **Parallel users:** users run in parallel (default 3), but pages within one user go one at a time, to keep load on AMP low.
- **Speed:** about 7–8 min for 100 pages × 3 users.
- **The menu is read too:** each user's menu is used to tell a **Security gap** (hidden from the menu, opens by URL) from plain **Extra access**.

### 5.3 How a page is judged
The question is **"did this user get a usable page?"**, not "does it look like someone else's screen?". Dashboards and many pages legitimately differ per user.

| Page state | Meaning |
|---|---|
| OPENED | Real page content beyond the AMP frame (an empty list with "No Data Found" counts) |
| OPENED_EMPTY | The page rendered but its own data calls were denied |
| BLOCKED | No-access screen, redirect to `/noaccess`, a visible "no permission" message, or nothing shown with data denied |
| BLANK | Only the AMP frame rendered |
| ERROR | Error message with nothing else, script crash, or server error |
| NOT_FOUND | The route doesn't exist on this build |
| BAD_TOKEN | Sent to login / session expired |

| Verdict | When |
|---|---|
| Pass | Matches the rulebook |
| **Security gap** | Rulebook says No, hidden from the menu, but opens by URL |
| Extra access | Rulebook says No, but the page opens |
| Missing access | Rulebook says Yes, but the user can't use the page |
| Opens empty | Rulebook says Yes, the page opens but its data is denied |
| Review | Not a permission result: the page rendered for nobody, or the session expired |
| Not specified | No Yes/No in the rulebook |

### 5.4 Pages report (`output/<site>-<time>/`)
- **`report.html`:**
  - summary and a matrix of pages × users, with "in menu / not in menu" hints;
  - each issue with the reference user's screenshot next to the tested user's;
  - **tester review** per issue (Confirmed / False alarm, with a note) and CSV export;
  - menu items the rulebook doesn't cover.
- **`results.json`, `results.csv`, `summary.json`, `audit.jsonl`,** a copy of the rulebook, and one screenshot per page per user.
- **Debug screenshots (`debug/<time>_<site>/<user>/<page>/`):**
  - what the browser showed every ~2 s while loading;
  - the screen the decision was based on;
  - a `decision.txt` explaining the decision.

### 5.5 Command line (for automation)
`npm run check`, `npm run menu` and `npm run run -- [--limit N] [--only type] [--dry-run] [--headed] [--debug]`.
- **Input:** `run.config.json`, with jwts from environment variables or `.env.local`.
- **Exit codes:** 0 pass, 2 failures, 1 error, 130 cancelled.

---

## 6. Safety and security

| Area | What the tool guarantees |
|---|---|
| Reads vs writes | **Pages Testing never changes AMP.** The browser only navigates. Requests the page makes by itself pass a gate: GETs and read-only APIs (`get*`, `load*`, `check*`…, excluding hidden writes like `getoradd*`) are allowed. Every other write, logout, AI call and third-party tracking request is blocked and logged |
| Setter writes | The Permission Setter may make **only** these writes, and only on **Apply**: `SaveRole`, plus `ToggleModuleSettingLink` / `UpdateModuleSetting` for Navigation Layout. Preview blocks them. Role assignment, deletes and everything else stay blocked |
| Production | Refused unless explicitly approved; remote sites must use HTTPS; on production, users are tested one at a time |
| Load on AMP | One page at a time per user, with a delay (AMP rate-limits and alerts on bursts) |
| jwts | In memory only; never written to disk or browser storage; masked (`eyJhb…x9Q`) in every log, audit entry, error and report; HttpOnly in the test browser, so page scripts can't read them; a fresh browser profile per user. The Setter→Pages hand-off keeps them in server memory for 15 minutes at most and never sends them to the page |
| Local server | Listens on `127.0.0.1` only; token-carrying APIs need the page's own header and origin; a foreign Host header is refused (DNS rebinding); strict security headers and CSP |
| Audit | Every request made, allowed or blocked is written to `audit.jsonl`, with tokens masked |
| External services | None, except the optional Gemini review (off by default, confirmed each time, never sent jwts) |

**Testers should:**
- **Log out** of the AMP windows the jwts came from (this revokes them).
- Use **test users** on QA/staging.
- Not paste jwts into chat or tickets.
- Treat `output/` and `debug/` as internal: they contain screenshots of client pages.

---

## 7. Architecture (for developers)

| Path | Responsibility |
|---|---|
| `src/server/index.ts` | Local web server and API: rulebook parsing, token checks, runs, setter runs, hand-off store, serving reports |
| `src/server/ui.html` | Home catalog, Pages Testing welcome, wizard, Past runs |
| `src/server/setter.html` | Permission Setter wizard |
| `src/run.ts` | Pages Testing engine (shared by UI, CLI and the setter's check as users) |
| `src/rulebook/parse.ts` | `.xlsx` / `.csv` reader, header search, value-based column detection |
| `src/probe/browser.ts`, `src/probe/menu.ts` | Playwright page probe (wait-until-loaded, evidence, screenshots) and menu reader |
| `src/probe/launch.ts` | Starts Chromium for both modules, with retries and full error logging |
| `src/verdict/*` | Page state, AMP frame, reference view, verdict |
| `src/report/write.ts` | Pages report |
| `src/setter/sliders.ts` | Page → module → permission table (from AMP's `Module.HasModuleAccess`) and the per-role plan |
| `src/setter/nav.ts`, `src/setter/navrun.ts` | Navigation Layout plan (who to link or unlink) and how it is applied |
| `src/setter/editor.ts` | Drives AMP's role editor and Navigation Layout in the browser; full-tab screenshots |
| `src/setter/session.ts` | Super Admin check and module list |
| `src/setter/run.ts` | Setter run: roles → Navigation Layout → check as users → AI review → report |
| `src/setter/ai.ts` | Gemini review (structured JSON answer) |
| `src/safety/gate.ts` | Environment guard, tool request gate, browser gates (Pages, and Setter with its write allowlist) |
| `src/util/*` | Logger, token masking, audit log, route helpers, parallel runner |

**Technology:** Node.js + TypeScript (run with `tsx`, no build step), Playwright (Chromium), exceljs, vitest, and `@google/genai` (optional AI review). The UI is plain HTML and JavaScript served by `node:http`.

### Tests
| Command | Covers |
|---|---|
| `npm test` | Unit tests: rulebook parsing, gates, masking, verdicts, the setter's plan, Navigation Layout planning |
| `npm run e2e` | Pages Testing against a simulated AMP (every verdict scenario, write blocking, jwt leak scan, parallel users) |
| `npm run e2e:ui` | The Pages wizard driven in a real browser |
| `npm run e2e:setter` | Setter against a fake AMP role editor and Navigation Layout. Covers: preview, apply + reopen, two roles in one run, the Navigation Layout whitelist, the check as the users, every-slider mode, and the AI review against a fake Gemini API |
| `npm run e2e:browser-start` | Chromium unavailable: start is retried and logged, then the run stops with "No pages were tested" and writes no all-Review report |
| `npm run e2e:handoff` | Apply → Verify in Pages Testing through the real server and a browser (the kept jwt is never exposed) |
| `npm run typecheck` | TypeScript |

---

## 8. Known limits

- **Company settings are reported, not changed:** Deal Registration type, Incentive programs (Rewards Catalog) and Course catalog (Get Certified) decide whether some pages exist at all.
- **Roles must exist and be assigned beforehand.** Automatic role creation and assignment (with confirmation) is planned but on hold.
- **One user per column.** Users in the same column with different groups or organizations may get different access.
- **The Navigation Layout step links users individually.** Users added later need linking, and persona, group or org links can still show a module.
- **Page-level access only.** Buttons and actions inside a page, and API data leaks, are future work.
- **AMP caching:** role and module changes can take up to about a minute to reach a logged-in user.

Ideas for making it more reliable: [IMPROVEMENT-SUGGESTIONS.md](IMPROVEMENT-SUGGESTIONS.md).
