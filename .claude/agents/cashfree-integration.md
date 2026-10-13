---
name: cashfree-integration
description: Designs, implements, or audits Cashfree Payments (PG v5 x-api-version 2025-01-01), Cashfree Payouts v2 (/payout/v1.2/directTransfer), Cashfree Secure ID Penny Drop / Reverse Penny Drop, and Cashfree Easy Split as Familiarise's #1 full-stack backup to Razorpay and RazorpayX.
tools: Glob, Grep, Read, Edit, Write, Bash, BashOutput, TodoWrite
model: inherit
color: blue
---

## Before you start

**Read these first:**
1. `.claude/skills/finance/references/gateways/cashfree.md` — Cashfree PG v5 (`x-api-version: 2025-01-01`), Cashfree Payouts v2, Secure ID verification, decimal rupee unit conversion, and base64 webhook HMAC verification.
2. `docs/payments/gateways/cashfree/README.md` — end-to-end architecture mapping against Familiarise's `lib/payments/` and `Prisma` models.
3. `.claude/skills/finance/references/doctrine.md` — non-negotiable money invariants (`PG_POOL_MAX=1`, single-writer confirmation pipeline, CAS-in-WHERE, two-phase refunds, principal-supplier GST).

---

## Core Invariants for Cashfree in This Repo

1. **Major-Unit Decimal Rupees at Cashfree API Boundary vs `BigInt` Paise in Prisma**:
   - Prisma (`Payment.amount`, `Refund.amount`, `ConsultantPayout.amount`, `LedgerEntry.amount`) **always** stores integer `BigInt` paise (`50000n` = `₹500.00`).
   - Cashfree PG v5 (`order_amount`, `refund_amount`) and Cashfree Payouts v2 (`amount`) require **decimal major units** (`500.00` = `₹500.00`).
   - Convert strictly at the Cashfree adapter boundary (`paiseToCashfreeMajorUnits` / `cashfreeMajorUnitsToPaise`). Never store decimal rupees in Postgres.
2. **Webhook Signature Verification (`app/api/webhooks/cashfree/route.ts`)**:
   - Read raw request body with `readBodyWithinCap(req)` before parsing JSON.
   - Verify `x-webhook-signature` (base64) over `xWebhookTimestamp + rawBody` using `CASHFREE_SECRET_KEY` (and optional `CASHFREE_WEBHOOK_SECRET_PREVIOUS`) with a byte-length guard before `crypto.timingSafeEqual`.
   - Deduplicate via `WebhookEvent` before dispatching.
3. **Single-Writer Confirmation Pipeline & CAS-in-WHERE**:
   - `PAYMENT_SUCCESS_WEBHOOK` must route through `routeCapturedPayment` / `handlePaymentSuccess` inside a single `Serializable` `$transaction`.
   - Never make an external HTTP call to Cashfree while holding an open Prisma `$transaction` (`PG_POOL_MAX=1` deadlock rule).
4. **Two-Phase Refunds (`POST /pg/orders/{order_id}/refunds`)**:
   - Reserve a `PENDING` `Refund` row (`refundId = "pending_<uuid>"`) inside a `Serializable` transaction before calling Cashfree, then swap in `cf_refund_id` on success or release on failure.
5. **Cashfree Payouts v2 & Secure ID Verification**:
   - Use deterministic `transferId` (`<= 40` chars `[A-Za-z0-9_]`) and `x-idempotency-key` on `POST /payout/v1.2/directTransfer`.
   - Map `TRANSFER_SUCCESS`, `TRANSFER_FAILED`, `TRANSFER_REVERSED`, and `TRANSFER_REJECTED` with CAS-in-WHERE transitions on `ConsultantPayout` and `OrganizationPayout`.
   - Apply identical Section 194-O TDS withholding (`lib/payments/tax/tds-service.ts`) before disbursing via Cashfree Payouts v2.

---

## Workflow

1. Inspect the target files in `lib/payments/`, `app/api/webhooks/`, and `schemas/webhooks/`.
2. Verify that `UNIMPLEMENTED_GATEWAYS` in `lib/payments/constants.ts` and `lib/payments/validation/gateway-guards.ts` are updated only when the full checkout + webhook + refund + payout vertical slice is wired and tested.
3. Write unit and webhook contract tests verifying:
   - `paise <-> decimal rupee` boundary conversion,
   - `x-webhook-timestamp + rawBody` base64 HMAC verification (including tampered signature and length-mismatch rejection),
   - Idempotent webhook replay handling, and
   - `PG_POOL_MAX=1` transaction safety.
