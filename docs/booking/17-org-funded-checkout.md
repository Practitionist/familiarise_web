# Org-Funded Checkout

## Overview

Every booking — self-funded or employer-sponsored — enters through the **same** checkout operation (`handleCheckout()` in `lib/payments/operations/checkout.ts`); there is no separate B2B endpoint. What makes a booking org-funded is one optional input: when the client passes `organizationId`, checkout resolves the org's funding context up front and, for the sponsored funding sources, **skips the payment gateway entirely** — the appointment is confirmed in the same transaction with no webhook, no client payment step, and a synthetic payment-intent id.

This document walks that rail from resolution to settlement, from the booking system's point of view. The payments-side view of the same seam (payment legs, refund audit rows, wallet lifecycle) is [`docs/payments/05-b2c-b2b-funding-seam.md`](../payments/05-b2c-b2b-funding-seam.md); the enterprise money model behind it is [`docs/enterprise/10-money-and-ledger/`](../enterprise/10-money-and-ledger/). For the ordinary gateway path this document builds on, read [10-checkout-payment-integration.md](./10-checkout-payment-integration.md) first.

The four funding sources behave as follows (`BillingAccount.fundingSource`, `prisma/schema.prisma:1100`).

| fundingSource | Who pays, and when | Gateway? |
| --- | --- | --- |
| `PERSONAL` | The learner's own card; the org is tagged for reporting only | Yes — ordinary two-phase flow |
| `WALLET` | The org's prepaid wallet, debited atomically at checkout | No |
| `INVOICE` | Nobody at checkout; the amount accrues to the org's monthly invoice | No |
| `LICENSE` | Absorbed by a LICENSED_SEAT program; the amount billed is 0 | No |

---

## The resolution chain

When `validatedData.organizationId` is present, checkout resolves the org context before any pricing or locking (`lib/payments/operations/checkout.ts:1864–2097`). Each gate fails closed with a thrown error; the order below is the order in the code.

1. **Org exists and may transact** (`:1896–1922`). The org must be `ACTIVE` — or `PENDING_VERIFICATION`, which is allowed to transact only under the INVOICE credit-limit gate below (#687).
2. **`canSponsor` gate** (`:1923–1927`). An org not configured to sponsor bookings (`canSponsor: false`) is rejected outright.
3. **Overdue-invoice suspension** (`:1929–1951`, config-gated by `ENABLE_DUNNING_SUSPEND`, default off — #812). If the dunning cron has stamped `dunningSuspendedAt` on any still-`OVERDUE` invoice, new sponsored bookings are blocked, citing the oldest overdue invoice; paying it lifts the gate naturally.
4. **ACTIVE membership** (`:1953–1960`). The booking user must hold an `ACTIVE` `Membership` at the org.
5. **DPDP consent** (`:1962–1981`, #701). The member needs a live `SESSION_BOOKING` consent artifact before the org can book and pay on their behalf; the check fails closed with a 403-shaped `CONSENT_REQUIRED` error.
6. **fundingSource from the org's BillingAccount** (`:1986`): `fundingSource = org.billingAccount?.fundingSource ?? "PERSONAL"`. Personal referral credits are stripped from the request on any non-PERSONAL source (`:1988–1991`) — org money and personal credits never stack.
7. **INVOICE-specific gates** (`:1999–2047`). INVOICE funding requires a verified org domain (`assertVerifiedDomainOrThrow`, K-02/#687), and the org's exposure — unbilled succeeded accruals plus outstanding `ISSUED`/`OVERDUE` invoices — must sit below the effective credit limit (the explicit `creditLimit`, floored by the governance default for unverified orgs). The effective limit is threaded into the Serializable booking transaction and **re-checked there** so a concurrent booking cannot slip past it (#785 B6, `:2288–2298`).
8. **ProgramAssignment resolution** (`:2055–2087`). Every non-PERSONAL path requires a currently-active `ProgramAssignment` for the member whose ACTIVE Program covers this `appointmentType` (an empty `coveredPlanTypes` covers everything) under an ACTIVE contract within its effective window. **A missing assignment fails closed: checkout throws** ("No active program assignment covers this booking…") **rather than silently billing the learner's card** (`:2080–2086`). The assignment is the source of truth for "is this booking sponsored?".
9. **ADR 18 gates, inside the lock** (`revalidateInsideLock`, `:1119–1158`). The resolved Program's id is carried into the locked revalidation, where two checks run race-safely: the **curated-panel allowlist** — rows on `ProgramConsultantAllowlist` restrict org-sponsored bookings to listed consultants, zero rows keep the sponsor network open — and **`exclusiveEngagement`**, which blocks booking a consultant's independent (non-org-owned) plans while any ACTIVE membership declares exclusivity. Self-booking one's own plan is rejected on the same pass (`:1111–1117`).

The comment block at `:1864–1875` states the doctrine in one line: a missing assignment on a WALLET/INVOICE/LICENSE org **refuses rather than silently bills the learner's card**.

---

## Skipping the gateway

After the distributed lock is held and revalidation passes, checkout derives the sponsorship booleans (`:2169–2180`): each of `isOrgWalletPayment` / `isOrgInvoicedPayment` / `isOrgLicensedPayment` requires **both** the funding source and a resolved `programAssignmentId`, and their union is `isOrgSponsoredPayment`. For a sponsored payment no gateway order is created; a synthetic payment-intent id is minted locally with the rail encoded in its prefix (`:2209–2216`):

```
org_wallet_<ts>_<rand>   |   org_invoice_<ts>_<rand>   |   org_license_<ts>_<rand>
```

(The sibling zero-amount path mints `free_…` ids the same way at `:2218`.) Inside the Serializable booking transaction, `skipPayment` (`:2316–2317`) then changes three things at once: appointment slots are created **confirmed** rather than tentative, the `Payment` row is written with `paymentStatus: SUCCEEDED` and no `expiresAt` (`:2385–2425`, with `paymentMethod` mapped to `WALLET`/`INVOICE`/`LICENSE`), and no webhook is ever needed to complete the booking. The row carries `organizationId` and `billingAccountId` so the reporting tag and the settlement pointer both survive — see the funding-seam doc for why those are different questions.

### The WALLET debit

For wallet funding the same transaction debits the org's balance (`:2431–2446`). Two guards apply. First, a wallet frozen by the ledger reconciler (cache drifted from the journal) refuses to spend (`isWalletFrozen`, #837). Second, the debit itself is the **atomic conditional `updateMany`** in `lib/api/organizations/wallet.ts:68–74`: the UPDATE matches only a row whose `walletBalance` is already `>= amount` and decrements it in the same statement, so two concurrent debits cannot overdraw — the loser matches zero rows and throws `WalletInsufficientFundsError`, rolling the booking back. No journal entry posts here; the accounting leg posts at settlement, where the full fee/payable split is known.

### Engagement debits: CLASS at checkout, SUBSCRIPTION lazily

Sponsored bookings consume **engagements** against the member's program cap (#710); one engagement is one `Appointment` row, one calendar occurrence (`:2301–2311`). The per-type behavior differs deliberately:

- **CONSULTATION / WEBINAR** debit **1** engagement at checkout.
- **CLASS** debits **N** engagements at checkout — the count of class appointments the learner enrolled in, all known up front because the consultant pre-allocated the sessions (`classResult.engagementsConsumed`, `:2373`).
- **SUBSCRIPTION** debits **nothing** at checkout (`engagementsForCap` stays `null`). Slots are allocated lazily by the consultant later, so the debit lands in `SlotAllocationService.createAppointments`, one per allocation batch.

The debit is `recordBookingUtilization` (`:2470`), which writes the `BookingUtilization` row and the `PaymentLeg` describing where the money or commitment actually came from. Breaching a `BLOCK`-behavior cap throws `ProgramAssignmentLimitError`, rolls the transaction back, and fires a bell notification to the assignee and org operators.

---

## Settlement, and what happens when it fails

Sponsored payments bypass webhooks, so the settlement that `handlePaymentSuccess()` performs for gateway payments runs **inline at checkout** for the mock/zero/sponsored family (`:2842–2954`): referral qualifying action, then `createEarningsFromPayment()` (`lib/payments/payouts/earnings-service.ts:293`).

Settlement is where the money truth is written, atomically: the `ConsultantEarnings` rows (parked `PENDING_TRUST` when the sponsor is an unverified INVOICE org, #687 E-02), any `OrganizationEarnings` rows, and the balanced double-entry **booking journal** posted with idempotency key `booking:<paymentId>` (`earnings-service.ts:801–806`). A non-retryable posting failure records the drift as a `LEDGER` system error on its own connection and **re-throws so the whole earnings transaction rolls back** — earnings never commit without their journal (`:815–836`; a `P2034` serialization conflict is instead retried by `withSerializableRetry`).

One nuance matters on this rail: at that point the **booking transaction has already committed** — the appointment is confirmed and, for WALLET, the org's money has moved. Checkout therefore does not pretend the booking failed; it pages (`recordSystemError`, C-01 #837) and relies on the `sync-payment-earnings` sweep, keyed on row state (SUCCEEDED payment with no earnings), to re-drive settlement idempotently (`checkout.ts:2961–2983`). On the webhook path the same rollback protects the confirmation work batched with it; on this path the healer is the sweep.

---

## Refunds on this rail

An org-funded booking carries a synthetic `org_*` intent that no gateway can resolve, so its refund is **internal**: `refundBookingPayment` (`lib/payments/operations/booking-refund.ts:51`) splits the rails on `isInternalFundedIntent` — gateway/mock money goes through the two-phase gateway refund, org-funded money reverses purely in-ledger through the reversal engine (wallet credited back, invoice accrual netted by a `*_REVERSAL` leg, license engagements restored). Event-wide refunds use `refundWholeEventPayments` (`lib/payments/operations/event-refunds.ts:56`), which made the same split first. The full cascade, including the org audit rows it writes, is in the funding-seam doc and [08-cancellation-flow.md](./08-cancellation-flow.md).

---

## Where to look

The pointers below are the fastest paths into the code and the neighboring docs.

| Concern | Location |
| --- | --- |
| Resolution chain + gates | `lib/payments/operations/checkout.ts:1864–2097` |
| ADR 18 allowlist/exclusivity (in-lock) | `lib/payments/operations/checkout.ts:1119–1158`; `docs/enterprise/70-design-decisions/18-open-b2b-b2c-boundary.md` |
| Gateway skip + synthetic ids | `lib/payments/operations/checkout.ts:2209–2216`, `:2316–2317` |
| Wallet debit (atomic conditional updateMany) | `lib/api/organizations/wallet.ts:49–92` |
| Engagement debits + caps | `lib/payments/operations/checkout.ts:2301–2311`, `:2448–2476`; lazy SUBSCRIPTION debit in `SlotAllocationService.createAppointments` |
| Inline settlement + ledger posting | `lib/payments/operations/checkout.ts:2842–2983`; `lib/payments/payouts/earnings-service.ts:801` |
| Payments-side seam (legs, refunds, wallet lifecycle) | `docs/payments/05-b2c-b2b-funding-seam.md` |
| Enterprise money model | `docs/enterprise/10-money-and-ledger/` |
