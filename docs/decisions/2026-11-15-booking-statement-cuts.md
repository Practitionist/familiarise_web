# ADR: Targeted statement cuts on the slow booking writes

- **Status**: Accepted (2026-11-15). Built on the branch that carries this record.
- **Date**: 2026-11-15
- **Author**: Platform engineering
- **Related**: [Database round trips and join loading](../performance/06-database-round-trips-and-join-loading.md#booking-write-paths), [Notification architecture](../notifications/01-architecture.md)

## Context

Booking writes took 12 to 26 seconds on deploy previews, and a free webinar registration took 10 to 13 seconds. The functions run in Singapore with one Postgres connection each (`PG_POOL_MAX=1`), and the database runs in Mumbai, so every statement costs about 95 ms whatever it does. The time is the statement count.

Most of the count comes from one setting. `lib/prisma.ts` sets `relationLoadStrategy: "query"` on every read that does not choose its own strategy. Under that strategy Prisma sends one `SELECT` per relation level of an `include` or nested `select`, and it sends them even when the parent is null or the list is empty (the logs show `WHERE id IN (NULL)`). A read over four optional booking branches therefore costs 15 to 22 statements for a booking that uses one of them.

A trial request had a second problem. Its interactive `$transaction` passed no options, so it ran under Prisma's 5,000 ms default. It staged its two bells and two emails inside that transaction, one recipient read, one preference read and one three-statement upsert per bell, plus a suppression read and an insert per email: 16 of its 37 to 39 statements. At about 130 ms per statement on a slow run it overran the 5 s limit, and the client got a 500 whose body carried the raw Prisma message ("Invalid `prisma.appointment.findFirst()` invocation ... expired transaction"), because the error classifier returned any unrecognised message as it was.

## Decision

1. **Targeted join loading, not a global flip.** The default stays `"query"`. These reads opt in to `relationLoadStrategy: "join"`, each with its selection unchanged:
   - the four webinar loads of a seat checkout: `calculateAmountAndValidate` (`lib/payments/checkout/pricing.ts`), `readEventCapacity` (`locks.ts`), `revalidateInsideLock` (`revalidate.ts`) and `handleWebinarCheckout` (`handlers/webinar.ts`);
   - `resolvePaymentForEarnings` (`lib/payments/payouts/earnings-service.ts`), whose include is now the named `EARNINGS_PAYMENT_INCLUDE`;
   - the order-reuse read in `classifyOpenOrders` (`lib/payments/checkout/order-reuse.ts`);
   - the cancel route's `appointment.findUnique`;
   - the backup-interest read inside `stageBackupInterestNotices`, which `stageNoticesForAppointmentHolds` runs per held window;
   - `readEventByAppointment` in `stageSeatOpenedNotices` (`lib/booking/event-waitlist.ts`);
   - the read-back of `trial.create` in `bookTrialInTx`.
2. **The trial request reads its notices before its transaction.** `prepareTrialScheduledNotices` (`lib/trials/schedule-notices.ts`) resolves both bells' policy and zones in one joined user read (`bellRecipientZones`), renders the email and reads its suppressions in one query (`screenPreparedEmails`). Inside the transaction `stageTrialScheduledNotices` writes one `notificationOutbox.createManyAndReturn` and one `failedEmail.createManyAndReturn`, so the rows still commit or roll back with the booking. The transaction passes `{ maxWait: 10_000, timeout: 15_000 }`, as the approval request and the seat leave do. `notifyTrialScheduled` had no other caller and is deleted.
3. **A free order with no credit skips the invoice reads.** Checkout calls `mintConsumerInvoiceBestEffort` only when `hasBilledSupply(amount, creditsApplied)` (`lib/payments/checkout/zero-amount.ts`). A free order needs no billing state and gets no consumer invoice ([the trial and public booking surfaces](2026-11-13-trial-and-public-booking-surfaces.md), decision 2), and the same predicate now gates the billing-state check. The minter already returned null at `totalPaise <= 0`; a ₹0 order that credits funded still mints, because its supply is the credit.
4. **`ensureConsulteeProfile` is one read when the profile is linked.** A joined `consulteeProfile.findUnique` with the user's link answers the common case; the upsert and the conditional link write run only when either is missing.
5. **Refund paths: joins only, nothing skipped.** `resolveBookingRefundContext` and the payment read inside `refundRemovedAttendeeSeat` are joined. `leaveEventSeat` reads the seat's payment once, joined, and passes it to the rule (`planSelfLeave`, `planSeriesExit`) and the owed marker; a release never changes the payment row, and the Serializable snapshot is the same. The refund door is still called for every seat: free and credit-funded seats are told apart only inside `refundRemovedAttendeeSeat` (`isPriceFreeSeat` versus `isFreeCreditIntent`), because a ₹0 credit-funded seat must reach `creditSeatRefund` to restore the buyer's credits.
6. **No raw error text in a 500.** `classifyError` answers an unrecognised error with "Something went wrong. Please try again."; `apiError` and `POST /api/checkout` append the first eight characters of the Sentry event id as a reference, and return the full id as `errorId`. The error is captured once per request through `reportSentryError`; `logClassifiedError` now only logs, because the checkout route had been capturing every unrecognised error twice. A registered business code without its own `userMessage` still passes its thrown message: those messages are written as user copy at their throw sites (`BookingRuleError`, the coded refusals), and the registry's `userMessage` exists for the ones that are not.

## Worked numbers

Every count below is measured, from `scripts/dev/db-tier-local.sh --log-statements` on a disposable Postgres 17. `BEGIN`, `COMMIT` and `SET TRANSACTION` count as statements. Time is statements × 95 ms.

| Path                                                    | Before | After | Source   |
| ------------------------------------------------------- | ------ | ----- | -------- |
| Free webinar seat checkout, `handleCheckout`            | 129    | 76    | measured |
| of which inside the Serializable commit                 | 58     | 37    | measured |
| Free 1:1 consultation checkout, `handleCheckout`        | 127    | 93    | measured |
| Free trial request, the route                           | 46     | 29    | measured |
| of which inside its transaction                         | 37     | 18    | measured |
| `bookTrialInTx` alone, with `BEGIN` and `COMMIT`        | 21     | 16    | measured |
| Cancel a free confirmed 1:1, the route                  | 52     | 21    | measured |
| Leave a paid webinar seat, the committed leave          | 39     | 18    | measured |
| `resolvePaymentForEarnings`'s read on a webinar payment | 17     | 1     | measured |

Example, the trial: before, 37 statements inside a 5,000 ms limit is 3.5 s at 95 ms and 4.8 s at 130 ms, so a slow run overran. After, 18 statements inside a 15,000 ms limit is 1.7 s at 95 ms and 2.3 s at 130 ms. The notice reads moved out of the transaction add two statements before it (9 to 11), and the route as a whole drops from 46 to 29.

The counts exclude the test fixtures and assertions; auth, the rate limiter, the gateway and Novu delivery are mocked or run after the response, and the refund door and the Stream calls are not measured.

## Options not chosen

- **Flip the default to `"join"` globally.** It would cut the most statements at once, but it changes hundreds of reads in one go, `relationJoins` is still a Prisma 7 preview, related `Decimal` columns lose precision under it, and every opted-in reader so far was checked one at a time against a payload snapshot. Recorded as an item for the part 6 infrastructure audit.
- **Skip the refund door for a free seat at the caller.** `leaveEventSeat` already knows when a seat is price-free, and returning the door's answer directly would save one read. It would also put the free versus credit-funded decision in two places, and a caller that got it wrong would leave a credit-funded seat's credits unrestored. The door keeps the decision; its read is joined instead.
- **Move the functions next to the database.** Running the functions in Mumbai, or the database in Singapore, would cut every statement's cost rather than the count. That is a hosting change with its own failback and egress questions, recorded for the part 6 audit.
- **Drop the pre-lock capacity read or the under-lock revalidation.** Both are deliberate guards (the advisory sold-out answer before the event mutex, and the recheck under it); they stay, joined.

## Consequences

- **Behaviour change: a trial bell that already exists is left to the relay, not retried inline.** If an outbox row with the same `transactionId` is already there (the same pair, time and names staged before), the one-statement insert skips it and does not return it, so the post-commit flush does not attempt it. The upsert used to return the existing row and the flush attempted it straight away. The relay (`drain-notification-outbox`) still settles a PENDING or RETRY row on its next tick, so the bell is delayed, not lost; a row already SENT is not sent again either way.
- The suppression read for the trial email now sees the table as it was just before the transaction; `attempt()` rechecks the suppression before it sends, so a suppression added in between still stops the send.
- The client toast for an unexpected failure is unchanged (it keys on `errorType: UNKNOWN_ERROR`); the `error` text is generic and carries a reference support can match to Sentry.

## Deprecated & Superseded Approaches

The trial request used to stage each bell through `notifyTrialScheduled` (a timezone read, a two-statement policy read and an upsert per bell) and each email through `stage()` (a suppression read and an insert per recipient), all inside a transaction with Prisma's default 5 s limit. Checkout ran the consumer-invoice probe for every no-gateway order, free or not, and the unrecognised error branch of `classifyError` returned the error's own message to the client.
