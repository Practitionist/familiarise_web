# Payment Gateways

> Overview of Familiarise's payment gateway integrations, selection logic, and configuration.

**Last Updated**: 2026-10-05

---

## Overview

Familiarise uses **Razorpay as the primary payment gateway** for both domestic and international payments:

| Gateway      | Region                    | Currency | Payouts Product   |
| ------------ | ------------------------- | -------- | ----------------- |
| **Razorpay** | India + International     | INR      | RazorpayX Payouts |

### Previously Evaluated

| Gateway | Status | Reason |
|---------|--------|--------|
| Stripe | **Removed from the code on 2026-10-04** | Invite-only in India since May 2024, no UPI, 5–6% international fees |

Stripe checkout, Stripe webhooks and Stripe Connect payouts were deleted on
2026-10-04, after the request→approve flow had moved to Razorpay and the rail
had sat behind an off-by-default `STRIPE_ENABLED` fence. The `STRIPE` labels
survive in the `PaymentGateway`, `PayoutMethod` and `PayoutAccountType` enums
only until the pre-MVP reset, because existing seed rows still hold them; any
money path that meets one refuses it as a gateway with no implementation.

### Planned Multi-Gateway Roadmap (2026 Evaluation)

Based on the October 2026 regulatory and technical audit ([`gateway-evaluation-2026.md`](./gateway-evaluation-2026.md)), Familiarise's planned multi-gateway architecture is:

| Gateway | Role | Target Use Case & Why |
|---------|------|-----------------------|
| **Razorpay International + MoneySaver** | Immediate International Layer | Enable **Apple Pay**, **PayPal**, **3DS 2.0**, and **MoneySaver Export Account** (virtual USD ACH / EUR SEPA / GBP FPS accounts at `1% + GST`) on our existing Indian entity (`<= ₹25,00,000` per unit under RBI PA-CB with automated e-FIRA/FIRS). See [`razorpay/06-international-payments-and-moneysaver.md`](./razorpay/06-international-payments-and-moneysaver.md). |
| **Cashfree (`CASHFREE`)** | #1 Full-Stack Backup (Pay-ins + Payouts v2 + Verification + Split) | Direct 1:1 drop-in backup to **both** Razorpay PG and RazorpayX Payouts. Holds full **RBI PA + PA-CB** licenses. Lower domestic card fees (`1.60%–1.95%` vs `2%`), `0%` UPI, **Cashfree Payouts v2** (`IMPS`/`UPI`/`NEFT`/`RTGS`), **Secure ID** Penny Drop & Reverse Penny Drop, and **Easy Split**. See [`cashfree/README.md`](./cashfree/README.md). |
| **Tazapay (`TAZAPAY`)** | #1 Global Pay-in + Foreign Consultant Payout Engine | Explicitly supports **EdTech, 1:1 consulting, coaching, and service marketplaces**. Collects in **173+ countries** (cards + **80+ local bank rails** like US ACH, EU SEPA, UK Faster Payments, Pix, PayNow) and holds **multi-currency USD/EUR/GBP balances** to pay **foreign (non-Indian) consultants in 70+ countries** in their local currency without double-FX conversion (`USD -> INR -> USD`) or per-payout Indian Section 393 / Forms 145 & 146 (pre-cutover Section 195 / Forms 15CA & 15CB) wire friction. See [`tazapay/README.md`](./tazapay/README.md). |
| **Xflow (`XFLOW`)** | High-Ticket ($500+) International & B2B Export Rail | Built on **Stripe + JPMorgan Chase N.A.** rails for Indian service exporters. `0.4%–0.6%` tiered fee (`$12` min on Starter) with **0% FX markup** over the live mid-market Google rate and **24-hour automated e-FIRA**. Ideal for `>= $500` international mentorship cohorts and B2B `OrganizationInvoice` collections (`< $300` B2C sessions stay on Razorpay/Cashfree/Tazapay due to the `$12` minimum fee floor). See [`xflow/README.md`](./xflow/README.md). |
| **Dodo Payments (`DODO_PAYMENTS`) & Polar (`Polar.sh`)** | **Disqualified for 1:1 Consulting & Marketplaces** (MoR Reference Only) | Both are **Merchants of Record (MoRs)** whose Acceptable Use Policies explicitly prohibit human 1:1 consulting, coaching, and two-sided marketplaces (see below and [`mor-guardrails/README.md`](./mor-guardrails/README.md)). Restricted strictly to hypothetical 100% automated first-party SaaS or self-paced digital downloads. |

### `DODO_PAYMENTS` — schema-only, and disqualified for 1:1 consulting & marketplaces

`DODO_PAYMENTS` exists as a `PaymentGateway` enum value in Prisma and nothing else. There
is no client, no checkout path, no webhook handler and no payout submitter.

In our October 2026 audit ([`mor-guardrails/README.md`](./mor-guardrails/README.md)), we verified against official Acceptable Use Policies that **Dodo Payments (`dodopayments.com`), Polar (`polar.sh`), Lemon Squeezy, and Paddle cannot be used as a backup gateway for Familiarise's core marketplace**:
1. **Dodo Payments AUP Disqualification**: Explicitly prohibits *"Any product or service where significant human intervention is needed to deliver the good/service"* (Clause #2), *"Consulting Services"* (Clause #14), *"Coaching or anything similar"* (Clause #30), *"Services: Freelance, design, development, marketing, consulting, or agency services"* (Clause #31), and *"Marketplaces: Platforms connecting buyers and sellers"* (Clause #10), backed by a **$425,000 fine** clause for non-compliant card-network transactions and a strict **0.5% dispute/refund threshold**.
2. **Polar.sh AUP Disqualification**: Explicitly prohibits *"Human services"* (Item #2: *"Live courses, synchronous tutoring, or real-time instruction; Consulting, coaching, or mentoring sessions; Custom development, design, or freelance work; Any service requiring scheduled human time or personalized human delivery"*) and *"Marketplaces and platforms"* (Item #4).
3. **MoR Structural Incompatibility**: A Merchant of Record legally acts as the Principal Seller of software on the buyer's card statement and remits a single net bulk payout to the platform; it cannot split funds or pay third-party consultants directly.

Why `DODO_PAYMENTS` remains in the Postgres enum:
- Postgres has no `ALTER TYPE … DROP VALUE`, so keeping the reserved enum value avoids a type recreation and swap before the pre-MVP schema reset.
- Because a schema value with no implementation is exactly the kind of thing that gets picked up by a `default:` branch and silently used, it fails loudly instead. `UNIMPLEMENTED_GATEWAYS` in `lib/payments/constants.ts` names it, and `lib/payments/validation/gateway-guards.ts` throws an `UnsupportedGatewayError` if it ever reaches gateway routing, a refund, or a payout submitter. The payout service also skips a stub-gateway account at *selection* time rather than at disbursement, so a consultant's earnings stay `READY` for the next batch instead of being claimed into `BATCHED` against an unimplemented gateway.

**For a finance or CA review:** treat Dodo as not existing. No money has ever
moved through it, no fees are payable on it, and it appears in no reconciliation
or filing. The only live rail today is Razorpay (INR settlement), and our planned
full-stack backup gateways are **Cashfree (`CASHFREE`)** and **Tazapay (`TAZAPAY`)**.

### Who can transact, and from where

A decision, not merely an observation of the current code — confirmed
2026-07-29 and updated 2026-10-05.

**Consultees: worldwide, and deliberately so.** International cards are
accepted, `routeGateway()` sends a non-IN buyer to Razorpay International / IBT, settlement is
INR, and the FIRS / e-FIRA is generated automatically via Razorpay's PA-CB license. This earns money today and should
not be restricted. The open item is evidentiary rather than functional: a
zero-rated export needs a billing address, an LUT, receipt in convertible
foreign exchange and a FIRC/e-FIRA reference on file, and none of that is captured yet
(`lib/payments/tax/tax-engine.ts` carries the TODO). Buyer-country detection now
defaults to `IN` unless a country was explicitly asserted, so the error
direction is over-collection, which is recoverable.

**Consultants: India only on RazorpayX today; foreign consultants planned via Tazapay multi-currency treasury.**
On our domestic INR rail (RazorpayX), TDS is withheld under
**Section 393 (`§393(1) Table Sl.8(v)`, payment code `1035`; pre-April 1, 2026: Section 194-O)** of the Income-tax Act, 2025, which applies to Indian residents by definition. Remitting INR from an Indian current account to a non-resident
consultant on or after April 1, 2026 requires **Section 393 (`§393(2) Table Sl.17`, payment code `1057`; pre-April 1, 2026: Section 195)** withholding, DTAA relief against a Tax Residency
Certificate (TRC) and Form 10F, and an AD-bank **Form 145 / Form 146** (pre-April 1, 2026: **Form 15CA / Form 15CB**) filing per remittance — and
RazorpayX cannot pay a foreign bank account regardless. `processSinglePayout`
throws for a non-resident rather than half-paying, `lib/compliance/tds.ts` has
the DTAA engine written but unreachable (both callers hardcode
`residencyStatus: "RESIDENT"`), and `lib/compliance/form15.ts` is an
uncalled stub.

That throw is the correct behaviour on the INR domestic rail and should not be "fixed" without either:
1. Building the full Section 393 (`§393(2) Table Sl.17`) + AD-bank Form 145/146 (pre-cutover Section 195 + Form 15CA/15CB) outbound wire path, OR
2. Onboarding **Tazapay (`TAZAPAY`)** as our international collection + multi-currency treasury rail ([`tazapay/README.md`](./tazapay/README.md)), where foreign buyer funds stay in a USD/EUR/GBP Tazapay treasury balance to pay non-Indian consultants directly in 70+ countries (`POST /v3/payout`, `purpose: "PYR003"`) and only Familiarise's net platform commission is repatriated to India in INR with an automated `e-FIRA`.

The current constraint is surfaced to consultants in the product by
`components/payouts/IndiaOnlyPayoutNotice.tsx`, shown during consultant
onboarding and again on the earnings page, so nobody discovers it only after
earning money they cannot withdraw.

> See [`gateway-evaluation-2026.md`](./gateway-evaluation-2026.md) for the complete 2026 architecture and regulatory evaluation across Razorpay International, US LLC + Stripe US (FEMA ODI analysis), Cashfree, Tazapay, Xflow, Dodo Payments, and Polar.sh.

---

## Gateway Selection

All payments route through **Razorpay**. Currency is always **INR** — Razorpay handles FX conversion for international payments via IBT (International Bank Transfer at 1% + GST).

**Gateway detection from payment IDs**:

| ID Prefix          | Gateway  |
| ------------------ | -------- |
| `order_` or `pay_` | Razorpay |

**Buyer location detection** determines tax treatment:
- Indian buyer → Plan price + 18% GST
- International buyer → Plan price only (zero-rated export)

**Source files**:

- Gateway enum and checkout schema: `schemas/checkout.ts`
- Gateway display names and descriptions: `app/checkout/plans/utils.ts`
- Gateway routing/detection logic: `lib/payments/index.ts`

---

## Razorpay Features

| Feature | Details |
| ------- | ------- |
| **Checkout** | Order (`POST /v1/orders`) → Standard Checkout Modal (`checkout.js`) |
| **Saved Cards** | Customers API (`POST /v1/customers` with `fail_existing: 0`) + RBI Card-on-File Tokenization (CoFT) |
| **Refunds** | Full API (`POST /v1/payments/:id/refund` with `X-Refund-Idempotency`). Original PG fee is NOT reversed. |
| **Disputes** | Full REST API (`GET /v1/disputes/:id`, `POST /v1/documents`, `PATCH /v1/disputes/:id/contest`) + all 6 `payment.dispute.*` webhooks (`lib/payments/core/razorpay-disputes.ts`) |
| **Payouts** | RazorpayX: Contacts + Fund Accounts + Penny Drop / Reverse Penny Drop (`POST /v1/fund_accounts/validations`) + Payouts API (`X-Payout-Idempotency`), Section 194-O TDS |
| **KYC & Bank Verification** | Platform collects payee details, creates Contact + Fund Account via API, verifies via Penny Drop (`₹1` IMPS) or Reverse Penny Drop (UPI Intent) |
| **Payment methods** | Cards (Visa, Mastercard, RuPay, Amex, Diners), UPI (0%), Net Banking, Wallets, EMI, PayLater |
| **Domestic fee** | UPI: 0% / Cards & Netbanking: ~2% + 18% GST (~2.36%) |
| **International fee** | Cards: ~3% + GST / International Bank Transfer (IBT): 1% + GST |
| **Settlement** | T+2 working days domestic, T+7 working days international (PA-CB & automatic FIRS/FIRC) |
| **Architecture Choices** | Uses **RazorpayX Payouts** (not Razorpay Route) and **in-house `BillingSubscription` + per-cycle Orders** (not `/v1/subscriptions`) |
| **RBI Licenses** | PA-O + PA-P + PA-CB |

---

## Revenue Split

For B2C bookings, the platform fee is calculated on `grossAmount` (`payment.originalAmount`, the pre-GST base price) via `PlatformFeeSchedule` (`marketplaceBps` / `ownLinkBps`, defaulting to `PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE = 20%`, or `0%` when an active `ConsultantFeeWaiver` applies). For HOST/HYBRID organizations, the 3-way split (`platformBps + orgBps + consultantBps`) is governed by the active `RateCard`.

```
Customer pays grossAmount (+ 18% GST for domestic IN buyers)
    |
    +---> Platform fee: 20% of grossAmount (default B2C marketplace rate; platform absorbs Razorpay PG fee)
    |
    +---> Consultant earnings: 80% of grossAmount
              |
              +---> At payout: Section 194-O TDS withheld (0.1% for Resident Individual/HUF with PAN once
                    FY gross earnings exceed ₹5,00,000/yr; 0.1% from ₹1 for Company/Firm; 5% without PAN)
```

**Sources**: `lib/payments/payouts/constants.ts`, `lib/payments/pricing/platform-fee.ts`, `lib/payments/payouts/earnings-service.ts`, `lib/payments/tax/tds-service.ts`

---

## Environment Variables

### Razorpay (Payments & Webhooks)

| Variable                            | Purpose                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `RAZORPAY_KEY_ID`                   | Server-side API key ID (`rzp_test_...` or `rzp_live_...`)               |
| `RAZORPAY_SECRET`                   | Server-side API key secret (named `RAZORPAY_SECRET` in this repo)       |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID`       | Client-side publishable key (must match `RAZORPAY_KEY_ID`)              |
| `RAZORPAY_WEBHOOK_SECRET`           | Webhook HMAC-SHA256 verification secret                                 |
| `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`  | Optional previous webhook secret during zero-downtime secret rotation   |

### RazorpayX (Payouts & Fund Account Validation)

| Variable                   | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `RAZORPAYX_KEY_ID`         | RazorpayX API key (falls back to `RAZORPAY_KEY_ID` in non-prod)      |
| `RAZORPAYX_KEY_SECRET`     | RazorpayX API secret (falls back to `RAZORPAY_SECRET` in non-prod)   |
| `RAZORPAYX_ACCOUNT_NUMBER` | RazorpayX virtual/current account number debited for payouts & FAV   |
| `RAZORPAYX_WEBHOOK_SECRET` | Optional separate RazorpayX webhook signature verification secret    |
| `ENABLE_LIVE_PAYOUTS`      | Must be `"true"` in production to disburse live payouts              |
| `RAZORPAY_RPD_VPA`         | Optional platform UPI VPA for Reverse Penny Drop fallback            |

---

## Shared Infrastructure

The payment and payout subsystem shares a common orchestration layer:

| File                                           | Purpose                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/payments/index.ts`                        | Unified orchestration — routes `createPaymentIntent()`, `cancelPaymentIntent()`, `createRefund()` to the active gateway                                |
| `lib/payments/core/razorpay.ts`                | Razorpay SDK singleton, checkout & webhook HMAC verification, `ensureRazorpayCustomer()`, PM-10 live-key guard                                         |
| `lib/payments/core/types.ts`                   | Shared types (`PaymentIntent`, `RefundResult`, `DisputeResult`) and error classes (`PaymentError`, `RefundError`, `DisputeError`)                      |
| `lib/payments/core/razorpay-disputes.ts`       | Razorpay REST Disputes & Documents API client (`getRazorpayDispute`, `uploadDisputeDocument`, `contestDispute`, `isRazorpayUnknownDisputeIdError`)      |
| `lib/payments/payouts/razorpay-payouts.ts`     | RazorpayX Contacts, Fund Accounts, and Payouts REST client (`X-Payout-Idempotency`, `boundPayoutIdempotencyKey`)                                       |
| `lib/payments/payouts/reverse-penny-drop.ts`   | Bank & UPI verification via Penny Drop (`POST /v1/fund_accounts/validations`) and Reverse Penny Drop (UPI Intent)                                      |
| `lib/payments/payouts/payout-service.ts`       | Provider-agnostic payout orchestration (batch creation, admin approval, processing)                                                                    |
| `lib/payments/payouts/earnings-service.ts`     | Earnings calculation (`PlatformFeeSchedule`, `RateCard`, subscription tranches, collaborator splits)                                                   |
| `lib/payments/payouts/constants.ts`            | Hold periods, minimum amounts, fee percentages, SAC codes (`999293`), payout mode limits                                                               |

---

## Documentation

### Gateway Evaluation & Regulatory Guardrails

- [gateway-evaluation-2026.md](./gateway-evaluation-2026.md) — October 2026 comprehensive evaluation across Razorpay International, US LLC + Stripe US (FEMA ODI rules), Cashfree, Tazapay, Xflow, Dodo Payments, and Polar.sh
- [mor-guardrails/README.md](./mor-guardrails/README.md) — Why Merchant of Record (MoR) platforms (Dodo Payments, Polar.sh, Lemon Squeezy, Paddle) are disqualified for 1:1 consulting and marketplaces under official AUPs, plus US LLC FEMA ODI compliance guardrails

### Razorpay (Primary Gateway)

- [01-setup.md](./razorpay/01-setup.md) — Account setup, env vars, dashboard config, official test cards & UPI IDs
- [02-architecture-and-flow.md](./razorpay/02-architecture-and-flow.md) — Payment flow, saved cards, revenue split, webhook events, REST disputes API
- [03-payout-flow.md](./razorpay/03-payout-flow.md) — RazorpayX Payouts: Contacts, Fund Accounts, Penny Drop / Reverse Penny Drop, payout lifecycle
- [04-kyc-and-onboarding.md](./razorpay/04-kyc-and-onboarding.md) — KYC requirements and onboarding checklist
- [05-go-live-checklist.md](./razorpay/05-go-live-checklist.md) — Live-mode cutover, PM-10 boot guards, and webhook secret rotation
- [06-international-payments-and-moneysaver.md](./razorpay/06-international-payments-and-moneysaver.md) — International cards, Apple Pay, PayPal, MoneySaver Export Account (Virtual USD/EUR/GBP), RBI PA-CB limits, and automated e-FIRA/FIRS

### Planned Backup & Specialized Gateways

- [cashfree/README.md](./cashfree/README.md) — Cashfree Payments PG v5 (`x-api-version: 2025-01-01`), Cashfree Payouts v2, Secure ID Penny Drop / Reverse Penny Drop, and Easy Split (#1 full-stack domestic + PA-CB backup)
- [tazapay/README.md](./tazapay/README.md) — Tazapay v3 Checkout (80+ local rails in 173+ countries) & Multi-Currency USD/EUR/GBP Treasury for paying foreign non-Indian consultants in 70+ countries without double-FX or Section 195 / Form 15CB friction
- [xflow/README.md](./xflow/README.md) — Xflow v1 High-Ticket ($500+) International & B2B `OrganizationInvoice` export collection on Stripe + JPMorgan rails (0.4%–0.6% fee, 0% FX markup, 24h automated e-FIRA)

---

## Related Documentation

- [Payment Architecture](../01-architecture.md) — Overall payment system design
- [Status Enums Reference](../03-status-enums-reference.md) — PaymentStatus, RefundStatus, DisputeStatus
- [Payouts](../payouts/README.md) — Payout algorithm, earnings lifecycle, batch processing
- [Webhooks](../webhooks/README.md) — Webhook monitoring and schemas
- [Tax Compliance — Marketplace Obligations](../../finances/07-tax-compliance-marketplace-obligations.md) — GST, TCS, TDS, Section 44AD, cross-border compliance
