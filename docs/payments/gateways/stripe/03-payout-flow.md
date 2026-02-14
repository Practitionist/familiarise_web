# Stripe Connect Payout Flow

> How international consultants receive their earnings through Stripe Connect Express accounts.

**Last Updated**: 2026-02-14

---

## Overview

International consultant payouts are handled through **Stripe Connect** using Express accounts. Stripe handles all onboarding, identity verification, tax forms, and compliance — we just create the account and initiate transfers.

---

## Key Concepts

### Connected Account Architecture

```
+---------------------------------------------------------------------+
|              FAMILIARISE STRIPE PLATFORM ACCOUNT                     |
|                    (Master Account)                                  |
|                                                                      |
|  +------------------+  +------------------+  +------------------+    |
|  |   Connected       |  |   Connected       |  |   Connected       |  |
|  |   Account (USA)   |  |   Account (UK)    |  |   Account (DE)    |  |
|  |   acct_xxxxx1     |  |   acct_xxxxx2     |  |   acct_xxxxx3     |  |
|  +--------+---------+  +--------+---------+  +--------+---------+    |
|           |                     |                     |              |
+---------------------------------------------------------------------+
            |                     |                     |
            v                    v                     v
    +--------------+     +--------------+     +--------------+
    | Chase Bank   |     | Barclays     |     | Deutsche     |
    | (USD)        |     | (GBP)        |     | Bank (EUR)   |
    +--------------+     +--------------+     +--------------+
```

### Express Accounts (What We Use)

| Aspect | Detail |
|--------|--------|
| Onboarding | Stripe handles everything via hosted UI |
| Identity verification | Stripe verifies per-country requirements |
| Tax forms | Stripe collects W-9, W-8BEN, etc. |
| Bank details | Collected by Stripe directly |
| Dashboard | Consultant gets limited Stripe Express dashboard |
| Our responsibility | Create account, generate onboarding link, initiate transfers |

The consultant never needs to sign up for Stripe independently. We create an Express account for them and send an onboarding link.

---

## Consultant Onboarding

### Flow

```
Familiarise Server              Stripe                    Consultant
       |                           |                           |
       |  1. Create Express        |                           |
       |     Account               |                           |
       |-------------------------->|                           |
       |                           |                           |
       |  2. Return acct_xxxxx     |                           |
       |<--------------------------|                           |
       |                           |                           |
       |  3. Create Account Link   |                           |
       |     (onboarding URL)      |                           |
       |-------------------------->|                           |
       |                           |                           |
       |  4. Send URL to           |                           |
       |     consultant            |                           |
       |-------------------------------------------------->   |
       |                           |                           |
       |                           |  5. Consultant fills:     |
       |                           |     - Personal info       |
       |                           |     - Identity docs       |
       |                           |     - Bank account        |
       |                           |     - Tax info            |
       |                           |<------------------------->|
       |                           |                           |
       |  6. Webhook:              |                           |
       |     account.updated       |                           |
       |<--------------------------|                           |
       |                           |                           |
       |  7. Consultant redirected back                        |
       |<------------------------------------------------------|
```

### Account Status States

```
+-------------------+
| restricted        |  Just created, needs onboarding
+--------+----------+
         |
         | Consultant completes onboarding
         v
+-------------------+
| pending           |  Under Stripe review
+--------+----------+
         |
         | Stripe approves
         v
+-------------------+
| enabled           |  Ready for transfers
+-------------------+
```

| Status | Meaning | Can Receive Transfers |
|--------|---------|----------------------|
| `restricted` | Onboarding incomplete, action needed | No |
| `pending` | Under Stripe review | No |
| `enabled` | Fully operational | Yes |

### Account Requirements Tracking

Stripe provides detailed requirement tracking:

- **currentlyDue** — Must be provided now for account to function
- **eventuallyDue** — Must be provided before a deadline
- **pastDue** — Overdue, account may be restricted
- **pendingVerification** — Submitted but awaiting Stripe review

### Dashboard Access

Consultants can access a limited Stripe Express dashboard via a login link. This lets them view their balance, payout history, and update bank details.

---

## Transfer and Payout Flow

### Two-Step Process

Payouts involve two steps:

1. **Transfer**: Platform account → Connected account (we initiate this)
2. **Payout**: Connected account → Consultant's bank (Stripe handles this automatically)

### Weekly Payout Cycle

```
Earnings accumulate throughout the week
        |
        v
Hold periods expire:
  - Consultation: 24 hours
  - Webinar: 48 hours
  - Subscription: 7 days
  - Class: 24 hours
        |
        v
Weekly payout job runs:
  - Find consultants with READY earnings
  - Check: account status = enabled
  - Check: available balance >= minimum
        |
        v
Create Transfers:
  - One transfer per consultant
  - Amount in USD (platform currency)
  - Stripe converts to consultant's bank currency
        |
        v
Stripe processes automatically:
  - Funds appear in connected account
  - Stripe initiates bank payout
  - Settlement: 2-7 business days (varies by country)
        |
        v
Webhooks confirm completion
```

### Settlement Times by Country

| Country | Settlement |
|---------|-----------|
| USA | 2 business days |
| UK | 3 business days |
| EU (SEPA) | 4 business days |
| Australia | 3 business days |
| Canada | 2 business days |
| Others | 5-7 business days |

### Multi-Currency Transfers

```
Customer pays: $100 USD
        |
        v
Platform holds: USD
        |
        v
Transfer created: $77.44 USD to acct_xxxxx
        |
        v
Stripe converts to consultant's bank currency
  (e.g., ~62 GBP for UK consultant)
  (~2% FX fee built into conversion rate)
        |
        v
Deposited in: Consultant's bank (local currency)
```

---

## Payout States

### Stripe Payout Status Mapping

| Stripe Status | Internal Status | Description |
|---------------|----------------|-------------|
| `pending` | PENDING | Payout initiated, awaiting processing |
| `in_transit` | PROCESSING | Funds being transferred to bank |
| `paid` | COMPLETED | Funds deposited in bank |
| `failed` | FAILED | Payout failed |
| `canceled` | CANCELLED | Payout cancelled |

### Earnings Status Flow

```
+-------------------+
|     ON_HOLD       |  Hold period active (24h-7 days)
+--------+----------+
         |
         | Hold expires
         v
+-------------------+
|    AVAILABLE      |  Ready for weekly payout
+--------+----------+
         |
         | Weekly payout job
         v
+-------------------+
|   PROCESSING      |  Transfer created to connected account
+--------+----------+
         |
    +----+----+
    |         |
    v         v
+-------+ +-------+
| PAID  | |FAILED |  Transfer succeeded or failed
+-------+ +-------+

Special states:
  REFUNDED  — Payment refunded, earnings cancelled
  DISPUTED  — Customer raised dispute, earnings frozen
```

---

## Webhook Events

| Event | When It Fires | What We Do |
|-------|--------------|------------|
| `payout.created` | Payout initiated | Log payout creation |
| `payout.paid` | Funds in bank | Mark payout COMPLETED, earnings as PAID, notify consultant |
| `payout.failed` | Payout failed | Mark payout FAILED, revert earnings to AVAILABLE, alert admin |
| `payout.canceled` | Payout cancelled | Mark payout CANCELLED |
| `account.updated` | Account status changed | Update consultant's account status, check requirements |
| `transfer.created` | Transfer initiated | Log transfer, update payout to PROCESSING |
| `transfer.reversed` | Transfer clawed back | Handle reversal, restore balance |

**Source**: `app/api/webhooks/stripe/route.ts`

---

## Transfer Reversal

The system supports reversing transfers (clawback), used in cases like:

- Refund after funds already transferred to consultant
- Dispute resolved in customer's favor
- Erroneous transfer

Reversals deduct from the connected account's available balance.

---

## Common Scenarios

### Normal Payout

```
Monday:     Customer pays $100
            Earnings created: $77.44 (ON_HOLD)

Tuesday:    24-hour hold expires
            Earnings become AVAILABLE

Sunday:     Payout job identifies consultant
            Available balance: $77.44, account: enabled

Monday:     Transfer created to connected account
            Earnings: PROCESSING

Wednesday:  Transfer completes (US bank, 2 days)
            Webhook: payout.paid
            Earnings: PAID
```

### Refund During Hold

```
Monday:    Customer pays $100
           Earnings: ON_HOLD

Tuesday:   Customer requests refund (within 24hr hold)
           Refund processed
           Earnings: REFUNDED
           Consultant never sees funds
```

### Failed Transfer

```
Monday:    Transfer created to consultant

Tuesday:   Transfer fails
           Reason: "Bank account closed"
           Webhook: payout.failed

Actions:
  - Earnings reverted to AVAILABLE
  - Operations team alerted
  - Consultant notified to update bank details
  - Will retry on next payout cycle (up to 3 attempts)
```

### Account Restricted

```
Consultant onboarded successfully

Later:     Stripe restricts account
           Reason: Additional verification needed
           Webhook: account.updated

Impact:
  - Transfers blocked until resolved
  - Consultant notified
  - Funds accumulate until account re-enabled
```

---

## Source Files

| File | Purpose |
|------|---------|
| `lib/payments/payouts/stripe-connect.ts` | StripeConnectService — accounts, transfers, payouts, balance |
| `lib/payments/payouts/payout-service.ts` | Provider-agnostic orchestration — batch creation, approval, processing |
| `lib/payments/payouts/constants.ts` | Hold periods, minimum amounts, fee percentages |
| `lib/payments/payouts/earnings-service.ts` | Earnings calculation (flat 20% platform fee) |
| `app/api/webhooks/stripe/route.ts` | Webhook handler for Connect events |

---

## Related Documents

- [Gateway Overview](../README.md) — Comparison and selection logic
- [01-setup.md](./01-setup.md) — Setup and configuration
- [02-architecture-and-flow.md](./02-architecture-and-flow.md) — Checkout Sessions flow and revenue split
- [Payouts Overview](../../payouts/README.md) — Full payout system documentation
- [Payouts: Stripe Implementation](../../payouts/08-stripe-implementation.md) — Detailed implementation reference
