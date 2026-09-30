# AMP Permission Testing

Checks, for every user type, which AMP pages **appear in the menu** and which **actually open**, compares that with an expected-access rulebook, and produces a report with screenshot evidence for tester review.

- Spec: [docs/PRD.md](docs/PRD.md)
- How it works (flow, files, diagrams; open in a browser): [docs/how-it-works.html](docs/how-it-works.html)
- Rulebook: [rulebook/](rulebook/)

Status: v1 (page visibility) implemented with a tester web UI, verified against a simulated AMP (`npm run e2e`, `npm run e2e:ui`). Not yet run against a real environment.

## Setup (once per machine)

Requires Node 22+.

```powershell
npm install
npx playwright install chromium
```

## Using it (testers)

```powershell
npm start
```

This opens `http://127.0.0.1:4545` in your browser. Everything is entered on that page, per run, so each client can have its own URL and user types:

1. **Environment**: name and base URL of the client's AMP. Recent environments are remembered (URLs only).
2. **Rulebook**: pick one from `rulebook/` or upload an `.xlsx`/`.csv`. Its Yes/No columns become the user types for the run.
3. **Users & tokens**: one row per user type from your rulebook. Paste the `jwt` cookie (the page explains how) for the ones you want to test. Only the jwt is needed: the tool generates the matching CSRF value itself, as AMP's CSRF check only requires header = cookie
4. **Run**: preview the plan, optionally test only the first N pages, start, watch progress, then **Open report**.

Past runs are listed at the bottom. Tokens entered in the UI stay in the server's memory for that run only; they are never written to disk or browser storage. The server listens on `127.0.0.1` only and rejects API calls that don't come from its own page.

## Keeping jwts safe

A jwt is a live AMP session: whoever holds it is logged in as that user until it expires or the user logs out.

**What the tool does**

| Where | Protection |
|---|---|
| Tester page | jwt boxes are masked and not password fields (password managers don't offer to save them); never written to browser storage; wiped on **Clear jwts**, **New test**, or page refresh; pasted `jwt=…;` pairs are cleaned to the bare value |
| Page → tool server | server listens on `127.0.0.1` only; token-carrying APIs require the page's own header and origin; requests with a foreign `Host` header are refused (blocks DNS-rebinding sites from reaching the tool or its reports); security headers (`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a Content-Security-Policy that only allows talking to this server) |
| Tool server | jwts live in memory only for the token check / run, then are dropped (including from the masking list); never written to disk; masked (`eyJhb…x9Q`) in every log line, audit entry, error and report |
| To AMP | sent only to the environment's own host, over HTTPS (plain HTTP only for localhost); redirects are not followed with the cookie |
| Test browser | fresh in-memory profile per user, deleted after the run; the jwt cookie is **HttpOnly**, so scripts on AMP pages (including third-party ones) cannot read it; scoped to the environment's host only |
| Tests | every test run scans all output files and the server's terminal output for raw jwts, and checks that a page script cannot read the jwt cookie |

**What testers should do**

1. **Log out when done.** AMP sessions are revoked server-side on logout (`Authentication.Logout` → session `Revoked`), so the copied jwt stops working everywhere. This is the most effective protection.
2. Use **test users** on QA/staging, not real admin accounts on production.
3. Don't paste jwts into chat, email or tickets; clear your clipboard (Windows **Win+V** keeps clipboard history).
4. Treat `output/` as internal: reports contain screenshots of client pages (but never jwts).

## Developer logs (terminal)

The terminal running the server shows structured logs:

```
20:56:34.346 INFO  [run] run started run=itbd-2026-… env=ITBD users=super_admin,normal_user pages=3
20:56:54.209 INFO  [run] verdict user=normal_user route=intel/account expected=No state=OPENED inMenu=false verdict=FAIL_SECURITY_GAP why="…"
```

| Start with | Shows |
|---|---|
| `npm start` | `info`: startup, API requests, rulebook loads, token checks, menus, run start/finish, failures with reasons, per-user totals, warnings, errors with stack traces |
| `npm run start:debug` | also `debug`: every page's evidence (HTTP status, redirect, elements, API calls, denied/blocked calls, time), every request the tool makes, every blocked browser request, AMP page JavaScript errors, fingerprints, menu links |

You can also set `LOG_LEVEL=debug|info|warn|error`, and `NO_COLOR=1` to disable colours. Tags: `[server]` UI server, `[http]` API requests, `[run]` run engine, `[gate]` tool requests, `[browser]` Playwright. Tokens are always masked.

## Command line (optional, for automation)

The CLI reads the environment from `run.config.json` (copy `run.config.example.json`) and tokens from environment variables.

### Tokens for the CLI

For each user type you want to test (keys from the rulebook columns, listed in `run.config.json`):

1. Log in to AMP as that user in a normal browser (a separate browser profile or incognito window per user).
2. DevTools → Application → Cookies → copy the value of `jwt`.
3. Put them in `.env.local` (copy from `.env.example`; git-ignored) or set them in the terminal:

```powershell
$env:AMP_JWT_PARTNER_SALES = "..."
```

Test at least one high-access user type (e.g. a Super Admin) alongside the others: for each page, the tested user who sees the most of it is used as the reference for what the page looks like when it really opens.

Tokens expire. The tool checks them first and stops if any is invalid. Delete `.env.local` after the run.

### CLI commands

```powershell
npm run check                       # who does each token belong to?
npm run menu                        # each user's menu vs the rulebook
npm run run -- --dry-run            # show what would be requested, send nothing
npm run run -- --limit 5            # smoke test on the first 5 pages
npm run run                         # full run
npm run run -- --only partner_sales # one user type
npm run run -- --headed             # watch the browser
```

Output goes to `output/<env>-<timestamp>/`:

| File | Content |
|---|---|
| `report.html` | Summary, matrix, issues with admin-vs-user screenshots, tester review (Confirmed / False alarm) with CSV export |
| `results.json`, `results.csv` | Every check with its evidence |
| `shots/<user type>/*.png` | One screenshot per page per user |
| `audit.jsonl` | Every request made or allowed, and every request blocked (tokens masked) |

Exit code: `0` all pass, `2` failures found, `1` setup/run error.

## How a page is judged

The question for each page and user is **"did this user get a usable page?"**, not "does it look like someone else's view?" (dashboards and many pages legitimately differ per user). The rulebook's Yes/No then says how to read a page that isn't usable.

1. **Menu:** the user's menu is read from AMP's main page (`var navigation = [...]`); shown as information only.
2. **Frame:** for each user the tool opens a route that doesn't exist, so only the AMP frame renders (menu, header, notifications). Together with what repeats on most pages, this is the frame, and it is ignored when judging content.
3. **Page:** each page is opened as the user (`#route`); the tool waits until the page stops changing, then records the final URL, the page request's status/redirect, AMP's no-access screen, visible "no permission" or "something went wrong" messages, the elements on screen, which data calls returned data or were denied, and a screenshot. Same-origin iframes are included.
4. **State of each page view:**

| Page state | Meaning |
|---|---|
| OPENED | Page content beyond the AMP frame (page-specific elements, or elements plus loaded data) |
| OPENED_EMPTY | Page content, but its own data calls were denied |
| BLOCKED | AMP no-access screen, redirect to `/noaccess`, an on-screen "no permission / access denied / not authorized" message, or nothing shown and its data calls denied |
| BLANK | Only the AMP frame rendered |
| ERROR | "Something went wrong"-type message with nothing else, script crash with nothing rendered, or HTTP 5xx |
| NOT_FOUND | Route doesn't exist on this build |
| BAD_TOKEN | Sent to login / session expired |

5. **Verdict** (rulebook × state, with the other tested users as a cross-check):

| Rulebook | Usable (OPENED / OPENED_EMPTY) | Not usable (BLOCKED / BLANK / ERROR / NOT_FOUND) |
|---|---|---|
| **Yes** | Pass (Opens empty if data denied) | **Missing access**, or **Review** when *no* tested user got the page (broken page / wrong route, not a permission result) |
| **No** | **Extra access**, or **Security gap** if hidden from the menu | Pass |

So "No No No" rows need no reference: if nobody gets usable content, everyone passes. For information, each page also records a **reference view** (the tested user expected to have access who saw the most of it) and how much of it each user saw.

| Verdict | When |
|---|---|
| Pass | Matches the rulebook |
| **Security gap** | Rulebook says No, the page is hidden from the menu, but opens by URL |
| Extra access | Rulebook says No, but the page opens (and is in the menu) |
| Missing access | Rulebook says Yes, but the page is blocked, or blank/error for this user while others get it |
| Opens empty | Rulebook says Yes, the page opens but its data is denied |
| Review | Page didn't render for any tested user, or the session expired |
| Not specified | Rulebook has no Yes/No for this cell |

## Safety

- The tool only calls `getpermissiondataforuser` (read-only) and GETs AMP's main page itself.
- In the browser it only navigates; it never clicks or types. Requests the page makes by itself pass a gate: GETs are allowed; `api.ashx` calls are allowed only for read-only API names (`get*`, `load*`, `check*`…, excluding hidden writes like `getoradd*`); every other non-GET, and any logout, is blocked and logged.
- Environments marked `"isProduction": true` are refused unless `"allowProduction": true` is also set. Remote hosts must use HTTPS.
- One page at a time with `delayMs` between requests (AMP rate-limits and alerts on bursts).
- Tokens are masked in logs and reports and never written by the tool. No LLM or third-party calls.
- Opening pages still writes AMP's normal usage-tracking rows; use test users/company.

## Development

```powershell
npm test          # unit tests
npm run e2e       # full pipeline against a simulated AMP (tests/e2e/fake-amp.ts)
npm run e2e:ui    # the tester web UI driven in a real browser against the simulated AMP
npm run typecheck
```
