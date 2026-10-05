# Alternative Payment Gateways & Cross-Border Reference Pack

Reference material for Familiarise's multi-gateway roadmap, backup domestic/international payment aggregators, foreign consultant payout treasury, B2B export collection, and Merchant of Record (MoR) / FEMA compliance guardrails.

All claims in this pack have been verified against official vendor documentation and regulatory texts as of October 2026:
- **Cashfree Payments (`docs.cashfree.com`)**
- **Tazapay (`docs.tazapay.com`)**
- **Xflow (`docs.xflowpay.com`)**
- **Dodo Payments (`docs.dodopayments.com` & Acceptable Use Policy)**
- **Polar.sh (`polar.sh/docs` & Acceptable Use Policy)**
- **RBI PA-CB Circular (`CO.DPSS.POLC.No.S-786/02-14-008/2023-24`) & FEMA (Overseas Investment) Rules, 2022**

## Reference Index

| File | Gateway / Topic | Load when working on… |
| --- | --- | --- |
| [`cashfree.md`](cashfree.md) | **Cashfree Payments (`CASHFREE`) & Cashfree Payouts v2** | Implementing or reviewing our **#1 full-stack domestic + PA-CB backup** to Razorpay PG and RazorpayX Payouts: Orders v5 (`x-api-version: 2025-01-01`, decimal rupee conversion from `BigInt` paise), `payment_session_id` JS SDK v3, base64 webhook HMAC (`x-webhook-timestamp + rawBody`), Refunds, Disputes, Cashfree Payouts v2 (`/payout/v1.2/directTransfer`), Secure ID Penny Drop / Reverse Penny Drop, and Easy Split. |
| [`tazapay.md`](tazapay.md) | **Tazapay (`TAZAPAY`) Global Pay-ins & Foreign Consultant Payouts** | Implementing or reviewing our **#1 international checkout (80+ local rails in 173+ countries) + multi-currency USD/EUR/GBP treasury** for paying **foreign (non-Indian) consultants in 70+ countries** (`POST /v3/checkout`, `POST /v3/beneficiary`, `POST /v3/payout` with `purpose: "PYR003"`, webhook verification, and avoiding double-FX + Section 393 / Forms 145 & 146 [formerly Section 195 / Forms 15CA & 15CB] friction). |
| [`xflow.md`](xflow.md) | **Xflow (`XFLOW`) High-Ticket ($500+) & B2B Export Collection** | Implementing or reviewing high-ticket (`>= $500`) international mentorship & B2B `OrganizationInvoice` collection on Stripe + JPMorgan rails (`0.4%–0.6%` tiered fee, `0%` FX markup over live Google rate, `$12` starter minimum floor, `POST /v1/receivables`, `Webhook-Id` / `Webhook-Timestamp` / `Webhook-Signature` Base64 verification, and 24-hour automated `e-FIRA`). |
| [`mor-dodo-polar.md`](mor-dodo-polar.md) | **Dodo Payments, Polar.sh & US LLC FEMA/ODI Guardrails** | Understanding why **Dodo Payments (`DODO_PAYMENTS`)** and **Polar.sh** are **strictly disqualified** for 1:1 consulting and two-sided marketplaces under their official AUPs (Dodo Clauses #2/#10/#14/#30/#31 + $425k fine; Polar Items #2/#4), why US LLC formation requires RBI FEMA ODI routing (`Form FC` + `UIN` + `APR` + IRS `Form 5472`), and how to integrate Dodo/Polar (`Standard Webhooks`) ONLY if Familiarise ever launches a 100% automated first-party SaaS / digital product SKU. |

---

## Gateway Routing & Architectural Summary

```
                      +-----------------------------------------------+
                      |           Incoming Checkout / Payout          |
                      +-----------------------------------------------+
                                              |
        +-------------------------------------+-------------------------------------+
        |                                     |                                     |
        v                                     v                                     v
+-------------------------------+   +-----------------------------------+   +-------------------------------+
| Domestic IN Buyer (INR)       |   | International B2C Buyer (< $500)  |   | High-Ticket Intl (>= $500)    |
| Primary: Razorpay PG (UPI 0%) |   | Primary: Razorpay Intl (Apple Pay |   | or B2B OrganizationInvoice    |
| Backup:  Cashfree PG v5       |   |          / PayPal) or Tazapay v3  |   | Rail: Xflow (0.4-0.6%, 0% FX) |
+-------------------------------+   +-----------------------------------+   | or Razorpay MoneySaver (1%)   |
        |                                     |                             +-------------------------------+
        v                                     v                                             |
+-------------------------------+   +-----------------------------------+                   |
| Indian Resident Consultant    |   | Foreign Non-Indian Consultant     |                   |
| Primary: RazorpayX Payouts    |   | Rail: Tazapay Multi-Currency      | <-----------------+
| Backup:  Cashfree Payouts v2  |   |       Treasury (USD/EUR/GBP local |
| (Sec 393 / 194-O TDS, INR)    |   |       payout in 70+ countries)    |
+-------------------------------+   +-----------------------------------+
```

## Non-Negotiable Integration Rules Across All Gateways

1. **Money Truth Invariants Apply Unchanged (`../doctrine.md`)**:
   - Every gateway confirmation (`PAYMENT_SUCCESS_WEBHOOK`, `payment.succeeded`, `receivable.amount_reconciled.updated`) MUST flow through our single-writer confirmation pipeline inside a single `Serializable` `$transaction` with CAS-in-WHERE status guards.
   - Never make an external HTTP call to Cashfree, Tazapay, Xflow, or Dodo while holding an open Prisma `$transaction` (`PG_POOL_MAX=1` deadlock rule).
2. **Unit Conversion at the Gateway Boundary**:
   - Prisma stores all amounts in **`BigInt` minor units (`paise` / `cents`)**.
   - **Razorpay, Tazapay, Dodo, Polar**: Expect integer minor units (`paise` / `cents`).
   - **Cashfree PG v5 & Cashfree Payouts v2**: Expect **major units (`rupees` / `dollars`) as decimals** (`Number(amountPaise) / 100`). Always convert at the HTTP adapter boundary only!
   - **Xflow v1**: Expects decimal string major units (e.g., `"2000.00"`).
3. **Never Enable `DODO_PAYMENTS` or `Polar.sh` for 1:1 Consultations, Webinars, Classes, or Consultant Splits**:
   - See [`mor-dodo-polar.md`](mor-dodo-polar.md) and [`docs/payments/gateways/mor-guardrails/README.md`](../../../../docs/payments/gateways/mor-guardrails/README.md).
