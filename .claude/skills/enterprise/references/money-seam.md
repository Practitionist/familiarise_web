# The money seam between B2C checkout and B2B funding

Organisation money flows through the same consumer-facing checkout as a personal card payment. This page describes what changes when the payer and/or supply provider is an organisation: which funding rail collects the price, how cross-organisation (`Buyer Org != Host Org`) and multi-collaborator earnings split, how every `(FundingSource × ProgramType × OverageBehavior × overageSurchargeBps)` permutation settles without backend refusal walls, and how the 3-Tier UI Motivation model guides buyers.

## The four funding rails & Cross-Org attribution (`Buyer Org != Host Org`)

`BillingAccount.fundingSource` selects the money path at checkout: **PERSONAL** tags the org for reporting and allowance tracking while the learner's own card pays (`Dr CASH`); **WALLET** debits `BillingAccount.walletBalance` atomically (`Dr WALLET(buyerOrg)`); **INVOICE** accrues the charge to the organisation's monthly invoice with no real-time gateway charge (`Dr ORG_RECEIVABLE(buyerOrg)`); and **LICENSE** is absorbed by a prepaid license contract (`LICENSE` leg with `amountPaise = 0`). For pure wallet and in-cap license bookings no gateway call happens at all — the `Payment` row is created at `SUCCEEDED` immediately in the same transaction that confirms the appointment.

Four fields on `Payment` divide the responsibility of tracking buyer funding vs supply settlement:

- `organizationId` (`@relation("PaymentOrgTag")`): the **buyer / sponsor org** whose member made the booking.
- `hostOrganizationId` (`@relation("PaymentHostOrg")`): the **supply / host org** whose `EXPERT` member delivered the session. When `organizationId !== hostOrganizationId` (**Cross-Org Booking**), checkout debits Buyer Org A's rail (`WALLET(orgA)` or `ORG_RECEIVABLE(orgA)`) while `resolveOrgSplit()` resolves Host Org B's org-scoped `RateCard` and posts `Cr ORG_PAYABLE(orgB)` + `Cr CONSULTANT_PAYABLE(expert)` + `Cr PLATFORM_FEE` + `Cr GST_PAYABLE`.
- `billingAccountId`: the settlement pointer identifying which buyer `BillingAccount` was charged.
- `billableToOrgInvoiceId`: stamped once an `INVOICE_ACCRUAL` or `OVERAGE_INVOICE_ACCRUAL` leg is rolled into a specific `OrganizationInvoice`.

## Multi-collaborator same-org `OrganizationEarnings` (`consultantProfileId`, `role`, `cycleOrdinal`)

`OrganizationEarnings` carries the 5-column unique constraint `@@unique([paymentId, organizationId, consultantProfileId, role, cycleOrdinal])`. When a group session (webinar or class) has a primary expert (`role = OWNER`) and one or more collaborators (`role = COLLABORATOR`) who belong to the **same** Host Org — or when a subscription releases earnings across recurring cycles (`cycleOrdinal`) — each expert's slice writes its own `OrganizationEarnings` row with its own frozen `rateCardIdApplied`, `platformBpsApplied`, `orgBpsApplied`, and `consultantBpsApplied` snapshot.

## Unlocked 7-Axis Permutation Engine, `LICENSE + CARD` Co-Pay Split `PaymentLeg`s, and 3-Tier UI Motivation

Every `(FundingSource × ProgramType × OverageBehavior × overageSurchargeBps)` combination (`WALLET × LICENSED_SEAT`, `LICENSE × CREDIT_POOL`, `PERSONAL × (CREDIT_POOL | LICENSED_SEAT)`, `CHARGE_MEMBER`, `WALLET × CHARGE_ORG`, `LICENSE × CHARGE_ORG`) is unlocked in the backend engine while the UI guides operators via `<MotivationBanner />` and `<AdvancedPermutationGate />` across three tiers (`RECOMMENDED` Golden Path, `ADVANCED` Guided Friction, `DISCOURAGED` High-Friction Confirmation):

- **`BLOCK` (any rail — `RECOMMENDED`)**: Refuses over-cap bookings with HTTP 402 `PROGRAM_CAP_EXHAUSTED` (and acts as the automatic fallback whenever cumulative cycle overage reaches `maxOveragePerCyclePaise`).
- **`INVOICE × CHARGE_ORG` (`RECOMMENDED` at 0 bps / `ADVANCED` at >0 bps)**: Carves `basePaise` out of the base `INVOICE_ACCRUAL` leg and writes `marginalPaise` (`basePaise + surchargePaise` + surcharge GST) as a distinct `OVERAGE_INVOICE_ACCRUAL` leg. `surchargePaise` credits `PLATFORM_FEE` and its 18% GST credits `GST_PAYABLE`.
- **`WALLET × CHARGE_ORG` (`ADVANCED`)**: `walletDebit()` atomically debits `coveredPaise + marginalPaise` (including `surchargePaise` and its GST) from `BillingAccount.walletBalance` in the `WALLET` leg (`Dr WALLET(org)`), minting an `OverageEvent` born `CHARGED` (`settledAt = now()`) and crediting `surchargePaise` to `PLATFORM_FEE` and surcharge GST to `GST_PAYABLE`.
- **`LICENSE × CHARGE_ORG` (`ADVANCED`)**: Writes a ₹0 `LICENSE` leg for `coveredPaise` plus an `OVERAGE_INVOICE_ACCRUAL` leg (`Dr ORG_RECEIVABLE(org)`) for `marginalPaise`, which rolls into a child/monthly `OrganizationInvoice` at cycle close.
- **`CHARGE_MEMBER` — Synchronous Co-Pay Split `PaymentLeg`s (`LICENSE + CARD`, `WALLET + CARD`, `INVOICE_ACCRUAL + CARD` — `ADVANCED`/`DISCOURAGED`)**: When a booking partially exceeds a program cap and the learner pays the overage synchronously at checkout, `Payment.legs` records **both** the org leg (`LICENSE` at `0` for `coveredPaise`, or `WALLET` / `INVOICE_ACCRUAL` for `coveredPaise`) and a `CARD` leg for the learner's `marginalPaise` co-pay. The `assert_payment_legs_ok` trigger validates that the monetary legs equal the payable `Payment.amount`.
- **`CHARGE_MEMBER` — Post-Hoc Pay-Link with Earnings Hold (`DISCOURAGED`)**: When `marginalPaise` is deferred to a parent-linked child `Payment` (`parentPaymentId`) payable at `/dashboard/overage`, checkout carves `basePaise` out of the org leg and holds the over-cap share of `ConsultantEarnings` and `OrganizationEarnings` (`EarningStatus.HELD`) until the member's side-payment is `CHARGED` (preventing an unsecured write-off if the 14-day pay window times out).

## Wallet debit and credit; the NULL-cache seed

`walletDebit()` performs an atomic test-and-decrement of `BillingAccount.walletBalance` in the same transaction the `WALLET` leg is written, so a booking cannot be confirmed against a balance that has already been spent by a concurrent checkout. `walletCredit()` is the refund-side mirror, crediting the cache and writing the corresponding `Cr WALLET(org)` ledger entry. A newly created `BillingAccount` seeds its wallet balance as `NULL` rather than zero, which is a deliberate signal distinguishing "this org has never had a wallet balance computed" from "this org's wallet balance is exactly zero" — code that reads the balance must treat a `NULL` as needing initialisation, not as a debit failure.

## Invoice accrual, rollup, and dunning

An INVOICE-rail booking (or a `LICENSE × CHARGE_ORG` overage) accrues an `INVOICE_ACCRUAL` / `OVERAGE_INVOICE_ACCRUAL` leg with no immediate cash movement. `rollupOrgInvoiceAccruals`, run monthly, sums every unbilled accrual leg for an organisation into one `OrganizationInvoice`, stamping `billableToOrgInvoiceId` on each `Payment` it consumed so a second rollup run does not re-bill the same charge. An invoice past its due date is marked `OVERDUE` by the dunning cron, which sends reminders on a fixed cadence; booking-suspension on terminal non-payment is gated behind `ENABLE_DUNNING_SUSPEND` (default off).

## Purchase-order draw-down

A `PurchaseOrder` gates an `OrganizationInvoice` by tracking `remainingAmountPaise`: an invoice cannot be issued against a purchase order whose remaining balance is insufficient, and each issued invoice decrements the balance in the same currency as the order. Both the manual invoice route and the monthly rollup draw through one CAS helper (`lib/payments/billing/purchase-order-draw.ts`); the rollup picks the oldest unexpired active order that covers the total and records an operator event when an organisation that requires a purchase order has none that covers it. An organisation with `requiresPO` gets a 409 `PO_REQUIRED` when it raises an invoice or signs a contract without one. This is a spending-cap mechanism layered on top of the INVOICE rail, not a fifth funding rail of its own.

## Domain verification and consent gates

An organisation cannot fund bookings, or be billed for its members' overage, until its domain is verified and its billing consent is on record. Both checks are read at checkout time from the same transaction that decides the funding leg, so a booking cannot commit against an organisation whose verification lapsed between the page load and the checkout submit.

## Sources

`docs/payments/04-b2c-b2b-funding-seam.md`, `docs/enterprise/00-foundations/03-funding-and-programs.md`, `docs/enterprise/10-money-and-ledger/04-wallet-and-topups.md`, `docs/enterprise/10-money-and-ledger/05-booking-to-earnings.md`, `lib/enterprise/reachable-paths.ts`.
