---
title: Owed-refund backoff now, a Job table queue next
band: 70-design-decisions
audience: sde3
status: accepted
last-reviewed: 2026-10-31
---

# ADR 37 — Owed-refund backoff now, a Job table queue next

## Context

A refund that a booking door owes is a marker on the `Payment` row (`refundOwedKey`, `refundOwedPaise`, `refundOwedReason`, `refundOwedAt`, `refundOwedAttempts`). The marker is stamped in the same commit that ends the booking, following the state-as-outbox pattern of [ADR 27](27-state-as-outbox-and-scheduled-ticker.md). The `retry-auto-refunds` sweep re-drives markers on the 15-minute ticker, ten rows per run, after a 15-minute grace. After three failed drives (`MAX_REFUND_OWED_ATTEMPTS`) it pages an operator.

The sweep had no backoff. A 45-minute Razorpay outage spent all three attempts, the door's own drive plus the next two ticks, and paged an operator once for every owed refund. An operator who then refunded a payment by hand did not clear a marker that was still retrying, so the sweep could later send the same money a second time.

## Decision

1. **Backoff on the row (the interim).** `Payment.refundOwedNextAt` is the earliest time the sweep may drive the marker again, and the sweep claims only rows where it is null or past. `countFailedAttempt` (`lib/payments/operations/refund-owed.ts`) sets it in the same compare-and-swap that counts the attempt, keyed on the marker key and the attempt count it read: 1 hour after the first failure and 4 hours after the second. With the 15-minute grace, the schedule is 15 minutes, then 1 hour, then 4 hours, then a page about 5 hours after the stamp. The cap stays at three. Every stamp and clear resets the column, and the aged-marker warning moves from 2 hours to 6 hours so that it fires only after the last scheduled retry.
2. **A hand refund settles the owed refund as far as it goes.** Any operator refund settles the payment's owed refund in the same Serializable transaction that creates its `Refund` row (`settleOwedByHand`), by CAS on the marker key and the owed amount it read. A null amount reads as the refundable balance before the refund. A hand refund at or above the owed amount clears the marker. A smaller one lowers `refundOwedPaise` by its amount and leaves the attempts and `refundOwedNextAt` alone, so the next drive pays only the remainder, still capped by the refundable balance. The outcome is recorded on `Refund.metadata.settledOwed` and reported to the operator as "The owed ₹Y is fully settled." or "Settled ₹X of the owed ₹Y; ₹Z still owed and retrying." Every drive of a marker read back from the payment row, the sweep's included, carries the marker it read (`owedMarker`), and each rail's transaction checks it still holds the payment at that amount (`assertOwedMarkerHeld`). A drive that lost to a hand refund therefore moves no money. A hand refund that then fails, wherever it is moved to `FAILED`, gives back exactly what it settled in the same transaction (`restoreOwedOnFailedRefund`). A live marker grows back by CAS, and a cleared one is re-stamped under a new key with `refundOwedNextAt` one grace period out. Both are capped at the refundable balance and recorded once through `settledOwedRestored` on the refund. This reverses the first version of this decision, under which any manual refund cleared the marker whatever its amount, which could leave the rest of the debt unpaid.
3. **Phase 2: a hand-written Prisma `Job` table.** The durable retry queue will be a `Job` table claimed with `SELECT … FOR UPDATE SKIP LOCKED`, with the run-at time, attempts and last error as columns. Owed refunds move onto it, and `refundOwedNextAt` and `refundOwedAttempts` are then dropped from `Payment`.

## Alternatives Considered

- **Raising the attempt cap.** This was rejected because a fixed 15-minute cadence still pages after a set wall-clock time. Covering a few hours that way would need about twenty attempts, each of which adds a `FAILED` `Refund` row.
- **Backoff derived from `refundOwedAt` and the attempt count, with no new column.** This was rejected because the sweep's claim would become arithmetic in the `WHERE` clause that the existing tests and the ops queries cannot read at a glance. A stored next-drive time is one comparison.
- **A hosted queue (QStash or Upstash Workflow).** This was rejected because the money state would then live with a vendor, outside the transaction that stamps it. That breaks the rule that the marker commits with the booking change.
- **Moving straight to the `Job` table.** This was deferred because it is a schema and worker change across every owed-refund door. The column fixes the paging storm today with an additive change.

## Consequences

An outage of a few hours now costs one page per refund that is still owed after about 5 hours, not one per refund at 30 minutes. A buyer can wait up to 5 hours for a refund that eventually succeeds. During that time another door's `REFUND_IN_PROGRESS` refusal tells them changes are possible once the refund completes. An operator can always settle an owed refund by hand. A partial hand refund never strands the rest of the debt: the remainder stays on the marker and keeps retrying, and the operator is told how much is still owed. A partial credit return against a whole-restoration marker is refused, because the credits rail cannot restore a remainder.

Revisit this decision when the `Job` table lands. At that point the backoff column and the attempt column leave `Payment`, and the sweep becomes a `Job` worker.

## Deprecated & Superseded Approaches

The sweep used to retry every 15 minutes with no backoff and page at the third failure, about 30 minutes after the stamp. An operator refund cleared only a marker that had used all its attempts, and only when hand refunds since the stamp covered it (`clearStuckRefundOwed`). The first version of this ADR had any manual refund clear the marker whatever its amount; a smaller hand refund now reduces it instead. Delete references to any of these.
