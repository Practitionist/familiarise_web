# Engineering log — 2026-09-25 — class batches and late join

**Date:** 2026-09-25 · **Issue:** #1819 · **Scope:** option B of the design (late join at a pro-rata price, with the host cutoff defaulting to session 1), the seat's `sessionsPurchased`, the late joiners' recordings toggle and the batch presentation. The branch builds on PR #1832 because both change the class ledger and its refund unit.

## What changed

Each item below was its own commit.

- **L-1, schema.** `ClassPlan.lateJoinUntilSession Int?`, `ClassPlan.lateJoinersGetPastRecordings Boolean @default(false)` and `AppointmentParticipant.sessionsPurchased Int?`. All three are additive and nullable or defaulted, so no backfill is needed.
- **L-2, checkout.** `classEnrolmentFrom` (`lib/booking/class-enrolment.ts`) decides whether a batch is open and what a join costs. The quote and the booking transaction both call it; a closed batch refuses with `ENROLMENT_CLOSED`, and a quote that went stale because a session started refuses with `CLASS_PRICE_CHANGED`. The seat stores `sessionsPurchased`, and the consumer tax invoice names the sessions bought.
- **L-3, refund unit.** `seatLedgerFrom` uses the stored `sessionsPurchased` as its held count, and every caller (seat leave, exit right, series cancel, make-up skip, missed-session settle, credit restore and the ops series view) passes it through.
- **L-4, earnings.** No change was needed. `createEarningsFromPayment` splits `Payment.originalAmount`, which `deriveCheckoutAmount` sets to the pro-rated base.
- **L-5, recordings.** `lib/stream/late-join-recordings.ts` hides a batch's recordings of sessions that started before the viewer's seat, unless the listing allows it, in the class recordings list, the learner's recordings list and the single-recording read.
- **L-6, host settings.** The class editor's Sessions section gains the two settings, and the crud-with-plan route refuses a cutoff past the plan's last session.
- **L-7, presentation.** `deriveBatchCards` (`lib/booking/batch-cards.ts`) feeds the explore page, the checkout header and the host's class list. `fetchClassPlanDetail` orders batches by their first session.

## Findings that contradicted the design

The design counted `remaining` as the live, non-tentative sessions that start after now. A session released for rescheduling is stored as a tentative `RESCHEDULED` row, so that count would drop it and close enrolment before session 1 of a batch whose host is moving one session. The derivation therefore counts `remaining` as the plan's total minus the sessions that have started, which gives the same answer in every other case. A cancelled session in the past counts as started unless its make-up is still ahead, so a late joiner never pays for a session that will not run for them (a CodeRabbit finding).

The host's class list (`components/collaborators/ScheduleSummaries.tsx`) still read the pre-#1554 `appointments` array while the API returns one `appointment`, so it could not render a class at all. Moving it onto `deriveBatchCards` fixed that shape as well.

## Deferred

A fixed weekly slot per batch, a minimum batch size, a waitlist on a full batch, cloning a batch, and who sets the late-join cutoff on an org-curated listing are left to #1745. The enterprise engagement meter still counts every session of the batch for an org-funded late joiner; with the default cutoff this never differs from the sessions bought.
