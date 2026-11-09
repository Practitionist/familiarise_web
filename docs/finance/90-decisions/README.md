---
title: Money decisions
type: explanation
band: 90-decisions
audience: sde3
status: live
last-reviewed: 2026-10-23
---

# Money decisions

This page indexes the decisions that shape the money subsystem and says where each one is enforced. The decision records themselves stay where they are. Code comments and other documents cite the architecture decisions by number ("ADR 26", "ADR 15"), so moving one file would force renumbering dozens of others and rewriting every citation. Read this page to find the right record, then read the record for the context, the alternatives and the consequences.

## The gateway decision

Razorpay is the only integrated payment gateway for collections, and RazorpayX is the only integrated rail for payouts. Stripe was removed on 4 October 2026 (UTC), together with the dormant GST-TCS and auto-top-up machinery. The `PaymentGateway` enum still carries the labels `STRIPE` and `DODO_PAYMENTS`, but they are schema-only: `UNIMPLEMENTED_GATEWAYS` (`lib/payments/constants.ts`) and `assertGatewayUsable` (`lib/payments/validation/gateway-guards.ts`) make every money path refuse them. `routeGateway` (`lib/payments/gateway-router.ts`) sends every buyer to Razorpay on an INR order, and `assertInrSettlement` (`lib/payments/validation/currency-guards.ts`) makes INR the only settlement currency; a buyer abroad pays with an international card. Other gateways were evaluated and have no code behind them; the [gateway decision record](../../decisions/2026-11-09-payment-gateways-one-rail.md) holds the evaluation and the triggers that would reopen it, and it is a record of an evaluation, not a plan. Nothing in the repository documents them as planned, and no document should describe a gateway that has no implementation.

## Architecture decisions that govern money

All of these live in `docs/enterprise/70-design-decisions/`.

| ADR                                                                                     | Decision                                                                                                                      | Enforced by                                                                                                  |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [01](../../enterprise/70-design-decisions/01-double-entry-over-three-logs.md)           | One balanced journal replaces separate funding, wallet and settlement logs.                                                   | `postLedgerTxn`; the `ledger_txn_balanced` constraint trigger                                                |
| [02](../../enterprise/70-design-decisions/02-integer-paise-and-basis-points.md)         | Money is integer paise and splits are integer basis points; no float touches a balance.                                       | `prorate` (`lib/payments/utils/money.ts`); `rate_card_bps_sum_is_whole`; `scripts/ci/check-money-columns.ts` |
| [03](../../enterprise/70-design-decisions/03-deterministic-ledger-account-ids.md)       | Ledger accounts have deterministic composite ids, so an account is created and found without a lookup.                        | `ledgerAccountId` (`lib/payments/ledger/post.ts`)                                                            |
| [04](../../enterprise/70-design-decisions/04-batch-payouts-over-streaming.md)           | Earnings settle in periodic idempotent batches, not per-earning transfers.                                                    | `createPayoutBatchSlice`, `create-payout-batch`                                                              |
| [05](../../enterprise/70-design-decisions/05-github-actions-crons.md)                   | Superseded for money jobs by ADR 27. Kept as a tombstone.                                                                     | n/a                                                                                                          |
| [08](../../enterprise/70-design-decisions/08-gapless-invoice-counters.md)               | Invoice and credit-note numbers come from atomic per-organisation, per-fiscal-year counters.                                  | `OrgInvoiceCounter`, `OrgCreditNoteCounter`; `fitPrefixToRule46`                                             |
| [11](../../enterprise/70-design-decisions/11-live-payout-submission-freeze.md)          | `ENABLE_LIVE_PAYOUTS` freezes only the gateway-submission step; everything upstream runs for real.                            | `processApprovedPayouts`, `processOrgPayout`                                                                 |
| [12](../../enterprise/70-design-decisions/12-pending-trust-earnings-parking.md)         | Earnings for an unverified invoice-funded organisation park in `PENDING_TRUST` until it verifies or pays.                     | `releaseSponsorTrustPark`, the payment-confirmation path                                                     |
| [13](../../enterprise/70-design-decisions/13-postgres-native-concurrency.md)            | State transitions are guarded by compare-and-set `WHERE` clauses and Serializable retries, not by a queue or workflow engine. | `withSerializableRetry`; every status `updateMany`                                                           |
| [15](../../enterprise/70-design-decisions/15-currency-as-enum-with-display-fields.md)   | Settlement currency stays the `Currency` enum; display codes live in free-text fields.                                        | the `*_currency_inr` CHECKs in `prisma/sql/check-constraints.sql`                                            |
| [18](../../enterprise/70-design-decisions/18-open-b2b-b2c-boundary.md)                  | Sponsors may fund any marketplace consultant; curated panels and exclusivity are enforced at checkout.                        | `revalidateInsideLock`                                                                                       |
| [21](../../enterprise/70-design-decisions/21-single-writer-for-payment-confirmation.md) | Payment confirmation has exactly one writer.                                                                                  | `handlePaymentSuccess`                                                                                       |
| [26](../../enterprise/70-design-decisions/26-gst-principal-model.md)                    | The platform bills GST as principal supplier.                                                                                 | `mintConsumerInvoice`, `deriveGstBreakdown`                                                                  |
| [27](../../enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md)   | No generic outbox table; domain rows are the outbox and the Netlify ticker drives the sweeps.                                 | `netlify/functions/cron-tick.mts`, `withCronLock`                                                            |
| [28](../../enterprise/70-design-decisions/28-typed-versioned-cancellation-policy.md)    | Refund terms are typed, versioned, immutable rows that a booking points at.                                                   | `resolveCheckoutCancellationPolicyId`, `quoteBookingRefund`                                                  |

## Dated decisions

| Decision                                                                                                       | Subject                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Pay-link GST parity](../../decisions/2026-09-19-pay-link-gst-parity.md)                                       | A pay-link payment carries the same GST as a direct checkout.                                                   |
| [Class-series money rules](../../decisions/2026-09-25-class-series-money-rules.md)                             | How refunds, credits and make-ups work for a class series.                                                      |
| [Appointment money is per seat](../../decisions/2026-09-13-appointment-money-is-per-seat.md)                   | On a group event, money is a status per seat, and an attendee sees only their own.                              |
| [Session outcomes](../../decisions/2026-09-25-session-outcomes.md)                                             | How presence, voids and misses decide a session's outcome, which in turn decides whether money is owed back.    |
| [RBI payment aggregator posture](../../enterprise/40-compliance-and-data/07-rbi-payment-aggregator-posture.md) | Why the platform is not a payment aggregator and what must stay true for that to hold.                          |
| [Payment gateways: one rail](../../decisions/2026-11-09-payment-gateways-one-rail.md)                          | Why only Razorpay and RazorpayX are integrated, what was rejected, and what is deferred with a revisit trigger. |

## Where in code

The decisions above are enforced in `lib/payments/`, `prisma/sql/check-constraints.sql`, `prisma/sql/ledger-triggers.sql` and `netlify/functions/cron-tick.mts`.

## Related

- [Finance documentation index](../README.md)
- [Money system explainer](../../start-here/02-money-system-hld.md)

## Deprecated & Superseded Approaches

1. **GitHub Actions as the money scheduler** (ADR 05). Replaced by the ticker (ADR 27); only the tombstone remains.
2. **Describing Stripe, Cashfree, Tazapay, Xflow or a merchant-of-record gateway as live or planned.** Only the Razorpay pair has code. Delete any agent, skill or document that designs against another gateway.
3. **A Redis lock for cron jobs.** The lease is Postgres (`SystemJobExecution`).
