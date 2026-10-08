# PRD — AMP Permission Testing Tool (v1: Page Visibility)

| | |
|---|---|
| **Status** | v1 implemented (M1–M5, incl. tester web UI); verified against a simulated AMP; awaiting first real-environment run. |
| **Owner** | Sahil Sharma |
| **Date** | 2026-09-30 |
| **First target environment** | AISB (deployed) — URL to be confirmed |
| **Repo** | `AMP-PERMISSION-TESTING-REPO` (standalone, separate from the AMP repo) |

> **Update (2026-09-30):** the Site Admin "calibration" run described below was replaced. User types come only from the rulebook's columns (clients have Super Admin / users / partners, not the internal Site Admin). Each user opens every page once; then, per page, the tested user who saw the most of it is the reference. Visible "no access" messages count as blocked. Testers provide the jwt only.

---

## 1. Problem

AMP is a heavily role-based (RBAC) platform. Every page should be visible only to the right user types — Site Admin, Super Admin, and personas such as Channel Manager, Corporate PRM Admin and Partner Sales.

Today testers verify this **manually**: log in as each user type, click through every page, and tick it off against a rulebook spreadsheet. For ~100 pages × 3+ user types this is:

- **Slow** — hundreds of manual checks per release.
- **Error-prone** — easy to miss a page or mis-record a result.
- **Shallow** — testers check the menu, but rarely type a hidden page's URL directly, so *"hidden in the menu but still opens by URL"* gaps go unnoticed.

## 2. Goal

A standalone tool that, given a **rulebook** and **login tokens for each user type**, automatically checks every page for every user type against a deployed AMP, and produces an **expected-vs-actual report with screenshot evidence** for tester review.

### v1 goals
1. Check **menu visibility** — does the page appear in the user's navigation menu?
2. Check **direct access** — does the page actually open when the user goes to its URL?
3. Decide each result from **what the user actually sees** (real browser), not just the HTTP status.
4. Produce a **results matrix + issue list + screenshots**, reviewed by a tester (human-in-the-loop).
5. Be **safe** — read-only, no data changes, no data sent outside the tester's machine.

### Non-goals (v1)
- API data-leak testing (planned for v2).
- Buttons/actions inside a page (Create, Edit, Delete visibility).
- Cross-organization / cross-tenant data access.
- Automatic login (tokens are pasted by the tester in v1).
- LLM involvement — v1 is fully deterministic.

## 3. Users

| User | Needs |
|---|---|
| **QA tester** (primary) | Upload rulebook, paste tokens, run, review failures, export report |
| **Developer** | See exact evidence (URL, status, screenshot) to reproduce and fix a failure |
| **QA lead** | Pass/fail summary per release and per environment |

## 4. Background — how AMP enforces page access

(Verified against the AMP codebase.)

| Layer | Mechanism | Denied behaviour |
|---|---|---|
| **Menu** | Built server-side per user (`default.navigation.cs`) and embedded in the main page as `var navigation = [...]` (items carry `name`, `link`, `key`). Companies may have a custom menu layout. | Item not present |
| **Page** | Hash route (e.g. `#setup/roles`) → server route (`web-navin-routing.xml`) → page model → `module.HasAccess(user)` | `302` → `/noaccess` |
| **Auth** | Cookie `jwt` + cookie `X-CSRF-Token` + header `X-CSRF-Token` (must match) | Redirect to `/login` or `/sessionexpired` |

Known complications the tool must handle:
- Access is decided by **roles**, not persona. The rulebook is written per persona, so each "user type" is really *one specific test user* whose roles represent that persona.
- A **Site Admin only sees everything when MFA is enabled** on that account.
- Some pages don't use the standard permission check, and some deny access in non-standard ways (200 with an error message, 500, empty page). **A 200 status alone does not prove the page opened.**
- Rulebook routes don't always map 1:1 to server routes (e.g. `#coursecatalog` is served as `/coursecatalog/courses`).
- Modules can be enabled/disabled **per company**, so results are only valid for the environment + company they were run on.

## 5. Inputs (provided by the tester)

1. **Environment**: base URL (e.g. AISB), a display name, and whether it is production.
2. **Rulebook** (Excel/CSV): one row per page with its route and the expected `Yes`/`No` for each user type. A starting CSV built from the current *Internal User Personas* sheet ships in `rulebook/`.
3. **Tokens per user type**: `jwt` and `X-CSRF-Token`, copied from browser DevTools after logging in as that user. Tokens are held **in memory only**.

## 6. How it works

```
 Rulebook + Environment + Tokens
              │
   ① Token check ─────────── per user type: confirm token is valid and belongs to
              │                the user type it is labelled as (identity, isSiteAdmin, persona)
   ② Menu read ───────────── per user type: 1 page load → extract every menu link
              │
   ③ Calibration ─────────── Site Admin opens every page → record each page's
              │                "fingerprint" (heading, key elements, API calls) + screenshot
   ④ Page probe ──────────── for each page × user type, one at a time, in a real browser:
              │                open #route → collect evidence → screenshot
   ⑤ Verdict ─────────────── evidence + fingerprint → Opened / Blocked / …
              │                compared with the rulebook → Pass / Fail
   ⑥ Report + tester review ─ matrix, issue list, admin-vs-user screenshots side by side
```

### ④ Evidence collected per page × user type
| # | Evidence | Tells us |
|---|---|---|
| 1 | Final URL (`/noaccess`, `/login`, `/sessionexpired`?) | Blocked / bad token |
| 2 | No-access marker on screen (AMP's 401 page element) | Blocked even when status is 200 |
| 3 | Page fingerprint match (from calibration) | Page genuinely opened |
| 4 | Network: page request status; page's own API calls returning 401/no-access | Opened but data denied |
| 5 | Visible content amount | Real page vs empty shell |
| 6 | Console / JS errors | Page crashed |
| 7 | Screenshot | Human-verifiable proof |

### ⑤ Access state (what the user experienced)
| State | Rule |
|---|---|
| **OPENED** | Fingerprint matched (≥ threshold, default 60%, tuned after the first real run) and no denial signal |
| **BLOCKED** | Redirected to `/noaccess`, or no-access marker shown |
| **OPENED_EMPTY** | Page shell loaded but its data calls were denied / no content |
| **BAD_TOKEN** | Ended on `/login` or `/sessionexpired` → stop this user type, alert tester |
| **ERROR** | 5xx or JS crash |
| **NOT_FOUND** | Route does not exist on this build (rulebook may be outdated) |
| **UNCLEAR** | None of the above matched → tester decides |

### ⑤ Verdict against the rulebook
| Rulebook | In menu | Access state | Verdict |
|---|---|---|---|
| Yes | ✅ | OPENED | ✅ **PASS** |
| No | ❌ | BLOCKED | ✅ **PASS** |
| No | ❌ | OPENED | 🔴 **FAIL — security gap** (hidden in menu, opens by URL) |
| No | ✅ | OPENED | 🔴 **FAIL — extra access** |
| Yes | ❌ | BLOCKED | 🟠 **FAIL — missing access** |
| Yes | ✅ | BLOCKED | 🟠 **FAIL — broken** (menu shows it, page denies) |
| Yes | any | OPENED_EMPTY | 🟠 **FAIL — opens without data** |
| any | any | ERROR / UNCLEAR / NOT_FOUND | ❓ **REVIEW** |

Group rows in the rulebook (e.g. *Deal Management*, *Reports*) have no route: they are checked against the menu only, and count as visible if any child is visible.

## 7. Safety requirements (must-have)

| # | Requirement |
|---|---|
| S1 | **Read-only.** Pages are opened by navigation only. The browser never clicks, types or submits anything. |
| S2 | **Request gates.** *Tool requests* (token check, menu read) go through one gate: configured host only, GET for pages, POST only to the allow-listed `getpermissiondataforuser`. *Requests the page makes by itself while loading* pass a browser gate: GETs allowed; `api.ashx` calls allowed only for read-only API names (`get*`, `load*`, `check*`…, excluding hidden writes such as `getoradd*`); all other non-GET requests and any logout are blocked and logged. |
| S3 | **Production guard.** Environments flagged as production are refused unless explicitly overridden. |
| S4 | **Throttling.** One request at a time with a configurable delay (default 500 ms), to avoid load and AMP's rate limiter (which alerts `ratelimit@amp.vg` and can blacklist the IP). |
| S5 | **Tokens never persisted.** Held in memory only; masked in logs and reports (`eyJhb…x9Q`). |
| S6 | **No external data transfer.** v1 makes no LLM or third-party calls; reports and screenshots stay on the tester's machine. |
| S7 | **Audit log.** Every request is logged (time, user type, URL, status) for traceability. |
| S8 | **Dry run.** The tester can preview every planned request before running. |
| S9 | **Use test accounts.** Runs should use dedicated test users/company; page opens still write AMP usage-tracking rows. |

## 8. Output

- **Results matrix** — rows = pages, columns = user types, cells = verdict (colour-coded).
- **Issue list** — each FAIL/REVIEW with: page, user type, expected vs actual, final URL, status, evidence, and admin-vs-user screenshots.
- **Tester review** — mark each issue *Confirmed* or *False alarm* (with a note).
- **Export** — HTML report + CSV/Excel.
- Every report is stamped with **environment, company, test user per user type, AMP build version, date**.

## 9. Technical design (v1)

- **Stack:** Node.js + TypeScript; **Playwright** (headless Chromium) for browser checks; small local web UI for testers.
- **Modules:**
  - `rulebook/` — parse Excel/CSV into rules
  - `safety/` — request gate, prod guard, throttle, audit log, token masking
  - `sessions/` — token validation
  - `probe/` — menu extraction, browser page probe, evidence collection
  - `calibrate/` — Site Admin fingerprint capture
  - `verdict/` — access state + rulebook comparison
  - `report/` — HTML/CSV report
  - `ui/` — tester web UI (inputs, run, matrix, review)
- **Runs on:** the tester's machine; also runnable as a CLI (for future CI use).

## 10. Milestones

| # | Deliverable | Acceptance |
|---|---|---|
| M1 | Project setup, rulebook parser, request gate + safety | Rulebook CSV parses; gate refuses non-allowed requests (unit tests) |
| M2 | Token check + menu extraction (CLI) | For each token: correct identity and full menu list printed |
| M3 | Browser probe + calibration + verdicts (CLI) | Full run on AISB produces a correct matrix for 3 user types |
| M4 | HTML report with screenshots | Tester can review every FAIL with admin-vs-user screenshots |
| M5 | Tester web UI | Tester runs end-to-end without touching the command line |

## 11. Success metrics
- A full run (≈100 pages × 3 user types) completes in **≤ 20 minutes** with no manual clicking.
- **0** write/destructive requests (verified by audit log).
- **UNCLEAR** results ≤ 10% of checks after calibration.
- Every FAIL has screenshot evidence.

## 12. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Test user's roles don't match the persona the rulebook assumes | Token check shows each user's identity/persona; report records which user was used |
| Rulebook outdated or missing values | NOT_FOUND state; rows with missing expectations are reported as "not specified", never guessed |
| Tokens expire mid-run | BAD_TOKEN stops that user type immediately and alerts the tester |
| Non-standard denial behaviour on some pages | Calibration fingerprints + UNCLEAR bucket + screenshots |
| Site Admin without MFA doesn't see everything | Calibration warns if the admin's menu is unexpectedly small |
| Rate limiting on deployed environment | Sequential requests + delay; option to whitelist tester IP |

## 13. Future (v2+)
- API data-leak testing using an approved, developer-reviewed API allowlist.
- Hidden-field checks in API responses.
- Cross-org / cross-tenant access checks.
- Automatic login for non-MFA test users.
- Baseline + regression diff between runs/builds; CI integration.
- Optional LLM assistance (explain issues, review UNCLEAR screenshots).

## 14. Open questions
1. AISB base URL, and which company/tenant on AISB to test against.
2. Which test user represents each persona (Channel Manager, Corporate PRM Admin, Partner Sales), plus a Site Admin with MFA enabled for calibration.
3. Should Site Admin and Super Admin be columns in the rulebook too? The current sheet only covers three personas.
4. Rulebook gaps to confirm (see `rulebook/README.md`): *Get Certified*, *Marketing Reports* and several group rows have missing or incomplete expected values.
