# Reporting: verdicts, finding types and the report template

The goal of a QA run is a list the developers can fix from without asking you anything. Report what you saw, with evidence, even when it's small. Silence about a problem you noticed is the worst outcome.

## 1. Case verdicts (one per case)

| Verdict | Meaning |
| --- | --- |
| ✅ **PASS** | Every expectation held on every surface you checked, and you found nothing worth reporting. |
| 🟡 **PARTIAL** | The core outcome held, but at least one expectation failed or one surface disagreed. List which. |
| ❌ **FAIL** | The core outcome didn't happen, or happened wrongly (wrong money, wrong time, wrong state). |
| ⚠️ **UNEXPECTED** | Something happened that the case didn't predict (a different code, an extra side effect, a state the docs don't describe). Not necessarily wrong; describe it and say why it surprised you. |
| ⛔ **BLOCKED** | You couldn't set up or run the case. Give the reason (fixture write declined, no gateway, missing feature, upstream FAIL). |
| 🔁 **NEEDS-OWNER-RUN** | The case needs a background job or a local drill. Give the job name, the precondition rows and the verification SQL. |
| ⏭️ **NOT RUN** | You ran out of time or budget. |

A case with any FAIL-level finding is FAIL, even if most of it passed.

## 2. Finding types (zero or more per case)

Tag every finding with one type. These go in addition to the verdict.

| Type | What to report | Example |
| --- | --- | --- |
| **BUG** | Wrong behaviour against the expected result. | Cancel 30 h ahead refunded 50% instead of 100%. |
| **INCONSISTENCY** | Two surfaces, or a surface and the DB, disagree. Name both sides and both values. | Consultee list says "Scheduled", consultant list says "Pending"; DB `SCHEDULED`. |
| **FALSE-INFO** | The UI states something untrue: a wrong number, date, zone, count, refund amount, policy or promise. | Tray says "3 of 3 this week" when the plan allows 2. |
| **COPY / AI-SLOP** | Generic, padded, robotic or meaningless text; raw enums, cuids, paise or ISO timestamps shown to users; inconsistent terms for one thing; placeholder or lorem text; "Something went wrong" with no next step. | "Your journey awaits! Seamlessly elevate your learning experience." on a refund screen. |
| **MISSED-OPPORTUNITY** | The screen had a chance to tell the user something useful and didn't: why an action is disabled, what happens next, the deadline, the refund they'll get, the other party's local time, what to do after an error. | Reschedule button disabled with no reason; cancel dialog doesn't show the refund before confirming. |
| **ERROR-HANDLING** | A refusal with no message, the wrong message, a message that blames the user for a server fault, a developer message shown to a user, or a 500 where a typed 4xx belongs. | 409 `PLAN_WEEK_FULL` rendered as "Error 409". |
| **CONSOLE-ERROR** / **CONSOLE-WARNING** | Anything in `list_console_messages` at error or warning level. Quote it with the page. | `Warning: Each child in a list should have a unique "key" prop` on the allocate page. |
| **NETWORK-ERROR** | A failed or unexpected request: 4xx you didn't cause, any 5xx, duplicate requests, a request that should have been idempotent but wasn't, very slow responses (> 3 s). | Two `POST /api/checkout` for one click. |
| **DATA-INTEGRITY** | A DB state that breaks an invariant: overlapping sessions for one host, counts that don't add up, orphan rows, money that doesn't reconcile, an illegal status transition. | Two non-deleted occurrences for H1 overlapping at 18:00. |
| **SECURITY / AUTHZ** | A persona sees or changes something it shouldn't, or a guard exists only in the UI. | B2 can open B1's reschedule page by URL. |
| **A11Y** | Keyboard trap, missing focus ring, unlabelled control, label-in-name failure, contrast below AA, colour as the only signal. | Grid cells unreachable by keyboard. |
| **DESIGN** | Layout, hierarchy, spacing, truncation, overflow, responsive breakage. | Tray overlaps the grid at 1280 px. |
| **PERF** | Slow page (> 3 s to interactive), janky interactions, repeated refetching. | Allocate page refetches availability on every hover. |
| **DOC-DRIFT** | The product and a doc or skill (`docs/booking/`, `.claude/skills/booking/`) disagree. Quote both. | Doc says 24 h free cancel, UI enforces 48 h. |

## 3. Severity (for BUG, INCONSISTENCY, FALSE-INFO, DATA-INTEGRITY, SECURITY, ERROR-HANDLING)

- **P0** — money wrong or lost, data loss or corruption, security hole, a user charged without a booking or booked without paying.
- **P1** — a journey can't be completed, or a user is told something false about time or money.
- **P2** — wrong or missing copy, confusing UX, inconsistency that a user could misread.
- **P3** — cosmetic.

## 4. Evidence rules

- **Screenshot** every FAIL, PARTIAL, UNEXPECTED, FALSE-INFO, DESIGN and A11Y finding. Save as `temp/qa-shots/<run>/<caseId>-<n>.png`.
- **Network:** method, path, status, JSON `code`, and relevant headers (`Idempotency-Key`, `Idempotent-Replay`).
- **Console:** messages at error and warning level, or "clean".
- **SQL:** the query and the rows (ids, statuses, UTC times, paise). Convert paise to rupees in your prose.
- **Copy:** quote verbatim, in quotes. Don't paraphrase the text you're judging.
- **Times:** give every time as `local (zone) = UTC`, for example `18:00 IST = 12:30Z`.

## 5. Per-case block

```
### <CaseID> — <title>
**Verdict:** ✅ PASS | 🟡 PARTIAL | ❌ FAIL | ⚠️ UNEXPECTED | ⛔ BLOCKED | 🔁 NEEDS-OWNER-RUN | ⏭️ NOT RUN
**Personas / zones / viewport:** H1 (IST) + B2 (Europe/London) · 1440×900
**Steps run:** 1… 2… 3…
**Expected:** …
**Actual:** …
**Surfaces checked:** consultant appts ✅ · consultee appts ✅ · bell ❌ (no notification) · staff ✅ · DB ✅
**Findings:**
- [BUG P1] …
- [MISSED-OPPORTUNITY] …
- [COPY / AI-SLOP] "…" on /dashboard/…
**Evidence:**
- Screenshot: temp/qa-shots/…
- Network: POST /api/… → 409 PLAN_WEEK_FULL
- Console: clean
- SQL: SELECT … → …
**Suspected area:** <file / route / function, if obvious>
**Fixture ids created:** … (cleanup: done / left, why)
```

## 6. Folder summary and final report

At the end of each folder, write a summary block:

1. a table of every case with its verdict and finding count;
2. counts per verdict and per finding type;
3. the P0 and P1 list first, each with a one-line repro;
4. NEEDS-OWNER-RUN cases with the job name and verification SQL;
5. the fixture ledger with cleanup status;
6. Sentry and Netlify-log events seen (expected refusals vs findings);
7. **cross-surface matrix**: for each journey, which surfaces agreed and which didn't;
8. **copy log**: every piece of user-facing text you judged as slop, false, or unhelpful, with its route;
9. **doc drift log**.

The final report (all folders) repeats items 1–3 for the whole run and ends with a ready-to-paste `## PR comment` section (title "Booking QA round N", commit under test, case table, P0/P1 list, screenshot links on the `qa-artifacts` branch in the `?raw=true` form, cleanup list). The coordinator posts it; you don't.

## 7. Routing

- Caused by the PR under test → a FAIL in the case table, for the main agent.
- A real defect outside the PR's scope → the report's **Out-of-scope bugs** section with a recommended fix.
- Presentation-only nit outside the case → append to `temp/dashboard-audit.md` (see `.claude/agents/qa-preview.md`).
