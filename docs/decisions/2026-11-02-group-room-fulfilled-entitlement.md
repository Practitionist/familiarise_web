# ADR: A group-event room admits a seat only on a fulfilled entitlement

- **Status**: Accepted on 2026-11-02 by the owner. Ships in the pull request that adds this record.
- **Date**: 2026-11-02
- **Author**: Platform engineering
- **Related**: [`resolveMeetingAccess` returns what it loaded](2026-08-13-meeting-access-returns-what-it-loaded.md), [Video implementation](../stream/05-video-implementation.md), [Chat and video system HLD](../start-here/06-chat-and-video-system-hld.md), issue #2519, the review finding on #2502 ("require a paid seat to enter a group room")

## Context

A webinar or class room opens on the attendee's `AppointmentParticipant` row alone, because a group event has no per-buyer booking status to check. `resolveMeetingAccess` (`lib/meetings/access.ts`) asks one question of that row through `paidParticipant` (`lib/booking/participants.ts`). Before this record the predicate admitted two shapes:

1. a seat whose status is `CONFIRMED` or `ATTENDED`, whatever its payment says;
2. a `HELD` seat whose payment is `SUCCEEDED`.

Both shapes admit people who did not buy a seat.

- **A captured but rejected payment (the #2502 review finding).** `SUCCEEDED` records that the gateway captured money. It does not say the money bought anything. `handlePaymentSuccess` (`lib/payments/webhooks/handlers.ts`) stamps `SUCCEEDED` on a capture it refuses: an amount mismatch, a capture after the hold was released, a full event, a lapsed trial, a double-booking loser, or metadata it cannot read. In each case it parks the cash as an `UNAPPLIED_RECEIPT`, writes a marker on `Payment.description`, and does not confirm the seat, which stays `HELD` unless it was already released. For example, a buyer was charged ₹99.99 against a ₹100.00 seat and the auto-refund call to the gateway threw. The handler returned `amount_mismatch`, the payment read `SUCCEEDED` with `Auto-refund pending: capture amount 9999p ≠ expected 10000p`, and the gate still admitted the seat.
- **A confirmed seat on a failed payment (#2519).** Seed user `patrick` holds a `CONFIRMED` class seat whose payment is `FAILED` (appointment `70786b93-cd6c-481c-ac77-805fe1016293`). The gate admitted it on status alone.

## Decision

A group-event seat opens the room only when it holds a **fulfilled entitlement**. `paidParticipant` is one predicate with two arms, read in one statement on the join path:

| Seat status             | Admitted when                                                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONFIRMED`, `ATTENDED` | the seat has no payment (`paymentId` is null), or its payment is `SUCCEEDED`                                                                                                                                                                                                                  |
| `HELD`                  | its payment is `SUCCEEDED`, owes no refund (`refundOwedKey` is null), has no `PENDING` or `SUCCEEDED` refund, and carries none of the settle-elsewhere markers on `description` (`Auto-refund pending:`, `Auto-refunded:`, `Auto-refund stuck:`, `REQUIRES_MANUAL_RECOVERY:`, `Replay sale:`) |
| `CANCELLED`, `REFUNDED` | never                                                                                                                                                                                                                                                                                         |

The marker list is `notSettledElsewhereWhere` in `lib/payments/webhooks/auto-refund-marker.ts`, the same filter the orphan sweeps use, so the gate and the sweeps cannot disagree about which captures are being given back. Every code path that parks a capture as an unapplied receipt writes one of these prefixes in the same transaction, which is why the gate does not need to read the ledger (the ledger has no Prisma relation to `Payment`, so reading it would cost a second statement).

### Why the two arms differ

- **A confirmed seat ignores refund-owed markers and refund rows.** A platform incident voids one session of a class and refunds that session through a refund-owed marker (`incident:<incident>:<occurrence>:<user>`). The seat stays `CONFIRMED` for the remaining sessions and must keep opening the room. A confirmed seat also ignores the `REQUIRES_MANUAL_RECOVERY:` marker, because the admin recover door confirms the seat in its own commit and leaves the payment's description unchanged.
- **A confirmed seat with no payment is admitted.** The host and collaborator rows have no payment, and a class reallocation re-seats enrolled learners on the new appointments with `paymentId` null (`reconnectEnrolledUsers`).
- **A held seat is admitted only for a capture that is still being applied.** In today's code the capture's `SUCCEEDED` stamp and the seat's confirmation commit together, so a clean `SUCCEEDED` payment beside a `HELD` seat is a window that a future split could open. The arm keeps that window admitted and shuts every capture the pipeline rejected.

### Why the gate, not a database invariant

Issue #2519 asked whether `CONFIRMED` should imply a settled payment in Postgres. Every production writer already keeps that true:

- the capture pipeline (`confirmSeatAfterCapture`) and the no-gateway checkout (`writeCheckoutPayment` with `skipPayment`: the `WALLET`, `INVOICE`, `LICENSE` and `CREDITS` rails) confirm the seat in the same commit that writes `SUCCEEDED`;
- every other `CONFIRMED` writer (the host and collaborator rows, the allocator, the class re-seat) writes no payment link;
- nothing moves a payment out of `SUCCEEDED`: every `FAILED` and `EXPIRED` writer compares-and-sets from `PENDING` or creates a new row;
- a re-mint rewrites only an `EXPIRED` or `FAILED` payment, and a buyer who already holds a non-`HELD` seat is refused before checkout.

The seed row is therefore inconsistent seed data, not a product path. A Postgres guard would need a constraint trigger on both `AppointmentParticipant` and `Payment`, because a `CHECK` cannot read another table. The gate costs nothing extra (the same statement) and covers the seed row too, so this record adds the gate check and no sidecar. A trigger stays possible later without a schema change if a writer ever needs it.

## Consequences

- A buyer whose capture is under refund, refunded, stuck or awaiting manual recovery sees "You are not authorized to join this meeting" until an operator recovers the booking, which confirms the seat.
- A seat confirmed on a failed, expired or pending payment is refused, including the `patrick` seed row.
- The no-gateway rails, comp and free seats, re-seated learners and a recovered booking keep their access.
- The predicate's cases are pinned in `__tests__/booking/paid-participant.test.ts`. `__tests__/payments/capture-amount-parity.test.ts` runs the real handler on a rejected capture and then the real gate on the payment it left.

## Deprecated & Superseded Approaches

- **Admission on seat status alone.** A `CONFIRMED` or `ATTENDED` seat no longer opens the room when its linked payment is not `SUCCEEDED`.
- **Admission on any `SUCCEEDED` payment beside a `HELD` seat.** A capture the pipeline rejected also reads `SUCCEEDED`; the held arm now also requires the absence of every refund and settle-elsewhere marker.
