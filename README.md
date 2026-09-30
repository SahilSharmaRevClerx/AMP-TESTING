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
3. **Users & tokens**: for the reference Site Admin and each user type, paste the `jwt` and `X-CSRF-Token` cookies (the page explains how), then **Check tokens** to see who each belongs to.
4. **Run**: preview the plan, optionally test only the first N pages, start, watch progress, then **Open report**.

Past runs are listed at the bottom. Tokens entered in the UI stay in the server's memory for that run only; they are never written to disk or browser storage. The server listens on `127.0.0.1` only and rejects API calls that don't come from its own page.

## Command line (optional, for automation)

The CLI reads the environment from `run.config.json` (copy `run.config.example.json`) and tokens from environment variables.

### Tokens for the CLI

For each user type in `run.config.json` (including the calibration Site Admin):

1. Log in to AMP as that user in a normal browser (a separate browser profile or incognito window per user).
2. DevTools → Application → Cookies → copy the values of `jwt` and `X-CSRF-Token`.
3. Put them in `.env.local` (copy from `.env.example`; git-ignored) or set them in the terminal:

```powershell
$env:AMP_JWT_PARTNER_SALES = "..."
$env:AMP_CSRF_PARTNER_SALES = "..."
```

The calibration user should be a **Site Admin with MFA enabled**, so it can open every page. Its run is used as the reference for what each page looks like when it opens.

Tokens expire. The tool checks them first and stops if any is invalid. Delete `.env.local` after the run.

### CLI commands

```powershell
npm run check                       # who does each token belong to?
npm run menu                        # each user's menu vs the rulebook
npm run run -- --dry-run            # show what would be requested, send nothing
npm run run -- --limit 5            # smoke test on the first 5 pages
npm run run                         # full run
npm run run -- --only partner_sales # one user type (+ calibration)
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

1. **Menu:** the user's menu is read from AMP's main page (`var navigation = [...]`).
2. **Page:** the page is opened in a real browser as the user (`#route`), and the tool records: final URL, the page request's status/redirect, AMP's no-access page marker, which of the page's own API calls were denied, the elements on screen, and a screenshot.
3. **Fingerprint:** the calibration run records what each page looks like when it opens (its elements minus the shared AMP shell). A user "opened" the page when enough of that fingerprint is on screen (`fingerprintThreshold`, default 60%).

| Page state | Meaning |
|---|---|
| OPENED | Fingerprint matched, nothing denied |
| BLOCKED | No-access page shown or redirected to `/noaccess` |
| OPENED_EMPTY | Page loaded but its own data calls were denied |
| BAD_TOKEN | Sent to login / session expired |
| NOT_FOUND / ERROR | Route missing on this build / server or script error |
| UNCLEAR | Nothing conclusive; a tester decides from the screenshots |

| Verdict | When |
|---|---|
| Pass | Matches the rulebook |
| **Security gap** | Rulebook says No, the page is hidden from the menu, but opens by URL |
| Extra access | Rulebook says No, but the page opens (and is in the menu) |
| Missing access | Rulebook says Yes, but the page is blocked |
| Opens empty | Rulebook says Yes, the page opens but its data is denied |
| Review | Unclear, error or not found; check manually |
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
