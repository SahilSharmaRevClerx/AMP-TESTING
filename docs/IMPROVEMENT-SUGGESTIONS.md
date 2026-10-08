# Improvement Suggestions

Ideas to make the AMP Permission Testing Platform more reliable and save testers more time. The main inspiration is **SmartBear Reflect**, a tool the company used before and dropped because **it failed on very small problems that were not real issues**.

Status: proposals only. None of these are built yet. The order below is the recommended build order.

---

## Why tools like Reflect raise false alarms

[Reflect](https://smartbear.com/product/reflect/) is a codeless, AI-assisted test tool:
- it records click paths and replays them;
- it "self-heals" selectors when the UI changes;
- it runs visual-regression checks;
- tests can be written in plain English.

A test passes only if the **same clicks, selectors, text and pixels** show up again. So ordinary changes count as failures, even when nothing is wrong:

- a button moved, was renamed or restyled;
- the page loaded a little slower than when it was recorded;
- a popup (WalkMe, a notification, a cookie banner) appeared;
- a dashboard showed different data or widgets;
- the screen differed by a few pixels.

Flaky tests are the most common complaint about test automation, and false positives are a large share of all test failures (Tricentis reports about 72%; see [TestRail on flaky tests](https://www.testrail.com/blog/flaky-tests/)). Once a team stops trusting the red results, it stops using the tool.

### What this platform already does differently
- **It judges the outcome, not the path.** "Did this user get a usable page, a no-access screen, or a redirect?" It compares no pixels and replays no recorded clicks.
- **It waits until each page has really finished loading:** the screen is stable, its requests are done and no spinner is showing. There are no fixed sleeps.
- **The AMP frame is ignored:** the menu, header and notifications are left out when judging a page.
- **Dashboards that differ per user are expected,** not counted as failures.
- **"Not sure" becomes Review, never Fail.** A page that rendered for nobody, or a session that expired, is not reported as a permission bug.
- **The AI review is advisory only.** In testing, Gemini once misread a slider; that did not fail the run.

The suggestions below build on this.

---

## 1. Confirm a failure before reporting it (highest value)

**Problem:** a slow server, a dropped request or a popup can make one page look blocked or empty once.

**Proposal:**
1. Every page that ends as ✗ (Missing access, Extra access, Security gap, Opens empty) or Review is **opened again on its own** at the end of the run, in a fresh tab, with a longer wait.
2. It is reported as ✗ only if the second result agrees.
3. If the results differ, it is labelled **"Flaky — passed on retry"** with both screenshots, and kept out of the failure count.

**Benefit:** removes most one-off false alarms; a ✗ then means "seen twice".

**Effort:** small to medium. It reuses the existing page probe.

---

## 2. Separate "couldn't test" from "permission problem"

**Problem:** these are not permission results, but today they can still end up near the failures:
- timeouts;
- server errors (5xx);
- an expired jwt;
- the AMP rate limiter;
- WalkMe or other third-party scripts breaking the page.

**Proposal:**
- **A "Could not test" bucket,** with its own section and the reason for each page.
- **Automatic retries** with back-off, up to 2 times.
- **Never counted as ✗.** These pages are excluded from the pass/fail summary.
- **Clear next steps:** "log in again and paste a fresh jwt", "the site is slow, raise the page wait", "rate-limited, lower parallel users".

**Benefit:** the failure list contains only real permission mismatches.

**Effort:** small. The evidence is already collected (status codes, BAD_TOKEN, still-loading).

---

## 3. Remember tester decisions (accepted exceptions)

**Problem:** testers already mark issues as **Confirmed** or **False alarm** in the report, but every new run shows the same false alarms again.

**Proposal:**
- **Save false alarms as accepted exceptions:** a "False alarm" (page + user type + site + reason + who + date) is kept in a small exceptions file per site.
- **Apply them on later runs:** matching results show as **"Accepted (false alarm on <date>)"** instead of ✗. They stay visible, but out of the failure count.
- **Exceptions expire:** after N days, or when the rulebook row changes.

**Benefit:** the same non-issue never has to be reviewed twice.

**Effort:** medium.

---

## 4. "New since last run" view (baseline diff)

**Problem:** on a re-run after a release, testers have to re-read every result to find what changed.

**Proposal:** compare each run with the previous run for the same site and rulebook, and show at the top:
- **new failures;**
- **fixed** (was ✗, now ✓);
- **still failing;**
- **new pages** (added to the rulebook).

**Benefit:** release testing turns into "look at the 3 new rows".

**Effort:** small to medium. `results.json` already has everything needed.

---

## 5. Check the rulebook before running ("rulebook lint")

**Problem:** rulebook mistakes surface as failures only after a full run. Example: the Dashboard row pointed at `#dashboard`, which does not exist on main.dvl.

**Proposal:** a quick check, before the run, using the Super Admin's view of the site:
- **links that don't exist** on this site (and which module or link likely matches);
- **empty Yes/No cells;**
- **duplicate pages;**
- **rows that conflict** (Yes and No for the same module in one column);
- **known impossible rows:**
  - "Super Admin: No" — a Super Admin always has full access;
  - "No" on the Dashboard;
  - pages that depend on a company setting that is off.

**Benefit:** fewer wasted runs, and the client gets a cleaner rulebook back.

**Effort:** small to medium.

---

## 6. Severity in the report

**Proposal:** sort and colour the issues by risk:
1. **Security gap:** hidden from the menu but opens by URL.
2. **Extra access:** the user can open a page they shouldn't.
3. **Missing access:** the user can't open a page they should.
4. **Opens empty:** the page opens but its data is denied.

Add a one-line summary at the top, e.g. "0 security gaps · 2 extra access · 1 missing access".

**Benefit:** a QA lead can tell at a glance whether a release is safe.

**Effort:** small.

---

## 7. Run only the failures again

**Proposal:** a **"Re-run failed pages"** button on the results screen and in Past runs. It opens only the ✗ and Review pages, for the same users. Typical uses:
- after a developer fixes something;
- after the tester fixes a role.

**Benefit:** minutes instead of a full run.

**Effort:** small.

---

## 8. Automatic role creation and assignment (on hold)

Today the tester must create one role per user type in AMP and assign it to the right user before running the Setter.

**Proposal:**
- **Pick users:** the tester picks the AMP user for each rulebook column.
- **Confirm a plan:** the tool shows the exact plan (create role "PT Partner Sales", assign it to Anmol, remove "Users.INC" from Anmol) and waits for **Confirm**.
- **Then act:** it creates the role, sets its sliders, and assigns it.

**Safety rules:**
- an allowlist of only these AMP writes;
- an undo record of each user's previous roles, with a "Restore previous roles" button;
- never on production;
- never touches company-wide or group roles.

**Benefit:** "rulebook in → permissions set" really becomes one click.

**Effort:** 1–2 days.

---

## 9. Scheduled runs and notifications

**Proposal:**
- **Scheduled runs:** run the Pages test nightly or after each deployment (from the CLI or a scheduler) on QA/staging.
- **A short Slack or email summary,** using the "New since last run" view (suggestion 4): "Rev Sparks on main.dvl: 0 new failures, 1 fixed."

**Benefit:** problems are found the day they are introduced, not at release time.

**Effort:** medium. It needs stored test credentials; see suggestion 10.

---

## 10. Automatic login for test users

**Problem:** pasting jwts is manual, and jwts expire.

**Proposal:**
- **Automatic login for test users without MFA:** an optional login with a username and password, kept in the operating system's credential store, never in the repo.
- **MFA users** keep the jwt method.
- **The jwt rules stay the same:** in memory only, and masked everywhere.

**Benefit:** it makes scheduled runs (suggestion 9) possible, and saves time on every manual run.

**Effort:** medium. It needs a security review first.

---

## 11. Smaller improvements

- **AI review that disagrees with the tool is shown as "Check".** It is not shown as a failure, and the matching screenshot region is cropped next to it, so the tester can decide in seconds.
- **Per-page wait learning:** remember how long each page usually takes on a site, and wait accordingly. Fewer "still loading" results on slow dev servers.
- **More than one user per column:** for example a Partner in Org A and a Partner in Org B, judged against the same Yes/No. This catches group- and organization-based differences.
- **"Why does this user have access?"**: show the roles, groups and organization behind each user, so "extra access" can be explained without opening AMP.
- **Button- and action-level checks** (Create, Edit, Delete visible or not), as a later module.
- **API data-leak testing** (the planned v2): call read APIs as each user, and flag data a user should not receive.

---

## Recommended order

| # | Suggestion | Why first |
|---|---|---|
| 1 | Confirm a failure before reporting it | Directly removes the kind of false alarm that made the team drop Reflect |
| 2 | Separate "couldn't test" from permission problems | Keeps environment noise out of the failure list |
| 3 | Remember tester decisions | A non-issue never shows up twice |
| 4 | New since last run | Makes re-runs after releases fast |
| 5 | Rulebook lint | Prevents wasted runs |
| 6 | Severity | Quick to add, clearer reports |
| 7 | Re-run failed pages | Quick to add, saves time |
| 8 | Automatic roles | Biggest setup saving (on hold) |
| 9–10 | Scheduling and auto-login | Unattended testing |

Suggestions **1–3 together** form a "trust package". Their goal: a ✗ in this tool always means a real permission problem that was seen twice and was not already accepted as a false alarm.
