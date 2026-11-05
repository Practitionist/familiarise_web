# ADR: A class reallocation keeps a mid-checkout seat held

- **Status**: Accepted on 2026-11-05 by the owner. Ships in the pull request that adds this record, with a regression test and no runtime change.
- **Date**: 2026-11-05
- **Author**: Platform engineering
- **Related**: [A group-event room admits a seat only on a fulfilled entitlement](2026-11-02-group-room-fulfilled-entitlement.md), the booking skill's doctrine "Nothing that a Payment points at is ever deleted" (`.claude/skills/booking/SKILL.md`), issue #2528 ("Class reallocation re-seats HELD (mid-checkout) learners as CONFIRMED with no payment")

## Context

When an expert re-plans a class, the allocator frees the class's replaceable sessions and writes new ones. The learners enrolled in a class live only on `AppointmentParticipant`, so the allocator first collects every live seat holder (`HELD`, `CONFIRMED` or `ATTENDED`) from the rows it frees, and afterwards re-seats them on the new sessions as `CONFIRMED` with no payment link (`reconnectEnrolledUsers` in `lib/booking/allocation/commit/reconnect-enrolled.ts`).

The issue asked whether a learner who is in the middle of checkout, and so holds a `HELD` seat on a `PENDING` payment, could come out of a re-plan as `CONFIRMED` with `paymentId` null. Such a seat would pass the room gate's "confirmed seat with no payment" arm in `paidParticipant` (`lib/booking/participants.ts`) and let the learner attend without paying.

## Decision

The scenario does not reproduce in today's code, and the owner chose to pin that with a regression test rather than change the runtime. Five facts, each enforced in code, close it.

1. **A class has exactly one wrapper appointment.** `Appointment.classId` is `@unique` in `prisma/schema.prisma`, so every seat and every session of a class hangs off one `Appointment` row.
2. **A paid checkout writes the seat and its payment on that wrapper in one transaction.** `handleClassCheckout` (`lib/payments/checkout/handlers/class.ts`) records the learner's seat on the wrapper as `HELD`, and `writeCheckoutPayment` (`lib/payments/checkout/commit/payment-row.ts`) then creates the `Payment` with `appointmentId` set to the wrapper and stamps the seat's `paymentId`, both inside the checkout's transaction (`lib/payments/checkout/commit/index.ts`). A `HELD` seat on a gateway checkout therefore always comes with a `Payment` that points at the wrapper.
3. **A wrapper that a Payment points at is never deleted.** `Payment.appointment` is `onDelete: Restrict` in `prisma/schema.prisma`. Every appointment delete in `deleteExistingAppointments` (`lib/booking/allocation/commit/release-tentative.ts`) is `deleteMany({ where: { id, payment: { none: {} } } })`, so a payment that committed after the allocator's read still turns the delete into a zero-row answer. The full-delete branch also keeps any appointment whose payment count is above zero and strips only its replaceable sessions. Because the wrapper survives, the learner's seat row survives with it, and so do its status and its `paymentId`.
4. **The new sessions land on the same wrapper.** `createAppointments` (`lib/booking/allocation/commit/create-appointments.ts`) looks the wrapper up with `findFirst({ where: { classId } })` and attaches the new occurrences to it, so the re-plan never mints a second appointment for the class.
5. **Re-seating never overwrites a live seat.** `reconnectEnrolledUsers` calls `recordParticipants` (`lib/booking/participants.ts`), which inserts with `createMany({ skipDuplicates: true })` on the `(appointmentId, userId)` unique. The learner's existing row makes the insert a no-op. The revive step that follows moves only `CANCELLED` or `REFUNDED` rows, so a `HELD` row keeps both its status and its `paymentId`, and `paidParticipant` keeps refusing it until the capture confirms the seat.

### Worked example

A ten-session class is half delivered. Learner Asha opens checkout at 10:00, which writes her seat on the wrapper as `HELD` and a ₹2,500 `PENDING` payment pointing at the same wrapper. At 10:02 the expert re-plans the remaining sessions. The allocator runs the in-progress branch (`preservePastSlots`): it keeps the five delivered sessions, deletes the future ones that start more than 24 hours out, and leaves the wrapper alone because sessions remain and because Asha's payment points at it. It collects Asha as a live seat holder, writes the new sessions onto the same wrapper, and asks `recordParticipants` to seat her as `CONFIRMED`. The insert skips her existing row and the revive does not match a `HELD` row, so she is still `HELD` on her `PENDING` payment. The room keeps refusing her until her capture lands and confirms the seat, or until the hold lapses.

### How it is pinned

`__tests__/booking-algorithm/reallocation-keeps-held-seat.test.ts` drives the real `deleteExistingAppointments`, `createAppointments` and `reconnectEnrolledUsers` over an in-memory class world, once through the in-progress branch and once through the full-delete branch. Each case asserts that the wrapper and its payment survive, that the learner has exactly one seat row and it is still `HELD` on the same `paymentId`, and that `paidParticipant`, evaluated with `matchesWhere` from `__tests__/fixtures/mem-db.ts`, refuses the seat. The in-memory table enforces the `(appointmentId, userId)` unique only when a test opts in, so the other suites that use it are unaffected. Making `recordParticipants` overwrite a `HELD` row fails both cases.

## Consequences

- No runtime code changes. The comments in `release-tentative.ts` now state the `Restrict` foreign key and the in-WHERE payment guard instead of a cascade.
- Any future change to one of the five facts above, for example a second wrapper per class, a delete without the payment guard, or a re-seat that writes status onto an existing row, fails the regression test.
- A no-gateway rail never produces a `HELD` class seat: `handleClassCheckout` seats the learner as `CONFIRMED` when the checkout skips the gateway.

## Deprecated & Superseded Approaches

- **Comments that described `Payment.appointment` as `onDelete: Cascade`.** The foreign key is `Restrict`, so an unguarded delete of a payment-bearing appointment fails rather than destroying the payment. The comments in `release-tentative.ts` were rewritten to say so.
- **Guarding a re-plan delete with an earlier payment-count read alone.** The guard rides in the delete's own WHERE clause, because a checkout's payment can commit between the read and the delete.
