# Engineering log — 2026-09-19 — the Muse Spark booking sweep

**Date:** 2026-09-19 · **Issues verified:** #1583, #1589, #1591, #1592, #1599, #1600, #1672, #1673, #1674, #1729 · **PRs:** #1740 (money), #1741 (backlog sweep) · **Scope:** every booking and booking-money P0/P1 claim the Muse Spark audit raised.

## What was reviewed

Ten issues from the Muse Spark audit carried roughly 250 P0 and P1 claims touching booking. Each claim was checked against `dev` HEAD `1a9bddc34` in four separate read-only verification passes — one per subsystem cluster (moderation and CAS writers, sweeps and cron, request/pay-link/trial flows, and money) — rather than trusted from the audit's own text, because the audit predated #1554/#1638/#1695/#1682/#1687/#1713/#1721/#1724 and several of its claims were already stale before verification started. The four money items were re-verified a second time by hand at line level, since a misread there is the expensive kind of mistake.

## The verdict split

Across the roughly 250 claims: about 40% were legit and open (became PR-B or PR-M items, or a residual issue), about 25% were already fixed by one of #1554, #1638, #1695, #1682, #1687, #1713, #1721 or #1724 and needed no further work, about 15% misread the current code (`BS` in the verdict tables — a claim that named a mechanism the code no longer has, or never had in the shape described), about 20% were product or architecture calls rather than defects (`DECISION` in the tables), and none were found to have been incorrectly fixed by an earlier PR. The per-issue verdict tables with every item id live on #1583, #1589, #1591, #1592, #1599 and #1600.

## The four real money P0s, and where each was fixed

Only four items held P0 by the audit's own rubric once BS and DECISION items were excluded, and all four are money. All four were fixed in PR #1740:

- **A-P0-01** — the capture webhook's subscription arm read a stale pre-read of `subscription.status` and flagged `capturedAfterTerminal` only for `CANCELLED`, missing `REJECTED` and `EXPIRED` — money collected for a dead booking with no refund signal. Fixed in #1740 M1: a fresh in-tx read decides terminal-vs-live, and the APPROVED_PENDING_PAYMENT → APPROVED CAS moved from a raw `updateMany` to `transitionSubscriptionRequest`.
- **C-P0-01** — approval pay-links (consultation, subscription and trial) minted at the plan's raw pre-tax price, with `taxAmount` frozen at its schema default of 0, while the identical plan sold through direct checkout charged list price plus GST. Fixed in #1740 M2 and recorded in `docs/decisions/2026-09-19-pay-link-gst-parity.md`: the mint now derives through `deriveCheckoutAmount`, the same function checkout uses.
- **C-P0-03** — a whole-event refund (`refundWholeEventPayments`) threw for the entire batch if any one seat had already been partly refunded, instead of clamping per seat to its remaining refundable balance; a second admin call on an already-refunded event could double-cascade. Fixed in #1740 M3: `reverseClassMulti` and its caller clamp to each seat's `refundable_i`, and a fully-refunded repeat now answers 200 `{ alreadyRefunded: true, refunded: 0 }`.
- **C-P0-05** — the earnings healer's cohort (`SUCCEEDED` payment, no earnings row) did not exclude payments that were later refunded or lost a dispute, so a payment the platform had already given the money back on could still mint an earnings row. Fixed in #1740 M4: the cohort now excludes refunded and disputed payments, with one Sentry "expected" message per run reporting the excluded count.

## The mechanism clusters fixed in #1741

PR #1741 (the backlog sweep) carried fourteen isolated commits, one per spec item, covering the P1-and-below mechanisms:

- **CAS-bypass writers** (B1): moderation's occurrence release, auto-complete's four parent writers, and the no-show detector's occurrence release all moved from raw `updateMany` calls to the guarded `transition*` helpers, closing the gap where a moderation-cancelled occurrence stayed armed under the #1694 exclusion constraint because it carried no `deletedAt`.
- **Reschedule and withdraw** (B3, B4): the partial-subscription reschedule now takes a real row lock instead of a lockless count, and withdraw restores the request's ORIGIN status (read from the `BookingStatusHistory` row the reschedule itself wrote) instead of unconditionally restoring APPROVED — closing both a consultant-gate bypass (a never-approved PENDING request coming back APPROVED) and a payment bypass (an unpaid APPROVED_PENDING_PAYMENT request coming back APPROVED).
- **Pay-link CAS and trial re-mint** (B2, B7): the pay-link persist on all three request kinds is now a conditional `updateMany`, tombstoning an orphaned mint rather than leaving it live on the wrong row; a trial whose link was lost this way can be re-minted from the consultee's own read, under the appointment lock; trial expiry now tombstones the held appointment (`softCancelTrialAppointment`) and notifies the consultee, not just the status column.
- **One lapse path** (B5, closes #1732): `cleanup-stale-pending-consultations` — a second sweep CANCELling the same cohort `expire-stale-requests` EXPIREs — is retired entirely, and a subscription's lapsed pay-link now rides the same `expireLapsedPayLink` CAS-plus-notice helper a consultation's does.
- **Request-for-approval guards** (B6): the Zod edge refuses an off-grid start (`SLOT_NOT_ON_GRID`) or a too-soon start (`SLOT_TOO_SOON`), and the route validates both the consultee's own overlap and the co-host arm, not just the target consultant's calendar.
- **Ticker cadence** (B8, owner decision Q2): five booking sweeps — `expire-unpaid-trials`, `reschedule-proposals`, `appointment-reminders`, `tentative-occurrences`, `expire-stale-requests` — now ride the Netlify ticker at a 15-minute cadence instead of waiting on the hourly GitHub Actions schedule, with two of them (`appointment-reminders`, `expire-stale-requests`) on the 20-second timeout tier.
- **DEGRADED gaps** (B9): the blocklist's `/api/collaborators` entry (which matched no real route) is corrected to `/api/collaborations`, and six money-writing doors the list missed — payment recovery, recording purchase, overage order, a seat-removal DELETE, call join/end, and the `verify?sync=true` GET — are added.
- **Dead surfaces** (B10): the bespoke `unallocated/*` and `availability/[consultantId]` routes are deleted, and the legacy webinar `POST` answers a typed 405 instead of trusting a client-supplied `status`.
- **List and edge hygiene, and the checkout return path** (B11–B14): booking mutation routes read the session through the fresh, ban-aware helper; tombstoned appointments stay out of lists; the consultation checkout page returns through the same shared handlers the other three plan pages already use.

## Owner decisions Q1–Q7

- **Q1** — ship as two PRs, split by money-vs-plumbing: #1740 (PR-M, money-owned files only) and #1741 (PR-B, everything else), built in parallel against the same `dev` base.
- **Q2** — the five booking sweeps described above ride the Netlify ticker on a 15-minute cadence rather than a tighter one, because each sweep's per-row cost (a gateway round trip, an outbox stage) does not fit a 5-minute tick's budget on a cold instance.
- **Q3** — pay-link GST parity is tax-only: no discount codes, no referral credits on the approval rail yet. See `docs/decisions/2026-09-19-pay-link-gst-parity.md`.
- **Q4** — the enterprise-money defects (overage carve, seat-count leak, rollup filter, wallet self-serve) stay out of the booking money PR and become their own issue once #1683 and #1684, which touch the same files, land.
- **Q5** — the product proposals in #1672 (and its S1/S2 siblings #1673/#1674) that are not already answered by D1/D2/#1724/#1720 are bundled into a post-MVP product issue; none is a defect and none gates the MVP.
- **Q6** — the parent audit issues (#1583, #1589, #1591, #1592, #1599, #1600) are closed as superseded, each with its own verdict table rather than a bare "fixed" comment, so the per-item reasoning stays attached to the issue it was raised on.
- **Q7** — the `:00`/`:30` slot-start grid is enforced at the Zod edge (`SLOT_NOT_ON_GRID`), not left to the allocator's own re-validation alone.

## Follow-ups

- A themed booking-residuals issue (filed after merge) carries the P1/P2 mechanisms verified LEGIT/PARTIAL/DECISION but deliberately left out of #1740/#1741 by the money-vs-plumbing split or because they need a product call first — the accept-then-CAS window, reschedule idempotency, the release-only-reschedule contract question, and the CLASS partial-accept/refund-notice/rounding items among them.
- An enterprise-money issue (filed after merge) carries the overage-carve, seat-leak, rollup-filter and wallet-self-serve defects named under Q4, to be built as one PR once #1683 and #1684 land.
- A post-MVP product bucket (filed after merge) carries the S1/S2 proposals named under Q5.
- Reset-window schema items live on #1729.
- No-show product calls (the subscription-side no-show remedy, still undesigned) live on #1569.
