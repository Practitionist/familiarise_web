---
name: razorpay-subscription
description: Explains and works on recurring billing in this repo (in-house BillingSubscription + jobs/billing/ + per-cycle Razorpay Orders), or consults references/not-used-here/subscriptions.md if evaluating Razorpay's /v1/subscriptions API.
tools: Glob, Grep, Read, Edit, Write, Bash, BashOutput, TodoWrite
model: inherit
color: blue
---

## Architectural Decision: Why This Repo Does NOT Use Razorpay `/v1/subscriptions`

**This repository deliberately does NOT use Razorpay's `/v1/subscriptions` or `/v1/plans` APIs.**

Instead, recurring platform and organization billing is managed **in-house**:
1. **State Machine & Schedule**: `BillingSubscription` in `prisma/schema.prisma` and scheduled jobs in `jobs/billing/` track billing periods, renewals, tranches, and dunning.
2. **Per-Cycle Charge via Razorpay Orders (`/v1/orders`)**: Each billing cycle or payment tranche mints a standard Razorpay Order (`POST /v1/orders`) and `Payment` row (`lib/payments/index.ts`), reusing the customer's saved `razorpayCustomerId` (`cust_...` via `ensureRazorpayCustomer`) and the single-writer confirmation pipeline (`routeCapturedPayment` / `handlePaymentSuccess`).
3. **In-House GST Tax Invoices**: Every captured cycle generates a compliant GST tax invoice (`Invoice` / `OrganizationInvoice`) via `lib/invoices/` and `lib/compliance/gst.ts` (SAC `999293`, place-of-supply `CGST 9% + SGST 9%` vs `IGST 18%`). Razorpay's auto-generated subscription invoices are non-GST and cannot be used for Indian GST compliance.
4. **Why**: Razorpay Subscriptions lock UPI/e-mandate subscriptions against mid-cycle plan/amount updates (`PATCH /v1/subscriptions/:id` rejects UPI and Emandate subscriptions), require separate webhook state machines, and auto-mint non-GST invoices.

---

## Before you start

1. **If you are working on this repo's recurring billing, subscription tranches, or organization billing**:
   - Read `.claude/skills/finance/references/razorpay/references/this-repo.md`, `references/orders-and-checkout.md`, `references/customers-and-saved-cards.md`, and `references/gst-invoicing.md`.
   - Inspect `jobs/billing/`, `lib/payments/`, and `BillingSubscription` in `prisma/schema.prisma`.
   - **Never** scaffold `/api/billing/create-subscription`, `razorpay.subscriptions.create()`, or a Drizzle `subscriptions` table.
2. **If the user explicitly asks about Razorpay's native `/v1/subscriptions` API (or is evaluating a product-level migration to it)**:
   - Read `.claude/skills/finance/references/razorpay/references/not-used-here/subscriptions.md` and `references/not-used-here/customer-portal.md`.
   - Keep these verified official Razorpay Subscriptions API pitfalls in mind:
     - **Signature verification**: Subscription checkout signs `razorpay_payment_id + "|" + razorpay_subscription_id` (payment ID first, unlike Orders which sign `order_id + "|" + payment_id`).
     - **Pause / Resume API**: `POST /v1/subscriptions/:id/pause` takes `{ pause_at: "now" }` and `POST /v1/subscriptions/:id/resume` takes `{ resume_at: "now" }`. (`pause_initiated_by` / `resume_initiated_by` are response-only fields, never request fields.) <!-- drift-ok -->
     - **Cancel API on `razorpay@2.9.6`**: `razorpay.subscriptions.cancel(subId, cancelAtCycleEnd)` takes a **positional boolean** (`true` = end of cycle, `false` = immediate) as its second argument — passing `{ cancel_at_cycle_end: false }` is truthy in JS and silently inverts to `{ cancel_at_cycle_end: 1 }`!
     - **`current_end` is `null` before activation**: On `created` and `authenticated` states, `current_end` is `null`; only populate period-end timestamps once `subscription.activated` or `subscription.charged` fires.
     - **UPI / e-Mandate update restriction**: Razorpay does not allow `PATCH /v1/subscriptions/:id` on subscriptions authorized via UPI or Emandate.
