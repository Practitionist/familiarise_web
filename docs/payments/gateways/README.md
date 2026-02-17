# Payment Gateways

> Overview of Familiarise's payment gateway integrations, selection logic, and configuration.

**Last Updated**: 2026-02-14

---

## Overview

Familiarise uses two payment gateways to serve customers globally:

| Gateway | Region | Currency | Payouts Product |
|---------|--------|----------|-----------------|
| **Razorpay** | India | INR | RazorpayX Payouts |
| **Stripe** | International | USD | Stripe Connect (Express) |

Two additional gateways are registered in the codebase but **not yet production-ready**:

- **Lemon Squeezy** — awaiting KYC completion
- **XFlow** — awaiting production readiness

---

## Gateway Selection

Gateway selection is **user-driven** via the checkout UI. The customer explicitly picks which gateway to use during checkout.

**Currency is forced by gateway**:

- Razorpay selected → currency locked to **INR**
- Stripe selected → currency locked to **USD**

**Gateway detection from payment IDs**:

| ID Prefix | Gateway |
|-----------|---------|
| `cs_` or `pi_` | Stripe |
| `order_` or `pay_` | Razorpay |

**Source files**:

- Gateway enum and checkout schema: `schemas/checkout.ts`
- Gateway display names and descriptions: `app/checkout/plans/utils.ts`
- Gateway routing/detection logic: `lib/payments/index.ts`

---

## Feature Comparison

| Feature | Razorpay | Stripe |
|---------|----------|--------|
| **Checkout** | Order → Modal (client-side SDK) | Checkout Session → Redirect (hosted page) |
| **Refunds** | Full API (create, get, list) | Full API (create, get, list) |
| **Disputes** | Webhook-only (no API management) | Full API (get, submit evidence, list) |
| **Payouts** | RazorpayX: Contacts + Fund Accounts + Payouts API | Stripe Connect: Express accounts + Transfers |
| **KYC** | Platform collects data, creates accounts via API | Stripe handles everything via hosted onboarding |
| **Payment methods** | Cards, UPI, Net Banking, Wallets, EMI | Cards, Apple Pay, Google Pay, ACH, SEPA |
| **Gateway fee** | ~2% + 18% GST (~2.36%) | 2.9% + $0.30 (US), varies by region |
| **Settlement** | T+2 business days | 2-7 business days (varies by country) |

---

## Revenue Split

A **flat 20% platform fee** applies to all consultants regardless of appointment type or pricing.

```
Customer pays amount
    |
    v
Gateway deducts fee (Razorpay ~2.36% / Stripe ~3.2%)
    |
    v
Net amount to platform
    |
    +---> Platform keeps 20% of net
    |
    +---> Consultant receives 80% of net
```

**Source**: `lib/payments/payouts/constants.ts` (`PLATFORM_FEE_PERCENTAGE: 20`)

---

## Environment Variables

### Razorpay (Payments)

| Variable | Purpose |
|----------|---------|
| `RAZORPAY_KEY_ID` | Server-side API key ID |
| `RAZORPAY_SECRET` | Server-side API key secret |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Client-side publishable key |

### RazorpayX (Payouts)

| Variable | Purpose |
|----------|---------|
| `RAZORPAYX_KEY_ID` | RazorpayX API key (falls back to `RAZORPAY_KEY_ID`) |
| `RAZORPAYX_KEY_SECRET` | RazorpayX API secret (falls back to `RAZORPAY_SECRET`) |
| `RAZORPAYX_ACCOUNT_NUMBER` | RazorpayX account number for payouts |
| `RAZORPAYX_WEBHOOK_SECRET` | RazorpayX webhook signature verification |

### Stripe (Payments)

| Variable | Purpose |
|----------|---------|
| `STRIPE_SECRET_KEY` | Server-side secret key |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `NEXT_PUBLIC_STRIPE_KEY` | Client-side publishable key |

### Stripe Connect (Payouts)

| Variable | Purpose |
|----------|---------|
| `STRIPE_CONNECT_CLIENT_ID` | OAuth client ID for Connect |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Connect webhook signature verification |

---

## Shared Infrastructure

Both gateways share a common abstraction layer:

| File | Purpose |
|------|---------|
| `lib/payments/index.ts` | Unified orchestration — routes `createPaymentIntent()`, `cancelPaymentIntent()`, `createRefund()` to the correct gateway |
| `lib/payments/core/types.ts` | Shared types (`PaymentIntent`, `RefundResult`, `DisputeResult`), error classes (`PaymentError`, `RefundError`, `DisputeError`), `CURRENCY_MULTIPLIERS` |
| `lib/payments/payouts/payout-service.ts` | Provider-agnostic payout orchestration (batch creation, admin approval, processing) |
| `lib/payments/payouts/earnings-service.ts` | Earnings calculation with flat 20% platform fee |
| `lib/payments/payouts/constants.ts` | Hold periods, minimum amounts, fee percentages, payout mode limits |

---

## Documentation

### Razorpay

- [01-setup.md](./razorpay/01-setup.md) — Account setup, env vars, dashboard config, testing
- [02-architecture-and-flow.md](./razorpay/02-architecture-and-flow.md) — Payment flow, revenue split, webhook events
- [03-payout-flow.md](./razorpay/03-payout-flow.md) — RazorpayX Payouts: Contacts, Fund Accounts, payout lifecycle
- [04-kyc-and-onboarding.md](./razorpay/04-kyc-and-onboarding.md) — KYC requirements and onboarding checklist

### Stripe

- [01-setup.md](./stripe/01-setup.md) — Account setup, env vars, dashboard config, testing
- [02-architecture-and-flow.md](./stripe/02-architecture-and-flow.md) — Checkout Sessions flow, revenue split, webhook events
- [03-payout-flow.md](./stripe/03-payout-flow.md) — Stripe Connect: Express accounts, transfers, payout lifecycle

---

## Related Documentation

- [Payment Architecture](../01-architecture.md) — Overall payment system design
- [Status Enums Reference](../03-status-enums-reference.md) — PaymentStatus, RefundStatus, DisputeStatus
- [Payouts](../payouts/README.md) — Payout algorithm, earnings lifecycle, batch processing
- [Webhooks](../webhooks/README.md) — Webhook monitoring and schemas
