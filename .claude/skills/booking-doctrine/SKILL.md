---
name: booking-doctrine
description: The non-negotiable invariants of this repo's booking subsystem — status CAS transitions, soft-delete-only, refund front doors, lock namespaces, SQL sidecars, org scoping, and how to test it. Load when working on booking, appointment, slot, reschedule, cancellation, refund, or maintenance-freeze code — anything under lib/booking/, lib/appointments/, utils/slotAllocation/, lib/payments/operations/, or app/api/appointments|bookings|checkout.
---

# Booking Doctrine

Seven rules govern every change in this subsystem. Each has been violated at
least once, and each violation cost real money or real bookings — the issue
numbers are the receipts. Verify against these before writing code, and treat
any diff that breaks one as wrong until proven otherwise.

## 1. All status writes go through the CAS transition helpers

Every booking status write goes through `lib/booking/transitions.ts`
(`transitionConsultationRequest`, `transitionSubscriptionRequest`,
`transitionWebinarEvent`, `transitionClassEvent`,
`transitionRescheduleRequest`) — never a raw `update`/`updateMany` on a status
column. The allowed-from set is baked into the UPDATE's WHERE clause, so an
illegal transition — a capture webhook racing a cancel, a stale tab approving
a cancelled request, a double-submitted decline — matches **zero rows** instead
of corrupting state. The WHERE clause IS the state machine; app-level
pre-checks are only friendly error text. A matched count of 0 throws
`IllegalTransitionError` → map it to 4xx, never swallow it. Doctrine:
`docs/enterprise/70-design-decisions/13-postgres-native-concurrency.md`; the
enterprise sibling is `lib/enterprise/transitions.ts` (#836, #837, #838).

## 2. Nothing is deleted

Bookings soft-cancel. Slots carry `completionStatus`
(SCHEDULED/COMPLETED/UNVERIFIED/CANCELLED/RESCHEDULED) and `deletedAt`
tombstones; reschedule flips replaced slots to RESCHEDULED and re-confirms them
in place; live-slot reads filter dead rows rather than expecting them gone.
Above all: **never delete an appointment a `Payment` row points at** — a trial
cancellation once hard-deleted the appointment and destroyed the Payment row
with it (#1074, PR #1074). The slot is freed by status alone. If you think you
need `delete`/`deleteMany` on Appointment/SlotOfAppointment, you are almost
certainly wrong — reconcile in place (see `replaceContiguousSlotRun`, which
survives Stream `MeetingSession`/`Recording` FKs precisely by not deleting).

## 3. Refunds have exactly two front doors

All refunds go through `refundBookingPayment`
(`lib/payments/operations/booking-refund.ts`) for one booking, or
`refundWholeEventPayments` (`lib/payments/operations/event-refunds.ts`) for a
whole webinar/class — never a raw `createRefund` call. The front doors exist
because there are three rails and only they split them correctly:

- **Gateway** intents (`pi_`/`cs_` from Stripe, `order_`/`pay_` from Razorpay)
  → the two-phase gateway refund in `refundPayment`.
- **Internal org-funded** intents (`org_wallet_`/`org_invoice_`/`org_license_`,
  detected by `isInternalFundedIntent`) → in-ledger reversal only; a gateway
  call on these dies on UNKNOWN_GATEWAY and, historically, silently reversed
  nothing (#1003, #1020).
- **`free_`** intents (`Payment.amount === 0`, credits-covered) have no
  refundable balance — callers filter them out upstream on `amount > 0`.

## 4. One lock namespace per atom

Distributed lock keys are minted in ONE place — `utils/appointmentlock.ts` —
and a given atom has exactly one key shape. Slot atoms lock under
`slot-booking:<consultantProfileId>:<startsAt>`; the consultee side is
`consultee-booking:<userId>`; events are
`event-checkout:<type>:<eventId>`; trials `trial-slot-booking:…`; allocation
`auto-allocate:<consultantProfileId>[:scope]`. Never mint a new key shape for
an atom that already has one — two names for one atom is no lock at all.
Global lock order (a total order ⇒ deadlock-free): **event/consultant →
consultee → slot**. The consolidation of the remaining slot-atom callers onto
these namespaces lands with train PR 1 of #1169.

## 5. Constraints Prisma can't express live in sidecars

The correctness backstops — the `slot_no_confirmed_overlap` GiST exclusion
constraint, the CHECK constraints, the ledger triggers — are NOT in
`schema.prisma`. They live in `prisma/sql/` (`check-constraints.sql`,
`ledger-triggers.sql`) and are applied **after** a schema push by
`npm run db:sidecars` (`npm run db:push` chains it automatically). Never
assume they are present on a database you did not push to with the full
chain, and never treat "Prisma schema is up to date" as proof the sidecars
are. A 23P01 from the exclusion constraint is the backstop working — surface
it as 409, do not "fix" it away.

## 6. Org scoping is explicit on every list

Personal surfaces pin `organizationId: null` — both arms, consultee-side and
consultant-side; org surfaces scope by the org id, and the org arm includes
sessions the org **funded** into another host's event
(`payment: { some: { organizationId } }`), not only sessions it hosts. The
single source of truth is `lib/api/scope/parse.ts` (+
`lib/api/scope/list-appointments.ts`); never hand-roll an org filter. Org
lists are metadata-only by design — ADR 20 (`docs/enterprise/
70-design-decisions/20-org-visibility-into-member-sessions.md`): an org sees
that a session happened, never its content, and there is deliberately no
drill-in from the org appointments table.

## 7. Test against a running app, not the shared DB's schema

Verification is a background dev server plus mock-data scripts and
mock-payment checkouts (`isMockPayment: true`) — never `prisma db push`
against the shared dev database, which other branches depend on. The jest
suites live under `__tests__/booking-algorithm/` and `__tests__/payments/`;
the agent-run E2E corpus is `prompts/booking-algorithm-tests/`. For
concurrency claims, the real-API chaos suite and its runbook are at
`docs/enterprise/50-operations/07-chaos-test-runbook.md` — a lock or CAS
change is not "verified" by unit tests alone.
