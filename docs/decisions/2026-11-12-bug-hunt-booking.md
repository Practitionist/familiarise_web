# ADR: The booking bug hunt — the agreed price of 1:1s and trials, published hours checked at the request door, a 1:1 that may cross midnight

- **Status**: Accepted (owner decisions, 2026-11-12). All four decisions and the smaller fixes are built on the branch that adds this record. The two new columns reach the shared database through the owner's ordered procedure in [docs/prisma/README.md](../prisma/README.md) (preflight, push, sidecars, assert), which runs two `ADD COLUMN` statements; nothing is backfilled.
- **Date**: 2026-11-12
- **Author**: Platform engineering
- **Related**: [The booking follow-up train](2026-11-12-booking-follow-up-train.md) (its decision 3 asked for a trace of what happens when a held booking outside the new hours is approved), [Booking v2 train B](2026-11-04-booking-v2-train-b.md) (the frozen subscription terms this extends), [Scheduling surfaces, feasibility before money, and booking correctness](2026-11-09-scheduling-surfaces-and-feasibility.md), [Schema reference](../booking/21-schema-reference.md), [Approval payments](../finance/10-money-in/05-approval-payments.md), [Trial sessions](../booking/09-trials.md)

## Context

A hunt through the booking code for places where two readers of the same fact could disagree found three. A 1:1 request or a trial read its price and length from the live plan, so an expert's plan edit changed what a buyer had already asked for. A request was never checked against the expert's published hours at the door, while a trial was. And the 1:1 rule that all slots lie on the same calendar day was judged in Asia/Kolkata for every host, so a session that straddled 18:30 UTC was refused on allocate, reschedule-accept and incident rebook even though the request door had accepted it. The owner decided each one on 2026-11-12.

## Decisions

1. **A 1:1 request and a trial keep the price they were requested at** (decided, built).
   - `Consultation` and `Trial` each gain `agreedPricePaise` (paise, `BigInt`). Null means "read the plan", which is every row created before the column. The sidecar CHECKs `consultation_agreed_price_valid` and `trial_agreed_price_valid` in `prisma/sql/check-constraints.sql` require a price that is not negative when set. Decision 4 explains why only the price is stored.
   - The price is stamped where the row is created: the request door (`app/api/scheduling/request-for-approval/route.ts`), the checkout consultation handler (`lib/payments/checkout/handlers/consultation.ts`), the legacy webhook creator (`createConsultation` in `lib/payments/webhooks/legacy-appointment-creation.ts`) and `bookTrialInTx` (`lib/trials/book-trial.ts`). A row that is still null is stamped by `freezeConsultationPrice` or `freezeTrialPrice` (`lib/booking/sold-terms.ts`), which the plan edit routes call inside the plan edit's own transaction before the plan row changes, and only when the price (or the trial price) is what changes.
   - Readers use `agreedConsultationPricePaise` and `agreedTrialPricePaise`: the approval pay-link price (`calculateAmount` in `lib/payments/operations/approval-payment.ts`), the free-request test (`SETTLED_CONSULTATION` in `lib/booking/approve-request.ts`), the allocator's settled check (`fetchEventData`) and the paid-consultation check in the consultation detail route.
   - **Example.** Priya Anderson requests Hannah Anderson's 1:1, listed at ₹500 (50,000 paise) for 60 minutes. Hannah then edits the plan to ₹2,000 and 30 minutes. When Hannah approves, Priya's link is ₹500 plus 18 % GST, which is ₹590 (59,000 paise), and the booking stays 60 minutes for every later move. The ₹2,000 and 30-minute terms apply to requests made after the edit.
   - **Before.** A pending request was priced from the plan's current price at approval, a live pay link was re-minted at the new amount, and a booking sold at 60 minutes could not be moved once the plan became 30, because the move required a window of the plan's new length.
   - **Enforced by** the two CHECKs for the shape; the price helpers for the readers that charge or decide on the price (the approval pay-link, the free-request test, the trial pay-link); the unpaid-trial expiry job's filter; and the freeze helpers for rows that predate the column. The legacy trial accept arm and the display-only readers listed under the leftovers still read the plan.
   - **Options considered.** Refusing plan price or length edits while the plan has open requests or upcoming bookings was rejected, because one pending request would freeze an expert's pricing. Keeping the re-price and telling the buyer was rejected, because the buyer agreed to one amount and would be asked to pay another.

2. **Published hours are checked at request only** (decided, built).
   - The request-for-approval door refuses a time outside the expert's published hours with 400 `OUTSIDE_AVAILABILITY`, which is the trial door's code and copy, inside its transaction (`assertSlotsStillPublished`).
   - Once held, a request keeps its time if the expert later shrinks their hours, for every approver. The manual allocator checks only new times against the published hours: it passes `heldIntervalStartsOf(existingAppointments)` to `ScheduleValidationService` as `heldSlotStarts` and runs `assertSlotsStillPublished` on the new times only. "Use requested times" (`useRequestedSlots`) treats every requested time as held and no longer takes an `override` argument. A host-organisation operator therefore gets the same answer as the expert.
   - **Example.** Priya requests Thu 12 Nov 2026, 10:00 to 11:00 IST, inside Hannah's hours, and the request is written. Hannah then ends her Thursday hours at 10:30 IST. Her approval still places 10:00 to 11:00 IST, and so does an operator's. A new time she picks by hand for the same request must still sit inside her published hours.
   - **Before.** The request door did not check published hours, and "use requested times" re-validated the requested times against them unless the caller held the expert-and-staff `override` flag, so a host-organisation operator could be refused a request the expert could approve.
   - **Enforced by** the check in the request door's transaction and by `heldSlotStarts` in the validator.
   - **Options considered.** Re-checking at approval with an explicit confirmation was rejected, because the expert would be asked to confirm against hours they had just changed on purpose. Leaving the door unchecked was rejected, because a buyer could request a time the expert never offered.

3. **A 1:1 may cross midnight** (decided, built).
   - The same-calendar-day rule for consultations is dropped on the server (`validateConsultation` in `utils/scheduling-engine/ScheduleValidationService.ts`) and in the browser (`validateConsultationSelection` in `lib/scheduling/intervalSelectionValidation.ts`). Contiguity and exact length still apply. This matches the earlier decision that a session across midnight is one session. The unused `validateDayBasedConsecutiveSlots` helper was deleted.
   - **Example.** A 1-hour 1:1 on Mon 16 Nov 2026 from 23:30 to 00:30 IST is two back-to-back atoms. It is valid on every door.
   - **Before.** The day was judged in Asia/Kolkata for every host, so a session straddling 18:30 UTC was refused on allocate, reschedule-accept and incident rebook while the request door accepted it.
   - **Enforced by** the two validators above; the exact length is the booked session's (decision 4).
   - **Options considered.** Judging the day in the host's zone was rejected, because it keeps a rule whose only purpose was already served by contiguity. Keeping India time was rejected, because it refuses valid sessions for every host outside that zone.

4. **Only the price is stored; the length is read from the session the booking holds** (decided, built, 2026-11-12; it replaced a first version that stored both).
   - The length a 1:1 or a trial was sold at is `bookedSessionMinutes` (`lib/appointments/occurrences.ts`): the live session's length, else the latest session row's, and the plan's length only when the booking has no session row at all. It feeds the allocator's consultation config, the validate route, the allocate page, the requests inbox, the reschedule pickers and the trial reschedule confirm (`confirmTrialProposal`).
   - **Why.** A request and a trial hold a time from creation, so the held session already records the length. A stored copy would be a second value that nothing keeps in sync. A subscription keeps its stored `sessionMinutes` because its sessions are placed later, so no session exists to read at purchase. The price is different: a request made at the request door has no payment row, so nothing else records what the buyer saw. Webinar and class seats need neither, because they are paid at checkout, where the payment row carries the amount, and the time belongs to the event.
   - **Example.** A buyer's 1:1 is held for 60 minutes and the plan then becomes 30 minutes. The booking stays 60 minutes after the edit with no stored copy, because the held session is 60 minutes long.
   - **Naming.** `agreedPricePaise` was chosen over `priceAtRequestPaise` and `soldPricePaise`: the request door has not sold anything yet, and the buyer agrees to the price at request rather than merely seeing it at that moment.
   - **Enforced by** `bookedSessionMinutes` being the only reader of a 1:1's or trial's length, and the CHECKs of decision 1 for the price.
   - **Options considered.** Keeping all four columns (a stored price and length on each model, one field per term like `Subscription`) was rejected, because the length copy has no owner that keeps it equal to the session. Keeping the price on `Consultation` only was rejected, because the trial pay-link re-mint and the unpaid-trial expiry job would keep reading the plan's current trial price.

## Smaller fixes

- **A paid approval ignores deleted sessions.** The flip from tentative to confirmed in the consultation and subscription approval routes carries `deletedAt: null`, so a tombstoned session is not revived.
- **An incident rebook holds the buyer's own calendar when the buyer is also an expert.** `rebookIncidentRemedy` takes one all-or-nothing `lockSlotBatch` over the expert's and the buyer's profiles, which makes rule 2 of `lib/booking/AGENTS.md` true for this door too.
- **An approval-lock outage answers the typed 503.** Both approval routes answer through `approvalLockRefusal` (`lib/booking/request-route-guards.ts`): a `BookingLockUnavailableError` answers its own 503 and code; contention with another approval still answers 409.
- **One 24-hour boundary.** The reschedule release side and the webinar re-time (`retimeWebinar`) use `isTooSoonFor`, so a start exactly 24 hours away is refused there as elsewhere.
- **The learner profile delete is guarded like the expert's.** `DELETE` in `app/api/user/consultees/[id]/route.ts` is owner-only (STAFF and ADMIN get 403). It refuses with 400 `ACTIVE_APPOINTMENTS_BLOCK_DELETE` while the buyer has anything live (`checkConsulteeActiveBookings` in `app/api/user/consultants/utils/consultee-bookings.ts`: requests, subscriptions, trials, open reschedules and upcoming group seats), and with 400 `MONEY_HISTORY_BLOCKS_DELETE` when the buyer has any payment, pointing them to whole-account deletion. The same route's `PATCH` no longer wipes `skillsToDevelop` when the field is omitted. Before, any staff user or the buyer could hard-delete the profile, which cascaded their unpaid requests and reviews, with no checks.

## Consequences

- A plan edit never changes what a pending request or a trial costs or how long it is. A new reader of a booking's price goes through `agreedConsultationPricePaise` or `agreedTrialPricePaise`, and a new reader of its length goes through `bookedSessionMinutes`.
- A request can sit partly outside the expert's current published hours. That is intended; the expert's remedy is to move or decline it.
- The owner applies the two `ADD COLUMN` statements and the two CHECKs through the ordered procedure in [docs/prisma/README.md](../prisma/README.md) (preflight, push, sidecars, assert) before the code is released. No backfill is written: null rows read the plan, so existing requests keep today's behaviour until a plan edit stamps them.

**Known leftovers.**

- `rescheduleReleasable` (`lib/booking/reschedule-proposals.ts`) and `lib/booking/class-retime.ts` still allow a start exactly 24 hours away.
- The legacy trial accept arm (`app/api/trials/[trialId]/route.ts`) and the unpaid-trial expiry job (`scripts/trials/expire-unpaid-trials.ts`) still read the plan's current trial price or length.
- Several display-only readers still show the plan's current price or length for a booking.
- Unlike the expert route, the learner delete has no soft delete for a buyer with money history, because `ConsulteeProfile` has no `deletedAt`; the buyer is sent to whole-account deletion instead.
- Staff and admins can still read the whole user record and edit a learner profile through this route's `GET` and `PATCH`, and can create one through `POST`. The owner has not yet decided that.
- `app/api/user/[id]/route.ts` keeps its own narrower active-booking check for account erasure.

## Deprecated & Superseded Approaches

- **A pending 1:1 request or trial priced and sized from the live plan.** Replaced by `agreedPricePaise` and the booked session's length. A first version stored the length as `sessionMinutes` too; it was dropped (decision 4).
- **An unguarded learner profile delete.** Any staff user or the buyer could hard-delete the profile with no checks; replaced by the owner-only, guarded delete.
- **A same-calendar-day rule for 1:1s, judged in Asia/Kolkata.** Replaced by contiguity and exact length (`validateSameDaySlots` on the server and `validateDayBasedConsecutiveSlots` in the browser helpers are gone).
- **An unchecked request door, with the requested times re-checked at approval unless the expert or staff passed `override`.** Replaced by one check at the door and `heldSlotStarts`.
