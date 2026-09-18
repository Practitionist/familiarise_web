# Engineering log — 2026-09-18/19 — the requests and heat-map train

**Date:** 2026-09-18 to 2026-09-19 · **Issue:** #1703 · **PRs:** #1702, #1717, #1720, #1721, #1724 · **Scope:** the allocate heat map, the Requests tab, the request/approval money path, and the availability grid.

## What the user reported

Almost every click on the consultant's allocate heat map ended in an error. The handoff issue #1703 said the root cause had been "fixed" on an earlier revision of #1702, but that fix had never been verified on a fresh preview, and Sentry showed the failure was still live.

## Sentry evidence

The train's Sentry issues, read across the five PRs:

- **FAMILIARISE_WEB-4F** — `PrismaClientValidationError: Unknown argument cancellationPolicyId` inside `SchedulingService.createAppointments`, on almost every allocation of an unpaid request. This was the headline defect; see the root cause below.
- **FAMILIARISE_WEB-4A** — `timeout exceeded when trying to connect` from the connection pool inside `manualAllocate`'s transaction, the `PG_POOL_MAX=1` global-client-read-in-transaction deadlock. Fixed by threading `tx` into `findIdempotentAllocation`/`replayPartialCounts` before this train started; confirmed dead on the #1702 preview (seven Sentry sweeps, zero recurrences).
- **FAMILIARISE_WEB-4G** — a client-side `Unauthorized` on `POST …/validate` right after a cold-instance stall (~26–28 s), later root-caused as issue #1716: the lookup had not completed and `requireApiAuth()` read the incomplete result as "no session" rather than as a pending read.
- **FAMILIARISE_WEB-2V** — `Failed to fetch event slots`, HTTP 403 on the subscription allocate page. Reproduced and confirmed fixed during #1717 QA (case B10: `GET /api/scheduling/appointments?type=SUBSCRIPTION&…` now answers 200).
- **FAMILIARISE_WEB-4J** — a `fetchEventSlots` "Failed to fetch" reported as an error on an aborted navigation (an `AbortError` misreported), found during #1720 QA and sent back to the builder as a fix-round item.
- **FAMILIARISE_WEB-4K** — an expected 400 (an odd slot count) reported to Sentry as an error, found during #1721 QA and sent back to the builder as a fix-round item.

## Root cause

`createAppointments` wrote a single Prisma `data` object that mixed the checked relation form (`[relationField]: { connect }`) with the unchecked scalar foreign keys `cancellationPolicyId` and `organizationId`. Prisma validates a create against one of two generated input types, and one relation-style key is enough to select the checked shape, at which point every scalar key beside it is an unknown argument. The full mechanism — why `tsc` and the mocked jest suites never caught it, and the rule for spotting the same trap elsewhere — is recorded in [`engineering-log-2026-09-18-prisma-create-input-shape.md`](./engineering-log-2026-09-18-prisma-create-input-shape.md); this log does not repeat it.

## The five PRs

- **#1702** — the create-shape fix (fixes FAMILIARISE_WEB-4F), the typed `RESCHEDULE_STATE_CHANGED`/`ALREADY_ALLOCATED`/`SLOT_TAKEN` error-code family, one allocate handler behind the four PATCH routes, and an error-copy UX bundle (fail-closed reads, code-keyed toasts, canonical `?type` URLs).
- **#1717** — Requests tab and dashboard productionization: a real pager, the subscription singular-`appointment` fix, closing the self-approval bypass, plan-ownership checks on the detail PUT routes, consultee/consultant Home parity fixes, and the org-sessions strip on consultant Home.
- **#1720** — client-only UX pass on the allocate grid and the confirm dialog: dead-hour folding, a Today button and now-line, locale-derived time/zone labels, the hatched/dashed grid states, and the redesigned confirm dialog (sentence summary, viewer-zone dates, in-dialog success state).
- **#1721** — scale hardening: the grid rate limiter and Retry-After-aware poller backoff, the window-scoped change marker, 504-means-unknown copy, and a security pass (the 31-day window clamp, a fresh session read on the privileged grid view).
- **#1724** — the product model: `ConsultantProfile.bookingMode` (`INSTANT`/`REQUEST`), the `acceptingRequests` pause toggle and `maxOpenRequests` cap with their typed 409 refusals, the pay-link window cut from 48 to 24 hours with a 12-hour reminder, and consultant nudges for unallocated paid subscriptions at day 3/7/14.

Each PR's own body is the record of what shipped; this log adds only what the PR bodies do not say — the QA findings and the follow-ups.

## What QA found and fixed on each preview

- **#1702** (`qa-1702.md`, 7/7 PASS): FAMILIARISE_WEB-4F and -4A never recurred across seven Sentry sweeps on the release under test. QA surfaced FAMILIARISE_WEB-4G (filed as #1716) and a cosmetic discrepancy — the `RESCHEDULE_STATE_CHANGED` toast still rendered generic "Request changed" copy — left for the next PR's copy unification.
- **#1717** (`qa-1717.md`, 11/11 PASS): every case passed on first preview, including the timezone-parity check (Home and Appointments agree to the minute across two different profile zones) and the freshness badge. QA noted, for the next PR's benefit, that the dialog's genuine-conflict copy still needed a fixture whose time actually overlapped a confirmed occurrence.
- **#1720** (`qa-1720.md`, round 1: 2 outright FAILs, 1 PARTIAL, 1 new Sentry issue, rest PASS): the footer timezone label read from the browser zone instead of the profile zone with the two out of sync; the legend dropped three states (`thisEvent`, `rescheduling`, `outsidePeriod`) because `TimePicker.tsx` gated the legend on `sessions.length > 0` while a same-page cell was already painted in one of those states; the now-line could not be observed because "now" fell inside a folded dead-hour band; and FAMILIARISE_WEB-4J (above) was new. A fix round was sent back to the builder for all four.
- **#1721** (`qa-1721.md`, mostly PASS): the window-scoped ETag marker itself was correct, but the conditional-GET path never actually returned 304 on a matching `If-None-Match` — reproduced on preview and on production alike, filed as #1723 rather than fixed in this PR; class/webinar conflict rows were found to be nameless for every viewer (sent to the builder); and FAMILIARISE_WEB-4K (above) was new.
- **#1724** (`qa-1724.md`, 10/11 PASS, 1 PARTIAL→fixed): every settings, mode, pause/cap and reminder case passed. Case 8 (expiry notices) started PARTIAL: `cleanupAbandonedPayments` was claiming a lapsed pay-link before the notifying pass ever saw it, so the consultee got no notice. Fixed same day in `335150189` by routing both sweeps through one `fromIn: [APPROVED_PENDING_PAYMENT]` CAS (`expireLapsedPayLink`) so the notice rides whichever pass wins the race, pinned by running both sweeps in their real order over one fixture.

## Follow-up issues filed

- **#1715** — keyboard navigation for the allocate grid (roving-tabindex ARIA grid, arrow/Home/End/PageUp/PageDown, focus preserved across a poll re-render). Deliberately split out of #1720 because it is the largest single item and blocks nothing else.
- **#1716** — the cold-instance validate-call misread: a ~26–28 s stall on `getSession(true)` was read by `requireApiAuth()` as "no session" and answered 401, when the correct read is "the lookup did not finish." Root-caused during #1702 QA; the fix is structural (distinguish a failed lookup from an absent session) and is tracked separately from the allocate hotfix.
- **#1722** — acknowledge-fast-finish-durably for reschedule, cancel and allocate: the owner chose not to cut any transaction's time budget below the work it protects, so the structural fix is a 202-plus-status-URL pattern (or an `after()`-backed continuation) rather than a smaller budget. #1721 shipped only the "504 means unknown" copy and the pool-exhaustion Sentry tag; this issue is the mechanism.
- **#1723** — the conditional-GET 304 path on the availability grid never fires: a matching `If-None-Match` still gets a full 200 body, on preview and on production. The window-scoped marker itself computes the right tag; something between the marker and the response never completes the comparison. Reproduced with curl and node fetch, with and without a session cookie.
- **#1732** — a lapsed **subscription** pay-link misses the 24-hour path: `cleanupAbandonedPayments` only matches appointments with a tentative occurrence, and a subscription's placeholder Appointment has none before allocation; `cleanupExpiredApprovalPendingPayments` reads consultations only. The row is caught only by the 7-day `updatedAt` fallback in `expirePaymentPendingRequests`, which fires no consultee notice, so an unpaid subscription approval sits in `APPROVED_PENDING_PAYMENT` for a week, counting against the consultant's open-request cap, and then expires silently. Recorded during #1724 QA rather than widened into that PR.

## Owner steps still pending before release

- The `scripts/db/swap-occurrence-overlap-constraint.ts` sidecar-swap script (the live EXCLUDE-constraint change for the tombstone exemption added in #1721) has not been run against the shared project.
- A chaos run (`npm run test:chaos:api`) has not been dispatched against this train's combined changes.
- A Sentry alert rule for the pool-exhaustion tag #1722 added has not been created.
- `npm run novu:sync` has not been run, so the day-3/7/14 subscription nudge renders as the plain request sentence rather than the nudge-specific wording until the Novu template picks up the new payload branch.
