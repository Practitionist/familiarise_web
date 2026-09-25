# ADR: class-series money rules

- **Status**: Accepted
- **Date**: 2026-09-25
- **Part of**: the 2026-09-20 booking + money train, PR-1 (#1821), PR-2 (#1820)
  and PR-3, closing #1780 and #1771.

## Context

A class is sold as a batch of sessions, one `Class` row per run, checked out
once and paid once. Before this train the money rules around that purchase
were thin in several places at once: a whole series refunded at one flat
tier regardless of how many sessions a seat had actually held, a host
cancelling a single session had no defined recovery path for the seat that
missed it, a credit-funded seat got nothing back on a self-initiated leave
because the refund door only knew how to move cash, and there was no
console for an operator to run any of these rules by hand when the
automatic path could not reach a case (a payment gateway outage, a learner
who cannot make a scheduled make-up, a seat that needs a partial rather
than a full credit return). #1780 named nine rules to build; #1771 named
the console to run them from. This ADR is the single place that states what
was decided, because the rules touch checkout, cancellation, the class
lifecycle and the ops console at once, and no one file previously held them
together.

## Decision

### 1. Upfront payment, with an EMI switch at checkout

A class seat is paid in full at purchase — there is no per-session billing
and no deferred plan. The one financing option offered is a bank EMI split
on the card network's own instalment rails, shown by Razorpay Checkout
itself rather than modelled in our schema. It sits behind
`ENABLE_CHECKOUT_EMI` and only appears at or above `EMI_MIN_PAISE`
(₹3,000): below that amount an instalment plan is not worth the buyer's
interest cost, so the option is hidden instead of offered and declined.

### 2. The refund window lives on the listing, snapshotted onto the seat

`ClassPlan.refundWindowHours` and `WebinarPlan.refundWindowHours` (24 to
168 hours; unset means 24) set how long before a session starts a learner
may leave and be refunded. The window is copied onto
`AppointmentParticipant.refundWindowHours` at the moment of purchase, so a
host who tightens or loosens the window later only changes the terms for
seats sold after the edit — a buyer's terms are fixed at the moment they
paid.

### 3. Pro-rata exits: the unit is the seat's own paid amount, not the plan price

When a seat leaves mid-series, the refundable unit is
`floor(seat.amount / heldCount)`, where `heldCount` is the number of the
series' live sessions that start after the seat's own `createdAt` (a
mid-series joiner who buys after four of eight sessions have already run
counts four, not eight). The unit is computed once, in
`lib/booking/class-series.ts`'s `seatLedger`, and every other rule that owes
a seat money — the host-cancel sweep, skip-a-make-up, and a series-wide
cancellation — reads the same number. The rounding cuts both ways, and
precisely so. Every per-session amount (the host-cancel sweep,
skip-a-make-up, an operator's credit return) pays the floored unit, so each
one can be up to one paisa less than an exact division, and that remainder
stays with the platform. A series-wide cancellation instead refunds
`amount − unit × delivered`, which hands the whole remainder back, so at the
series level the buyer is never short.

### 4. A host moving a session waives that session's window

If a seat's next live session has `AppointmentOccurrence.movedAt` later
than the seat's own `createdAt` — the host rescheduled it after the learner
bought in — the refund-window refusal is waived for that session. A webinar
seat leaves with a full refund; a class seat's leave quotes that one session
at 100% regardless of how close it is to the new start time. `movedAt` is
stamped only on an actual time change (an in-place edit, a reschedule's
release-and-reinsert, or a re-plan that recreates a row at different times
for the same ordinal); a re-plan that recreates a row at the same times
stamps nothing, so an unmoved session still enforces its window.

### 5. A host-cancelled session gets 14 days for a make-up, or an automatic refund

The host cancelling one class session stamps `hostCancelledAt` on that
`AppointmentOccurrence` and leaves it in place — it is never deleted,
because delivered and cancelled sessions must both stay countable against
the series. The host then has 14 days to schedule a make-up at the same
ordinal (a partial unique index makes a second concurrent make-up
impossible). If the 14 days pass with no make-up in place, the
`settle-cancelled-sessions` sweep refunds every seat that held the session
one unit, keyed `occ:<occurrence>:pay:<payment>`, and stamps
`seatsSettledAt`.

### 6. A learner may skip a make-up and take the refund early

A learner is never obliged to wait for the sweep: while a scheduled
make-up has not yet started, the seat holder may refund that one unit
immediately through the same idempotency key the sweep would eventually
use, so the two paths can never both pay out for the same session.

### 7. A series cancellation refunds only what was never delivered

Cancelling the whole series refunds each seat `amount − unit ×
deliveredHeld`, where `deliveredHeld` counts only the sessions that seat
actually held and that completed. A seat that attended everything up to
the cancellation keeps nothing refunded beyond what it did not receive; a
seat that joined late and attended nothing yet is refunded in full.

### 8. The exit right trips at three misses or a quarter of the series

A learner holding a seat may leave with every undelivered session refunded
in full once the series has accumulated three host-cancelled sessions, or a
quarter of its total sessions, whichever comes first. Misses are host
cancellations only for now — no-shows and outage voiding are deferred (see
Deferred, below). The first cancellation that crosses the threshold writes
one `class-reliability:<classId>` `SystemEvent` for ops and notifies every
seat holder once; an operator may clear the flag from the console, and a
further host cancellation after that clear re-trips it, because a cleared
class can still go on to earn a second flag.

### 9. Every seat's ledger is independent

Nothing about one seat's leave, refund or exit right changes another seat's
numbers. `seatLedger` is computed per participant row from that row's own
`createdAt`, amount and refund history; a mid-series joiner and a
day-one buyer in the same class can be owed different units for the same
cancelled session, and that is intended, not a rounding artefact.

### 10. Credit-funded seats: automatic in full, partial only through ops

A seat paid for with referral credit restores in full automatically when
its leave or the series cancellation covers the whole remaining balance —
the credits ledger only knows how to reverse a usage row completely. A
restore of fewer sessions than that — "return 3 of the 8 sessions this
seat paid for in credits" — has no automatic path, because the credits
rail cannot express a partial reversal on its own, so it is an ops-only
door: `restoreClassSeatCredits` writes a ₹0 `Refund` row under the caller's
idempotency key and reverses the booking's credit journal pro rata, leaving
the seat live and the usage row partially consumed for any further return
to build on.

### 11. Every rule has a manual door, and every door is audited

Each of the automatic rules above has a console equivalent for the case
the automation cannot reach: a lock that never clears, a gateway that is
down, a learner who calls in instead of clicking skip. Every console
mutation requires a reason and writes exactly one `OpsActionLog` row —
who, as which role, on which surface, did what to which target, and why —
in the same transaction as the mutation itself where the mutation is
transactional. The doors split by blast radius, not by convenience:
cancelling a session for the host, granting a make-up (including an
ops-only bypass of the 14-day window, itself reason-gated), clearing or
re-flagging the reliability flag, and leaving a note are staff actions
(`classSeries.support`), because none of them moves money. Skipping a
make-up, cancelling the whole series with refunds, and the credit and cash
refund doors are admin-only (`classSeries.money`), because every one of
them does.

## Consequences

The refund window, the pro-rata unit and the exit right now compose
instead of each living in its own file with its own rounding: a seat's
number is always `seatLedger`'s number, whether the money moves through
the learner's own leave, the 14-day sweep, a skip, a series cancellation or
an ops door. The credit rail's all-or-nothing restore is no longer a dead
end for a partial return — it is a documented gap with a manual door,
rather than a silent refusal. The reliability flag is no longer a
fire-once artifact that goes stale the moment an operator clears it; it
answers the question "should this class be flagged right now" every time a
session is cancelled.

## Deferred

- **No-shows and outage voiding** as their own kind of miss, alongside host
  cancellations, are out of this train and tracked in #1569 — the session
  outcomes register that decides what the system records and what the
  support terminals promise for a dropped call, a slow network or a group
  shape.
- **Late-join pricing and batch presentation** — pro-rata pricing for a
  learner who joins after a series has started, and how batches are shown
  and closed to new enrolment — are filed as their own issue, #1819, and
  are a separate PR after this train. Until then, checkout keeps today's
  full-price late join, and decision 3's per-seat unit derivation is the
  exit-right safety net for a mid-series joiner.
- **A minimum batch size** before a class is guaranteed to run is post-MVP,
  tracked in #1745.
