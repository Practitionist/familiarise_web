# Payment Gateways

> Overview of Familiarise's payment gateway integrations, selection logic, and configuration.

**Last Updated**: 2026-03-19

---

## Overview

Familiarise uses **Razorpay as the sole payment gateway** for both domestic and international payments:

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

### Future Consideration

| Gateway | When | Why |
|---------|------|-----|
| **Dodo Payments** | Post-MVP, no timeline | Sanctioned second gateway. **Schema-only today** — see below. |
| Cashfree | Month 3-6 | Cheaper fees (1.6–1.95% vs 2%), better split fees (0.1% vs 0.25%) |
| Wise Business | International payouts | Best FX rates for paying international consultants |

### Dodo Payments — schema-only, deliberately

`DODO_PAYMENTS` exists as a `PaymentGateway` enum value and nothing else. There
is no client, no checkout path, no webhook handler and no payout submitter, and
there is no date attached to building any of them.

It is present so the enum does not have to change later — Postgres has no
`ALTER TYPE … DROP VALUE`, so adding a value costs nothing while removing one
costs a type recreation and swap. Keeping the value reserved is cheaper than
adding it under time pressure.

Because a schema value with no implementation is exactly the kind of thing that
gets picked up by a `default:` branch and silently used, it fails loudly
instead. `UNIMPLEMENTED_GATEWAYS` in `lib/payments/constants.ts` names it, and
`lib/payments/validation/gateway-guards.ts` throws an `UnsupportedGatewayError`
if it ever reaches gateway routing, a refund, or a payout submitter. The payout
service also skips a stub-gateway account at *selection* time rather than at
disbursement, so a consultant's earnings stay `READY` for the next batch
instead of being claimed into `BATCHED` against a gateway that will never
exist.

**For a finance or CA review:** treat Dodo as not existing. No money has ever
moved through it, no fees are payable on it, and it appears in no reconciliation
or filing. The only live rail is Razorpay (INR settlement).

### Who can transact, and from where

A decision, not merely an observation of the current code — confirmed
2026-07-29.

**Consultees: worldwide, and deliberately so.** International cards are
accepted, `routeGateway()` sends a non-IN buyer to Razorpay IBT, settlement is
INR, and the FIRC is generated automatically. This earns money today and should
not be restricted. The open item is evidentiary rather than functional: a
zero-rated export needs a billing address, an LUT, receipt in convertible
foreign exchange and a FIRC reference on file, and none of that is captured yet
(`lib/payments/tax/tax-engine.ts` carries the TODO). Buyer-country detection now
defaults to `IN` unless a country was explicitly asserted, so the error
direction is over-collection, which is recoverable.

**Consultants: India only, until Section 195 is built.** TDS is withheld under
Section 194-O, which applies to residents by definition. A non-resident
consultant needs Section 195 withholding, DTAA relief against a tax residency
certificate and Form 10F, and a Form 15CA/15CB filing per remittance — and
RazorpayX cannot pay a foreign bank account regardless. `processSinglePayout`
throws for a non-resident rather than half-paying, `lib/compliance/tds.ts` has
the DTAA engine written but unreachable (both callers hardcode
`residencyStatus: "RESIDENT"`), and `lib/compliance/form15.ts` is an
uncalled stub.

That throw is the correct behaviour and should not be "fixed" without building
the withholding path behind it. Removing it would produce a statutory
withholding failure rather than a feature. The constraint is surfaced to
consultants in the product by
`components/payouts/IndiaOnlyPayoutNotice.tsx`, shown during consultant
onboarding and again on the earnings page, so nobody discovers it only after
earning money they cannot withdraw.

### Not under consideration

Lemon Squeezy and XFlow were evaluated in March 2026 and rejected — Lemon
Squeezy prohibits services in its ToS and charges ~6.5%, and XFlow is
cross-border B2B settlement infrastructure rather than a gateway. Both were
removed from the codebase in #984. The dated analysis is preserved in
[gateway-evaluation-mar-2026.md](./gateway-evaluation-mar-2026.md) so the
decision is not re-litigated; neither is a current option.

> See [gateway-evaluation-mar-2026.md](./gateway-evaluation-mar-2026.md) for the full analysis.

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

### Gateway Evaluation

- [gateway-evaluation-mar-2026.md](./gateway-evaluation-mar-2026.md) — the dated March 2026 comparison that produced the current choice. Historical: the gateways it rejected have since been removed from the codebase.

### Razorpay

- [01-setup.md](./razorpay/01-setup.md) — Account setup, env vars, dashboard config, official test cards & UPI IDs
- [02-architecture-and-flow.md](./razorpay/02-architecture-and-flow.md) — Payment flow, saved cards, revenue split, webhook events, REST disputes API
- [03-payout-flow.md](./razorpay/03-payout-flow.md) — RazorpayX Payouts: Contacts, Fund Accounts, Penny Drop / Reverse Penny Drop, payout lifecycle
- [04-kyc-and-onboarding.md](./razorpay/04-kyc-and-onboarding.md) — KYC requirements and onboarding checklist
- [05-go-live-checklist.md](./razorpay/05-go-live-checklist.md) — Live-mode cutover, PM-10 boot guards, and webhook secret rotation

---

## Related Documentation

- [Payment Architecture](../01-architecture.md) — Overall payment system design
- [Status Enums Reference](../03-status-enums-reference.md) — PaymentStatus, RefundStatus, DisputeStatus
- [Payouts](../payouts/README.md) — Payout algorithm, earnings lifecycle, batch processing
- [Webhooks](../webhooks/README.md) — Webhook monitoring and schemas
- [Tax Compliance — Marketplace Obligations](../../finances/07-tax-compliance-marketplace-obligations.md) — GST, TCS, TDS, Section 44AD, cross-border compliance
