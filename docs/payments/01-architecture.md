# Payment System Architecture

> Complete documentation of the payment processing system including checkout, webhooks, refunds, disputes, and reconciliation flows.

## Table of Contents

1. [Overview](#overview)
2. [Database Models](#database-models)
3. [File Structure](#file-structure)
4. [Checkout Flow](#checkout-flow)
5. [Webhook Flow](#webhook-flow)
6. [Refund Flow](#refund-flow)
7. [Dispute Flow](#dispute-flow)
8. [Reconciliation Flows](#reconciliation-flows)
9. [GitHub Actions & Cron Jobs](#github-actions--cron-jobs)
10. [Complete Data Flow Summary](#complete-data-flow-summary)

---

## Overview

The payment system uses **Razorpay** as the sole active payment gateway. Stripe is implemented but fenced off, and `DODO_PAYMENTS` exists in the `PaymentGateway` enum as a post-MVP placeholder with no implementation behind it. `POST_MVP_GATEWAY_STUBS` in `lib/payments/constants.ts` is the placeholder list, and `assertGatewayUsable` in `lib/payments/validation/gateway-guards.ts` refuses both a placeholder and a fenced-off gateway at runtime.

| Gateway           | Status                  | How it is gated                                                                                                                                                                                                                                                                                                             |
| ----------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Razorpay**      | Live, primary           | No flag. `routeGateway` selects it for every buyer country, domestic directly and international over IBT.                                                                                                                                                                                                                   |
| **Stripe**        | Implemented, fenced off | `STRIPE_ENABLED=true` on the server and `NEXT_PUBLIC_STRIPE_ENABLED=true` in the checkout UI. Auto-routing never selects it; only an explicit request reaches it, and `assertGatewayUsable` throws a `DisabledGatewayError` when the flag is unset. Refunds of existing Stripe payments are deliberately outside the fence. |
| **Dodo Payments** | Schema placeholder      | Listed in `POST_MVP_GATEWAY_STUBS`. Any use throws `UnsupportedGatewayError`.                                                                                                                                                                                                                                               |

Stripe is retained as a contingency rail in case RBI rules make Razorpay unusable for a class of collections, and for Connect transfers if international payouts are ever turned on. It is not a live payment method, so no customer should ever see the Stripe button.

The system handles four appointment types:

| Type             | Description          | Slot Handling                      |
| ---------------- | -------------------- | ---------------------------------- |
| **CONSULTATION** | 1-on-1 session       | Single slot, exclusive             |
| **SUBSCRIPTION** | Recurring sessions   | Multiple slots over period         |
| **WEBINAR**      | Multi-user event     | Shared slot, per-user confirmation |
| **CLASS**        | Multi-session course | Multiple shared slots              |

### Key Safety Features

- **Tentative Appointments**: Created during checkout with `isTentative=true`, confirmed only after webhook
- **Distributed Locking**: Prevents double-booking same slot during concurrent checkouts
- **Two-Phase Refund Pattern**: Atomically claims amount before gateway call
- **Reconciliation Crons**: Catch stuck records from crashes/timeouts
- **Webhook Idempotency**: All handlers check if record already exists/processed
- **Payout Webhook Idempotency** (Mar 2026): `handlePayoutWebhook` uses atomic `updateMany` with terminal-status guard to prevent double-applying revenue
- **Razorpay Composite EventId** (Mar 2026): Webhook eventId formatted as `{eventType}:{entityId}` to prevent cross-event collisions
- **Post-Commit Emails** (Mar 2026): Payment success notifications sent after transaction commits to prevent false confirmations on rollback
- **Payout Batch Integrity** (Mar 2026): Each consultant's batch payout wrapped in `$transaction` with count-mismatch guard

---

## Database Models

### Core Payment Models (Prisma Schema)

```
+-----------------------------------------------------------------------------------+
|                              PAYMENT MODELS                                       |
+-----------------------------------------------------------------------------------+

+----------------------+
|       Payment        |
+----------------------+
| id                   |
| amount               |
| currency             |
| paymentIntent (unique)|------------+
| paymentGateway       |            |
| paymentStatus        |            |
| expiresAt            |            |
| isMockPayment        |            |
| userId --------------|---> User   |
| appointmentId -------|---> Appointment
| discountCodeId       |            |
+----------------------+            |
| refunds[] -----------|---> Refund[]
| disputes[] ----------|---> Dispute[]
+----------------------+            |
                                    |
+----------------------+            |
|       Refund         |<-----------+
+----------------------+
| id                   |
| refundId (unique)    |   <- Gateway ID or "pending_xxx"
| amount               |
| currency             |
| reason               |
| status               |   <- PENDING | SUCCEEDED | FAILED | CANCELLED
| paymentGateway       |
| metadata (JSON)      |
| paymentId            |
+----------------------+

+----------------------+
|       Dispute        |
+----------------------+
| id                   |
| disputeId (unique)   |   <- Gateway ID
| amount               |
| currency             |
| reason               |
| status               |   <- See DisputeStatus enum
| paymentGateway       |
| evidence (JSON)      |
| dueBy                |   <- Response deadline
| isChargeRefundable   |
| paymentId            |
+----------------------+
```

### Appointment & Slot Models

```
+----------------------+       +----------------------+
|     Appointment      |       |   AppointmentOccurrence  |
+----------------------+       +----------------------+
| id                   |       | id                   |
| appointmentType      |       | startsAt             |
| consultationId ------|--+    | endsAt               |
| subscriptionId ------|--|    | isTentative ----------|---> true = unconfirmed
| webinarId -----------|--|    | appointmentId        |
| classId -------------|--|    | user[] --------------|---> User[] (many-to-many)
+----------------------+  |    +----------------------+
| appointmentOccurrences[] |--|--> AppointmentOccurrence[]
| payment[]            |  |
| documents[]          |  |
+----------------------+  |
                          |
          +---------------+---------------+
          |                               |
          v                               v
+----------------------+       +----------------------+
|    Consultation      |       |    Subscription      |
+----------------------+       +----------------------+
| id                   |       | id                   |
| consultationPlanId   |       | subscriptionPlanId   |
| status (AppointmentStatus) |  | status (AppointmentStatus) |
| requestedById        |       | requestedById        |
| pendingPaymentUrl    |       | pendingPaymentUrl    |
| bookingSource        |       | schedulingPeriod*    |
+----------------------+       +----------------------+
```

### Status Enums

```
PaymentStatus:
  PENDING    -> Awaiting payment confirmation
  SUCCEEDED  -> Payment completed
  FAILED     -> Payment failed or expired

RefundStatus:
  PENDING    -> Refund initiated, awaiting processing
  SUCCEEDED  -> Refund completed
  FAILED     -> Refund failed
  CANCELLED  -> Refund cancelled

DisputeStatus:
  WARNING_NEEDS_RESPONSE   -> Early fraud warning
  WARNING_UNDER_REVIEW     -> Warning being reviewed
  WARNING_CLOSED           -> Warning resolved
  NEEDS_RESPONSE           -> Dispute filed, needs evidence
  UNDER_REVIEW             -> Evidence submitted
  CHARGE_REFUNDED          -> Proactively refunded
  WON                      -> Dispute won
  LOST                     -> Dispute lost

AppointmentStatus:
  PENDING                  -> Awaiting approval
  APPROVED                 -> Approved by consultant
  APPROVED_PENDING_PAYMENT -> Approved, awaiting payment
  SCHEDULED                -> Fully booked
  COMPLETED                -> Session completed
  REJECTED                 -> Request rejected
  CANCELLED                -> Cancelled
  EXPIRED                  -> Expired
```

---

## File Structure

### Checkout Files

| File                                           | Purpose                       | Lines |
| ---------------------------------------------- | ----------------------------- | ----- |
| `lib/payments/operations/checkout.ts`          | Core checkout logic           | ~1445 |
| `app/api/checkout/route.ts`                    | Checkout API endpoint         | ~150  |
| `app/checkout/components/StripeCheckout.tsx`   | Stripe payment component      | ~120  |
| `app/checkout/components/RazorpayCheckout.tsx` | Razorpay payment component    | ~140  |
| `app/checkout/plans/utils.ts`                  | Checkout utilities & handlers | ~200  |
| `schemas/checkout.ts`                          | Zod validation schemas        | ~180  |
| `types/checkout.ts`                            | TypeScript interfaces         | ~100  |
| `actions/checkout.action.ts`                   | Server action wrapper         | ~50   |

### Checkout Pages

| File                                                  | Appointment Type     |
| ----------------------------------------------------- | -------------------- |
| `app/checkout/plans/consultation/[planId]/page.tsx`   | Consultation         |
| `app/checkout/plans/subscription/[planId]/page.tsx`   | Subscription         |
| `app/checkout/plans/webinar/[webinarPlanId]/page.tsx` | Webinar              |
| `app/checkout/plans/class/[classPlanId]/page.tsx`     | Class                |
| `app/checkout/checkout-success/page.tsx`              | Success confirmation |

### Webhook Files

| File                                                     | Purpose                                                             | Lines |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ----- |
| `app/api/webhooks/stripe/route.ts`                       | Stripe webhook endpoint                                             | ~125  |
| `app/api/webhooks/razorpay/route.ts`                     | Razorpay webhook endpoint                                           | ~147  |
| `app/api/webhooks/utils.ts`                              | Shared webhook utilities & dispute/org handlers                     | ~2530 |
| `lib/payments/webhooks/handlers.ts`                      | Payment success/failure state-machine handlers                      | ~1900 |
| `lib/payments/webhooks/legacy-appointment-creation.ts`   | Legacy webhook fallback appointment creation & slot allocation      | ~810  |
| `lib/payments/webhooks/staged-emails.ts`                 | Phase 1 transactional email outbox staging & notification context   | ~350  |
| `schemas/webhooks/stripe.ts`                             | Stripe event schemas                                                | ~105  |
| `schemas/webhooks/razorpay.ts`                           | Razorpay event schemas                                              | ~105  |
| `schemas/webhooks/metadata.ts`                           | Appointment metadata validation                                     | ~115  |

### Refund & Dispute Files

| File                                          | Purpose                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `lib/payments/operations/refund.ts`           | Core refund cascade (`applyRefundCascade`) & credit note minting        |
| `lib/payments/operations/reversal-engine.ts`  | Unified reversal engine (wallet, unbilled/paid invoice, payout clawback)|
| `app/api/payments/refunds/route.ts`           | Refund creation & listing                                               |
| `app/api/payments/disputes/route.ts`          | Dispute listing & evidence submission                                   |
| `app/api/admin/refunds/route.ts`              | Admin refund dashboard API                                              |
| `app/api/admin/disputes/route.ts`             | Admin dispute dashboard API                                             |
| `app/api/admin/disputes/[disputeId]/route.ts` | Dispute detail API                                                      |

### Reconciliation & Cleanup Dispatcher

All payment, refund, dispute, and payout cleanup/reconciliation jobs are registered in `lib/cron/cleanup-registry.ts` and exposed through a single dynamic route (`app/api/cleanup/[job]/route.ts`) protected by `CRON_SECRET` and serialized via Postgres leases (`lib/cron/with-cron-lock.ts`).

| Job Slug (`lib/cron/cleanup-registry.ts`) | Implementation                          | Schedule                           |
| ----------------------------------------- | --------------------------------------- | ---------------------------------- |
| `abandoned-payments`                      | `scripts/appointments/cleanup-tentative-slots.ts` | Every 5 min (`cron-tick.mts`)      |
| `approval-payments`                       | `scripts/appointments/cleanup-tentative-slots.ts` | Every 15 min (`cron-tick.mts`)     |
| `reconcile-refunds`                       | `scripts/refunds/reconcile-refunds.ts`  | Every 15 min (`cron-tick.mts`) & 6h (`cron-intra-day.yml`) |
| `reconcile-disputes`                      | `scripts/disputes/reconcile-disputes.ts`| Every 6 hours (`cron-intra-day.yml`)|
| `reconcile-payment-status`                | `scripts/payments/reconcile-payment-status.ts` | Every 15 min (`cron-tick.mts`) & 2h (`cron-intra-day.yml`) |
| `sync-payment-earnings`                   | `scripts/payments/sync-payment-earnings.ts` | Every 15 min (`cron-tick.mts`) & 4h (`cron-intra-day.yml`) |
| `reconcile-payouts`                       | `scripts/payouts/reconcile-payouts.ts`  | Every 6 hours (`cron-intra-day.yml`)|
| `reconcile-ledgers`                       | `scripts/reconcile/reconcile-ledgers.ts`| Daily (`cron-daily.yml`)           |

### Payment Core, Payouts & Ledger Files

| File                                           | Purpose                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `lib/payments/index.ts`                        | Payment library exports                                                  |
| `lib/payments/core/types.ts`                   | Payment type definitions                                                 |
| `lib/payments/core/stripe.ts`                  | Stripe gateway implementation                                            |
| `lib/payments/core/razorpay.ts`                | Razorpay gateway implementation                                          |
| `lib/payments/payouts/earnings-service.ts`     | Consultant & org earnings creation, splits, and hold/refund operations   |
| `lib/payments/payouts/earning-reversal-cas.ts` | CAS-loop helpers for bounded consultant & org earning reversals          |
| `lib/payments/payouts/shared-lifecycle.ts`     | Shared payout lifecycle helpers (TDS split, error classification, ledger)|
| `lib/payments/payouts/payout-service.ts`       | Consultant payout batching, processing, and settlement                   |
| `lib/payments/payouts/org-payout-service.ts`   | Organization payout batching, processing, and settlement                 |
| `lib/payments/ledger/post.ts`                  | Double-entry ledger journal writer (`postLedgerTxn`)                     |
| `utils/appointmentlock.ts`                     | Short-lived interactive checkout & payout mutexes (Upstash Redis)        |

### Admin Dashboard Pages

| File                                                | Purpose             |
| --------------------------------------------------- | ------------------- |
| `app/dashboard/admin/refunds/page.tsx`              | Refunds dashboard   |
| `app/dashboard/admin/disputes/page.tsx`             | Disputes dashboard  |
| `app/dashboard/admin/disputes/[disputeId]/page.tsx` | Dispute detail page |

### Scheduled Workflows & Tickers

| File                                      | Schedule                    | Purpose                                                    |
| ----------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| `netlify/functions/cron-tick.mts`         | `*/5 * * * *`               | 5-min & 15-min staggered operational sweeps via `/api/cleanup/[job]` |
| `.github/workflows/cron-intra-day.yml`    | Sub-daily (`30m`/`1h`/`2h`/`4h`/`6h`) | Gateway & external vendor reconciliation sweeps            |
| `.github/workflows/cron-daily.yml`        | Daily (`00:00`–`09:30` UTC) | Daily ledger integrity, pruning, dunning, and notifications|
| `.github/workflows/cron-weekly.yml`       | Weekly / Monthly            | Weekly payout pipeline, GSTR-8 export, backup verification |
| `.github/workflows/race-condition-tests.yml` | On push to `dev` / PR    | Concurrent booking & payment race-condition verification   |
| `.github/workflows/ci.yaml`               | On PR / push                | Typecheck, lint, tests, and hermetic Postgres schema/sidecar verification |

---

## Checkout Flow

### High-Level Flow Diagram

```
+-----------------------------------------------------------------------------------+
|                              USER INITIATES CHECKOUT                              |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  CHECKOUT PAGE: /checkout/plans/[type]/[planId]                                   |
|  ------------------------------------------------------------------------------   |
|  URL Search Params:                                                               |
|  - CONSULTATION: startsAt, endsAt, availabilityWindow*Id                          |
|  - SUBSCRIPTION: schedulingPeriodStartsAt, schedulingPeriodEndsAt                 |
|  - WEBINAR/CLASS: eventId                                                         |
|  - Optional: discountCode, notes                                                  |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  FRONTEND VALIDATION (Zod Schemas)                                                |
|  ------------------------------------------------------------------------------   |
|  File: schemas/checkout.ts                                                        |
|  - consultationSearchParamsSchema                                                 |
|  - subscriptionSearchParamsSchema                                                 |
|  - webinarSearchParamsSchema                                                      |
|  - classSearchParamsSchema                                                        |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
                              +-----------------+
                              | Validation OK?  |
                              +--------+--------+
                                       |
                         +-------------+-------------+
                         |                           |
                         v                           v
                   +-----------+            +----------------+
                   |    YES    |            |       NO       |
                   +-----+-----+            +-------+--------+
                         |                          |
                         |                          v
                         |                 +--------------------+
                         |                 | Show Error Message |
                         |                 | "Invalid checkout  |
                         |                 |  parameters"       |
                         |                 +--------------------+
                         v
+-----------------------------------------------------------------------------------+
|  USER CLICKS "Pay with Stripe" or "Pay with Razorpay"                             |
|  ------------------------------------------------------------------------------   |
|  Components: StripeCheckout.tsx / RazorpayCheckout.tsx                            |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  POST /api/checkout                                                               |
|  ------------------------------------------------------------------------------   |
|  File: app/api/checkout/route.ts                                                  |
|  Request Body: { appointmentType, planId/eventId, slot/scheduling params,         |
|                  paymentGateway, discountCode?, notes? }                          |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  CHECKOUT PROCESSOR: processCheckout()                                            |
|  ------------------------------------------------------------------------------   |
|  File: lib/payments/operations/checkout.ts                                        |
+-----------------------------------------------------------------------------------+
```

### Detailed Checkout Steps

```
+-----------------------------------------------------------------------------------+
|  STEP 1: CALCULATE AMOUNT & VALIDATE                                              |
|  ------------------------------------------------------------------------------   |
|  Function: calculateAmountAndValidate()                                           |
|  - Fetch plan details from DB                                                     |
|  - Apply discount code if provided                                                |
|  - Validate slot/event exists and is available                                    |
|  - Return: { amount, currency, discountCodeId, consulteeProfileId }               |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  STEP 2: ACQUIRE DISTRIBUTED LOCK                                                 |
|  ------------------------------------------------------------------------------   |
|  File: utils/appointmentlock.ts                                                   |
|  - CONSULTATION/SUBSCRIPTION (direct): Lock on slot ID                            |
|  - WEBINAR/CLASS: Lock on event ID                                                |
|  - Prevents race conditions during concurrent checkouts                           |
|  - Uses Redis/Upstash for distributed locking                                     |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
                              +-----------------+
                              | Lock Acquired?  |
                              +--------+--------+
                                       |
                         +-------------+-------------+
                         |                           |
                         v                           v
                   +-----------+            +----------------+
                   |    YES    |            |       NO       |
                   +-----+-----+            +-------+--------+
                         |                          |
                         |                          v
                         |                 +------------------------+
                         |                 | Return 409 Conflict    |
                         |                 | "Slot being processed" |
                         |                 +------------------------+
                         v
+-----------------------------------------------------------------------------------+
|  STEP 3: CHECK FOR EXISTING TENTATIVE BOOKING                                     |
|  ------------------------------------------------------------------------------   |
|  - Prevents duplicate tentative appointments for same slot/user                   |
|  - If exists with PENDING payment: Return existing payment intent                 |
|  - Allows retry without creating duplicates                                       |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  STEP 4: CREATE PAYMENT INTENT                                                    |
|  ------------------------------------------------------------------------------   |
|  Class: PaymentIntentManager                                                      |
|  +-------------------------------------------------------------------------+      |
|  |  STRIPE:                                                                |      |
|  |  - Creates Checkout Session (hosted checkout)                           |      |
|  |  - Returns: { id: session_id, client_secret: checkout_url }             |      |
|  +-------------------------------------------------------------------------+      |
|  |  RAZORPAY:                                                              |      |
|  |  - Creates Order                                                        |      |
|  |  - Returns: { id: order_id, amount, currency }                          |      |
|  +-------------------------------------------------------------------------+      |
|  |  MOCK (Development):                                                    |      |
|  |  - Generates mock_pi_* ID                                               |      |
|  |  - Skips gateway calls entirely                                         |      |
|  +-------------------------------------------------------------------------+      |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  STEP 5: CREATE TENTATIVE APPOINTMENT                                             |
|  ------------------------------------------------------------------------------   |
|  Based on appointmentType, calls one of:                                          |
|  +-------------------------------------------------------------------------+      |
|  |  handleConsultationCheckout()                                           |      |
|  |  - Creates Consultation record                                          |      |
|  |  - Creates Appointment with type=CONSULTATION                           |      |
|  |  - Creates AppointmentOccurrence with isTentative=true                      |      |
|  +-------------------------------------------------------------------------+      |
|  |  handleSubscriptionCheckout()                                           |      |
|  |  - Creates Subscription record                                          |      |
|  |  - Creates Appointment with type=SUBSCRIPTION                           |      |
|  |  - Creates placeholder slot (no specific times yet)                     |      |
|  +-------------------------------------------------------------------------+      |
|  |  handleWebinarCheckout()                                                |      |
|  |  - Finds existing Webinar + Appointment                                 |      |
|  |  - Adds user to AppointmentOccurrence with isTentative=true                 |      |
|  +-------------------------------------------------------------------------+      |
|  |  handleClassCheckout()                                                  |      |
|  |  - Finds existing Class + all Appointments                              |      |
|  |  - Adds user to all session slots with isTentative=true                 |      |
|  +-------------------------------------------------------------------------+      |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  STEP 6: CREATE PAYMENT RECORD                                                    |
|  ------------------------------------------------------------------------------   |
|  Payment {                                                                        |
|    paymentIntent: "pi_xxx" or "order_xxx"                                         |
|    paymentStatus: PENDING (or SUCCEEDED for mock)                                 |
|    paymentGateway: STRIPE | RAZORPAY                                              |
|    amount, currency                                                               |
|    appointmentId: links to tentative appointment                                  |
|    userId                                                                         |
|    expiresAt: now + 30 minutes                                                    |
|    isMockPayment: true/false                                                      |
|  }                                                                                |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  STEP 7: RELEASE LOCK & RETURN RESPONSE                                           |
+-----------------------------------------------------------------------------------+
```

### Client-Side Payment Handling

```
+-----------------------------------------------------------------------------------+
|  CLIENT RECEIVES RESPONSE                                                         |
|  ------------------------------------------------------------------------------   |
|  {                                                                                |
|    success: true,                                                                 |
|    paymentIntent: { id, client_secret, amount, currency }                         |
|  }                                                                                |
+-----------------------------------------------------------------------------------+
                                        |
                         +--------------+--------------+
                         |                             |
                         v                             v
           +-------------------------+   +-------------------------+
           |        STRIPE           |   |       RAZORPAY          |
           +------------+------------+   +------------+------------+
                        |                             |
                        v                             v
           +-------------------------+   +-------------------------+
           | window.location.href =  |   | razorpay.open({         |
           | client_secret (URL)     |   |   order_id,             |
           |                         |   |   amount,               |
           | Redirects to Stripe     |   |   handler: onSuccess    |
           | hosted checkout page    |   | })                      |
           +------------+------------+   +------------+------------+
                        |                             |
                        v                             v
           +-------------------------+   +-------------------------+
           | https://checkout.       |   | Razorpay Modal Opens    |
           | stripe.com/c/pay/...    |   | in current page         |
           +------------+------------+   +------------+------------+
                        |                             |
                        v                             v
           +-------------------------+   +-------------------------+
           | User enters card        |   | User enters card/UPI    |
           | details on Stripe page  |   | details in modal        |
           +------------+------------+   +------------+------------+
                        |                             |
                        v                             v
           +-------------------------+   +-------------------------+
           | Payment Processed       |   | Payment Processed       |
           +------------+------------+   +------------+------------+
                        |                             |
                        +-------------+---------------+
                                      |
                                      v
                         +-------------------------+
                         |   WEBHOOK TRIGGERED     |
                         |   (see Webhook Flow)    |
                         +-------------------------+
                                      |
                                      v
           +-----------------------------------------------------------+
           |  CLIENT REDIRECT                                          |
           |  ---------------------------------------------------------|
           |  Stripe: /checkout/checkout-success?payment_intent=...    |
           |  Razorpay: /dashboard (on modal close)                    |
           +-----------------------------------------------------------+
```

---

## Webhook Flow

### Webhook Entry Points

```
+-----------------------------------------------------------------------------------+
|                         PAYMENT GATEWAY SENDS WEBHOOK                             |
+-----------------------------------------------------------------------------------+
                                        |
                         +--------------+--------------+
                         |                             |
                         v                             v
+---------------------------------+   +---------------------------------+
|  POST /api/webhooks/stripe      |   |  POST /api/webhooks/razorpay    |
|  -------------------------------|   |  -------------------------------|
|  Header: stripe-signature       |   |  Header: x-razorpay-signature   |
+----------------+----------------+   +----------------+----------------+
                 |                                      |
                 v                                      v
+---------------------------------+   +---------------------------------+
|  SIGNATURE VERIFICATION         |   |  SIGNATURE VERIFICATION         |
|  -------------------------------|   |  -------------------------------|
|  stripeClient.webhooks          |   |  HMAC-SHA256 verification       |
|  .constructEvent()              |   |  using RAZORPAY_WEBHOOK_SECRET  |
|  with STRIPE_WEBHOOK_SECRET     |   |                                 |
+----------------+----------------+   +----------------+----------------+
                 |                                      |
                 +---------------+---------------------+
                                 |
                                 v
                       +-----------------+
                       | Signature Valid?|
                       +--------+--------+
                                |
                  +-------------+-------------+
                  |                           |
                  v                           v
            +-----------+            +----------------+
            |    YES    |            |       NO       |
            +-----+-----+            +-------+--------+
                  |                          |
                  |                          v
                  |                 +--------------------+
                  |                 | Return 400         |
                  |                 | "Invalid signature"|
                  |                 +--------------------+
                  v
```

### Event Type Router

```
+-----------------------------------------------------------------------------------+
|  EVENT TYPE ROUTER                                                                |
+-----------------------------------------------------------------------------------+
                                        |
        +---------------+---------------+---------------+---------------+
        |               |               |               |               |
        v               v               v               v               v
+---------------+ +---------------+ +---------------+ +---------------+ +---------------+
|payment_intent | |payment_intent | |charge.refunded| |charge.dispute | | (unknown)     |
|.succeeded     | |.payment_failed| |refund.created | |.created/      | |               |
|payment.       | |payment.failed | |refund.        | |updated/closed | |               |
|captured       | |               | |processed      | |payment.dispute| |               |
|order.paid     | |               | |               | |.*             | |               |
+-------+-------+ +-------+-------+ +-------+-------+ +-------+-------+ +-------+-------+
        |                 |                 |                 |                 |
        v                 v                 v                 v                 v
+---------------+ +---------------+ +---------------+ +---------------+ +---------------+
|handlePayment  | |handlePayment  | |handleRefund   | |handleDispute  | | Log & Return  |
|Success()      | |Failure()      | |Created()      | |Created/       | | 200 OK        |
|               | |               | |               | |Updated()      | |               |
+---------------+ +---------------+ +---------------+ +---------------+ +---------------+
```

### Webhook Events by Gateway

| Gateway      | Event                           | Handler                  |
| ------------ | ------------------------------- | ------------------------ |
| **Stripe**   | `payment_intent.succeeded`      | `handlePaymentSuccess()` |
| **Stripe**   | `payment_intent.payment_failed` | `handlePaymentFailure()` |
| **Stripe**   | `charge.refunded`               | `handleRefundCreated()`  |
| **Stripe**   | `charge.dispute.created`        | `handleDisputeCreated()` |
| **Stripe**   | `charge.dispute.updated`        | `handleDisputeUpdated()` |
| **Stripe**   | `charge.dispute.closed`         | `handleDisputeUpdated()` |
| **Razorpay** | `payment.captured`              | `razorpay-dispatch.ts` → routes by `notes.type`: `credit_purchase`/`invoice_payment` → `handleOrgPaymentSuccess()`; `overage_member` → `handleOverageMemberSuccess()`; B2C → `handlePaymentSuccess()` |
| **Razorpay** | `order.paid`                    | `razorpay-dispatch.ts` → same routing by `notes.type` as `payment.captured` |
| **Razorpay** | `payment.failed`                | `razorpay-dispatch.ts` → routes by `notes.type`: org paths → `handleOrgPaymentFailure()`; B2C → `handlePaymentFailure()` |
| **Razorpay** | `refund.created`                | `handleRefundCreated()`  |
| **Razorpay** | `refund.processed`              | `handleRefundCreated()`  |
| **Razorpay** | `refund.failed`                 | `handleRefundCreated()`  |
| **Razorpay** | `payment.dispute.created`       | `handleDisputeCreated()` |
| **Razorpay** | `payment.dispute.won`           | `handleDisputeUpdated()` |
| **Razorpay** | `payment.dispute.lost`          | `handleDisputeUpdated()` |
| **Razorpay** | `payment.dispute.closed`        | `handleDisputeUpdated()` |

### Payment Success Handler

```
+-----------------------------------------------------------------------------------+
|  handlePaymentSuccess(paymentIntentId, metadata)                                  |
|  File: lib/payments/webhooks/handlers.ts                                          |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  FIND PAYMENT BY paymentIntent ID                                                 |
|  ------------------------------------------------------------------------------   |
|  Include: appointment -> consultation/subscription/webinar/class                  |
|           appointment -> appointmentOccurrences -> user                               |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
                              +-------------------------+
                              | Payment Found &         |
                              | Not Already SUCCEEDED?  |
                              +------------+------------+
                                           |
                         +-----------------+-----------------+
                         |                                   |
                         v                                   v
                   +-----------+                      +----------------+
                   |    YES    |                      |       NO       |
                   +-----+-----+                      +-------+--------+
                         |                                    |
                         |                                    v
                         |                           +--------------------+
                         |                           | Return (idempotent)|
                         |                           +--------------------+
                         v
+-----------------------------------------------------------------------------------+
|  CHECK IF APPOINTMENT EXISTS (New vs Legacy Flow)                                 |
+-----------------------------------------------------------------------------------+
                                        |
                         +--------------+--------------+
                         |                             |
                         v                             v
+---------------------------------+   +---------------------------------+
|  NEW FLOW (appointmentId set)   |   |  LEGACY FLOW (no appointmentId) |
|  -------------------------------|   |  -------------------------------|
|  Appointment created during     |   |  Create appointment from        |
|  checkout with isTentative=true |   |  webhook metadata (backward     |
|                                 |   |  compatibility)                 |
+----------------+----------------+   +----------------+----------------+
                 |                                      |
                 v                                      v
+---------------------------------+   +---------------------------------+
|  CONFIRM TENTATIVE APPOINTMENT  |   |  VALIDATE WEBHOOK METADATA      |
|  -------------------------------|   |  -------------------------------|
|  Set isTentative = false on     |   |  Using Zod schema               |
|  all slots for paying user      |   |  If invalid: Log CRITICAL P1    |
|                                 |   |  alert, mark as requires        |
|                                 |   |  manual recovery                |
+----------------+----------------+   +----------------+----------------+
                 |                                      |
                 +---------------+---------------------+
                                 |
                                 v
+-----------------------------------------------------------------------------------+
|  Phase 1 (Transaction):                                                           |
|  UPDATE PAYMENT STATUS = SUCCEEDED                                                |
|  CONFIRM APPOINTMENT                                                              |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  Phase 2 (Post-Commit):                                                           |
|  SEND PAYMENT SUCCESS EMAIL                                                       |
|  (Moved outside transaction in Mar 2026 to prevent false emails on rollback)      |
+-----------------------------------------------------------------------------------+
```

### Payment Failure Handler

```
+-----------------------------------------------------------------------------------+
|  handlePaymentFailure(paymentIntentId)                                            |
|  File: lib/payments/webhooks/handlers.ts                                          |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  FIND PAYMENT WITH FULL APPOINTMENT TREE                                          |
|  ------------------------------------------------------------------------------   |
|  Include: appointment -> appointmentOccurrences                                       |
|           appointment -> consultation/subscription                                |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  WITHIN TRANSACTION:                                                              |
|  ------------------------------------------------------------------------------   |
|  1. UPDATE PAYMENT STATUS = FAILED                                                |
|  2. CLEANUP TENTATIVE SLOTS                                                       |
|     - CONSULTATION/SUBSCRIPTION: Delete all tentative slots                       |
|     - WEBINAR/CLASS: Remove user from slot (keep if others exist)                 |
|  3. DELETE ORPHANED RECORDS                                                       |
|     - If no confirmed slots: delete consultation/subscription/appointment         |
|  4. SEND PAYMENT FAILURE EMAIL                                                    |
+-----------------------------------------------------------------------------------+
```

---

## Refund Flow

### Two-Phase Refund Pattern

```
+-----------------------------------------------------------------------------------+
|  ADMIN/STAFF INITIATES REFUND                                                     |
|  POST /api/payments/refunds                                                       |
|  File: app/api/payments/refunds/route.ts                                          |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  AUTHORIZATION CHECK                                                              |
|  ------------------------------------------------------------------------------   |
|  - Verify session exists                                                          |
|  - Verify user role is ADMIN or STAFF                                             |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  VALIDATE REQUEST                                                                 |
|  ------------------------------------------------------------------------------   |
|  Required: paymentId, amount, reason                                              |
|  - Payment must exist and be SUCCEEDED                                            |
|  - Amount must be <= (payment.amount - existing refunds)                          |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  +=========================================================================+      |
|  |  PHASE 1: ATOMIC TRANSACTION - CREATE PENDING REFUND                    |      |
|  +=========================================================================+      |
|  ------------------------------------------------------------------------------   |
|  prisma.$transaction:                                                             |
|  1. Re-fetch payment (ensure still valid)                                         |
|  2. Sum existing refunds (SUCCEEDED + PENDING)                                    |
|  3. Verify amount <= remaining                                                    |
|  4. CREATE Refund {                                                               |
|       refundId: "pending_${timestamp}_${random}"  // placeholder                  |
|       status: PENDING                                                             |
|       amount, currency, reason                                                    |
|       paymentId                                                                   |
|     }                                                                             |
|  ------------------------------------------------------------------------------   |
|  This "claims" the amount atomically, preventing double refunds                   |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  +=========================================================================+      |
|  |  PHASE 2: CALL EXTERNAL GATEWAY (Outside Transaction)                   |      |
|  +=========================================================================+      |
+-----------------------------------------------------------------------------------+
                                        |
                         +--------------+--------------+
                         |                             |
                         v                             v
+---------------------------------+   +---------------------------------+
|  STRIPE                         |   |  RAZORPAY                       |
|  -------------------------------|   |  -------------------------------|
|  stripeClient.refunds.create({  |   |  1. Fetch payment from order    |
|    payment_intent: pi_xxx,      |   |  2. razorpayClient.payments     |
|    amount: amountInCents,       |   |     .refund(payment_id, {       |
|    reason: reason               |   |       amount: amountInPaise     |
|  })                             |   |     })                          |
+----------------+----------------+   +----------------+----------------+
                 |                                      |
                 +---------------+---------------------+
                                 |
                                 v
                       +-----------------+
                       | Gateway Success?|
                       +--------+--------+
                                |
                  +-------------+-------------+
                  |                           |
                  v                           v
            +-----------+            +----------------+
            |    YES    |            |       NO       |
            +-----+-----+            +-------+--------+
                  |                          |
                  |                          v
                  |                 +--------------------------------+
                  |                 | Log error                      |
                  |                 | Refund stays PENDING with      |
                  |                 | placeholder ID                 |
                  |                 | (Reconciliation will handle)   |
                  |                 +--------------------------------+
                  v
+-----------------------------------------------------------------------------------+
|  +=========================================================================+      |
|  |  PHASE 3: UPDATE REFUND WITH GATEWAY RESPONSE                           |      |
|  +=========================================================================+      |
|  ------------------------------------------------------------------------------   |
|  UPDATE Refund {                                                                  |
|    refundId: "re_xxx" (real gateway ID)                                           |
|    status: map gateway status -> SUCCEEDED | PENDING | FAILED                     |
|    metadata: gateway response data                                                |
|  }                                                                                |
+-----------------------------------------------------------------------------------+
```

### Why Two-Phase Pattern?

1. **Prevents Double Refunds**: PENDING record atomically claims the amount
2. **Handles Failures**: DB always has record for reconciliation
3. **Non-Blocking**: Long-running gateway call is outside transaction
4. **Idempotent**: Safe to retry without side effects

> **Note**: Refunds do NOT automatically cancel appointments. Manual intervention is required.

---

## Dispute Flow

### Dispute Lifecycle

```
+-----------------------------------------------------------------------------------+
|  CUSTOMER FILES DISPUTE WITH BANK/CARD ISSUER                                     |
|  ------------------------------------------------------------------------------   |
|  - Customer claims unauthorized charge                                            |
|  - Customer claims product not received                                           |
|  - Customer claims product not as described                                       |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  PAYMENT GATEWAY SENDS WEBHOOK                                                    |
|  ------------------------------------------------------------------------------   |
|  Stripe: charge.dispute.created                                                   |
|  Razorpay: payment.dispute.created                                                |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  handleDisputeCreated()                                                           |
|  File: app/api/webhooks/utils.ts                                                  |
|  ------------------------------------------------------------------------------   |
|  Params: disputeId, chargeId/paymentId, amount, currency, reason,                 |
|          status, dueBy, isChargeRefundable                                        |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  RESOLVE PAYMENT FROM GATEWAY                                                     |
|  ------------------------------------------------------------------------------   |
|  Stripe: charge.payment_intent -> find Payment by paymentIntent                   |
|  Razorpay: fetch payment -> get order_id -> find Payment                          |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  CREATE DISPUTE RECORD                                                            |
|  ------------------------------------------------------------------------------   |
|  Dispute {                                                                        |
|    disputeId: "dp_xxx" or "disp_xxx"                                              |
|    paymentId: linked to Payment                                                   |
|    amount, currency                                                               |
|    reason: "fraudulent" | "product_not_received" | ...                            |
|    status: NEEDS_RESPONSE                                                         |
|    dueBy: deadline to respond                                                     |
|    isChargeRefundable: boolean                                                    |
|    paymentGateway: STRIPE | RAZORPAY                                              |
|  }                                                                                |
+-----------------------------------------------------------------------------------+
```

### Dispute Status State Machine

```
+-----------------+     +--------------------+     +-----------------+
| WARNING_NEEDS   |---->| WARNING_UNDER      |---->| WARNING_CLOSED  |
| _RESPONSE       |     | _REVIEW            |     |                 |
+-----------------+     +--------------------+     +-----------------+
        |
        | (escalates to full dispute)
        v
+-----------------+     +--------------------+     +-----------------+
| NEEDS_RESPONSE  |---->| UNDER_REVIEW       |---->| WON / LOST      |
+-----------------+     +--------------------+     +-----------------+
        |
        | (merchant refunds proactively)
        v
+-----------------+
| CHARGE_REFUNDED |
+-----------------+
```

### Dispute Resolution Flow

```
                    +---------------------------------------+
                    |         NEEDS_RESPONSE                |
                    |   (waiting for merchant response)     |
                    +-------------------+-------------------+
                                        |
                         +--------------+--------------+
                         |                             |
                         v                             v
+---------------------------------+   +---------------------------------+
|  SUBMIT EVIDENCE (Stripe Only)  |   |  NO RESPONSE BY DEADLINE        |
|  POST /api/payments/disputes    |   |  -------------------------------|
|  -------------------------------|   |  Auto-loss of dispute           |
|  Evidence types:                |   |                                 |
|  - Customer info                |   |                                 |
|  - Cancellation policy          |   |                                 |
|  - Product description          |   |                                 |
|  - Customer communication       |   |                                 |
|  - Duplicate charge proof       |   |                                 |
+----------------+----------------+   +----------------+----------------+
                 |                                      |
                 v                                      |
+---------------------------------+                     |
|  Gateway processes evidence     |                     |
|  Webhook: dispute.updated       |                     |
|  Status -> UNDER_REVIEW         |                     |
+----------------+----------------+                     |
                 |                                      |
                 +---------------+---------------------+
                                 |
                                 v
                    +---------------------------------------+
                    |         UNDER_REVIEW                  |
                    |   (bank reviewing evidence)           |
                    +-------------------+-------------------+
                                        |
                         +--------------+--------------+
                         |                             |
                         v                             v
+---------------------------------+   +---------------------------------+
|  DISPUTE WON                    |   |  DISPUTE LOST                   |
|  -------------------------------|   |  -------------------------------|
|  - Funds returned to merchant   |   |  - Funds go to customer         |
|  - No action needed             |   |  - Chargeback fee applied       |
+---------------------------------+   +---------------------------------+
```

### Gateway Support Matrix

The matrix below covers the dispute surface, where the two gateways differ most, and the settlement currency, where they deliberately do not differ at all.

| Feature              | Stripe                          | Razorpay                        |
| -------------------- | ------------------------------- | ------------------------------- |
| Dispute Webhooks     | Yes                             | Yes                             |
| List Disputes API    | Yes                             | No (Dashboard only)             |
| Submit Evidence API  | Yes                             | No (Dashboard only)             |
| Retrieve Dispute     | Yes                             | No                              |
| Settlement currency  | INR only, enforced at order creation | INR only, enforced at order creation |

Settlement is INR-only by design, per [ADR 15](../enterprise/70-design-decisions/15-currency-as-enum-with-display-fields.md): every stored amount is an integer count of INR paise and the double-entry ledger is INR-denominated. That is enforced rather than assumed. `assertInrSettlement`, in `lib/payments/validation/currency-guards.ts`, is the first statement of both `createRazorpayOrder` and `createStripeCheckoutSession`, and it throws a `PaymentError` with code `NON_INR_SETTLEMENT` for anything else. The assertion sits at the gateway boundary rather than at each caller because callers read a currency out of the database — an organisation's billing account, an invoice's display currency, an overage event — and any one of them forwarding a stale non-INR value would otherwise mint an order denominated in that currency's own subunit while the platform recorded rupees. An international buyer is still served an INR order; their card issuer performs the conversion. See [multi-currency/01-architecture.md](./multi-currency/01-architecture.md) for the display-side story.

---

## Reconciliation Flows

### Refund Reconciliation

```
+-----------------------------------------------------------------------------------+
|  CRON: Every 15 minutes                                                           |
|  GET /api/cleanup/reconcile-refunds                                               |
|  File: app/api/cleanup/reconcile-refunds/route.ts                                 |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  AUTHORIZATION                                                                    |
|  ------------------------------------------------------------------------------   |
|  Verify: CRON_SECRET or VERCEL_CRON_SECRET                                        |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  FIND STUCK REFUNDS                                                               |
|  ------------------------------------------------------------------------------   |
|  WHERE:                                                                           |
|    status = PENDING                                                               |
|    refundId STARTS WITH "pending_"  (placeholder ID)                              |
|    createdAt < (now - 1 hour)  (reconciliation threshold)                         |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
                    +---------------------------------------+
                    |     FOR EACH STUCK REFUND             |
                    +-------------------+-------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  QUERY GATEWAY FOR REFUNDS ON THIS PAYMENT                                        |
|  ------------------------------------------------------------------------------   |
|  Stripe: stripeClient.refunds.list({ payment_intent })                            |
|  Razorpay: razorpayClient.payments.fetchMultipleRefund(payment_id)                |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  MATCH REFUND BY:                                                                 |
|  ------------------------------------------------------------------------------   |
|  - Amount matches exactly                                                         |
|  - Creation time within 5-minute window of our DB record                          |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
                              +-----------------+
                              |  Match Found?   |
                              +--------+--------+
                                       |
               +-----------------------+-----------------------+
               |                       |                       |
               v                       v                       v
         +-----------+         +-------------+          +-------------+
         |    YES    |         |   NO (but   |          |   NO (and   |
         |           |         |   < 24 hrs) |          |   > 24 hrs) |
         +-----+-----+         +------+------+          +------+------+
               |                      |                        |
               v                      v                        v
+---------------------+   +---------------------+   +---------------------+
| UPDATE REFUND       |   | SKIP                |   | MARK AS FAILED      |
| --------------------|   | --------------------|   | --------------------|
| refundId: real ID   |   | Still processing    |   | status: FAILED      |
| status: from gateway|   | within grace period |   | metadata: { error:  |
| metadata: response  |   | Try again next run  |   | "Not found after    |
|                     |   |                     |   |  24 hours" }        |
+---------------------+   +---------------------+   +---------------------+
```

### Dispute Reconciliation

```
+-----------------------------------------------------------------------------------+
|  CRON: Every 6 hours                                                              |
|  GET /api/cleanup/reconcile-disputes                                              |
|  File: app/api/cleanup/reconcile-disputes/route.ts                                |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  FIND ACTIVE DISPUTES NEEDING RECONCILIATION                                      |
|  ------------------------------------------------------------------------------   |
|  WHERE:                                                                           |
|    status IN (NEEDS_RESPONSE, WARNING_NEEDS_RESPONSE,                             |
|               UNDER_REVIEW, WARNING_UNDER_REVIEW)                                 |
|    AND (                                                                          |
|      dueBy < (now + 7 days)  // approaching deadline                              |
|      OR updatedAt < (now - 24 hours)  // stale                                    |
|    )                                                                              |
|  ORDER BY dueBy ASC  // prioritize earliest deadlines                             |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
                    +---------------------------------------+
                    |     FOR EACH DISPUTE                  |
                    +-------------------+-------------------+
                                        |
                         +--------------+--------------+
                         |                             |
                         v                             v
+---------------------------------+   +---------------------------------+
|  STRIPE                         |   |  RAZORPAY                       |
|  -------------------------------|   |  -------------------------------|
|  stripeClient.disputes          |   |  Log for manual review          |
|  .retrieve(disputeId)           |   |  (No API support)               |
|                                 |   |  "Check Razorpay dashboard"     |
+----------------+----------------+   +---------------------------------+
                 |
                 v
+-----------------------------------------------------------------------------------+
|  COMPARE GATEWAY STATUS WITH DB STATUS                                            |
|  ------------------------------------------------------------------------------   |
|  - If changed: Update DB with new status, evidence, dueBy                         |
|  - If not found at gateway (404): Mark as WON (resolved)                          |
|  - If deadline within 48 hours: Flag as URGENT                                    |
+-----------------------------------------------------------------------------------+
```

### Abandoned Payments Cleanup

```
+-----------------------------------------------------------------------------------+
|  CRON: Every 15 minutes                                                           |
|  GitHub Action: cleanup-abandoned-payments.yml                                    |
|  Job: jobs/cleanup-abandoned-payments.ts                                          |
|  API: /api/cleanup/abandoned-payments                                             |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  FIND EXPIRED PAYMENTS                                                            |
|  ------------------------------------------------------------------------------   |
|  WHERE:                                                                           |
|    paymentStatus = PENDING                                                        |
|    expiresAt < now  (30-minute expiration)                                        |
|    isMockPayment = false                                                          |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  FOR EACH EXPIRED PAYMENT:                                                        |
|  ------------------------------------------------------------------------------   |
|  1. CANCEL PAYMENT INTENT AT GATEWAY                                              |
|     - Stripe: stripeClient.paymentIntents.cancel(paymentIntent)                   |
|     - Razorpay: (Orders auto-expire)                                              |
|  2. CLEANUP TENTATIVE APPOINTMENT (same as handlePaymentFailure)                  |
|  3. UPDATE PAYMENT STATUS = FAILED                                                |
|     - description: "Payment expired - abandoned"                                  |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|  ALSO: EXPIRED APPROVAL-PENDING CONSULTATIONS                                     |
|  ------------------------------------------------------------------------------   |
|  WHERE:                                                                           |
|    status = APPROVED_PENDING_PAYMENT                                              |
|    updatedAt < (now - 48 hours)                                                   |
|  ACTION:                                                                          |
|    - Revert to status = PENDING                                                   |
|    - Clear pendingPaymentUrl                                                      |
|    - Add note: "[System] Payment link expired..."                                 |
|    - Mark payment as FAILED                                                       |
+-----------------------------------------------------------------------------------+
```

### Reconciliation Thresholds Summary

| Job                    | Threshold  | Action                       |
| ---------------------- | ---------- | ---------------------------- |
| Refund Reconciliation  | 1 hour     | Start checking stuck refunds |
| Refund Reconciliation  | 5 minutes  | Time window for matching     |
| Refund Reconciliation  | 24 hours   | Mark as FAILED if not found  |
| Dispute Reconciliation | 7 days     | Approaching deadline check   |
| Dispute Reconciliation | 24 hours   | Stale record check           |
| Dispute Reconciliation | 48 hours   | Urgent alert threshold       |
| Abandoned Payments     | 30 minutes | Payment expiration           |
| Approval Payments      | 48 hours   | Payment link expiration      |

---

## GitHub Actions & Cron Jobs

### Scheduled Workflows

```
+-----------------------------------------------------------------------------------+
|                         SCHEDULED WORKFLOWS                                       |
+-----------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------+
|  cleanup-abandoned-payments.yml                                                   |
|  ------------------------------------------------------------------------------   |
|  Schedule: */15 * * * * (every 15 minutes)                                        |
|                                                                                   |
|  +-------------------------------------------------------------------------+      |
|  |  jobs:                                                                  |      |
|  |    cleanup:                                                             |      |
|  |      runs-on: ubuntu-latest                                             |      |
|  |      steps:                                                             |      |
|  |        - checkout                                                       |      |
|  |        - setup-node (v20)                                               |      |
|  |        - npm ci                                                         |      |
|  |        - npx tsx jobs/cleanup-abandoned-payments.ts                     |      |
|  |      env:                                                               |      |
|  |        DATABASE_URL, DIRECT_URL                                         |      |
|  |        STRIPE_SECRET_KEY                                                |      |
|  |        RAZORPAY_KEY_ID, RAZORPAY_SECRET                                 |      |
|  +-------------------------------------------------------------------------+      |
+-----------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------+
|  stream_sync.yml                                                                  |
|  ------------------------------------------------------------------------------   |
|  Schedule: 30 3 * * * (daily at 3:30 UTC / 9:00 AM IST)                           |
|                                                                                   |
|  +-------------------------------------------------------------------------+      |
|  |  Purpose: Sync Stream Chat users with database                          |      |
|  |  - Identifies stale Stream users (not in DB)                            |      |
|  |  - Deletes orphaned Stream accounts                                     |      |
|  |  - Paginates through users (100 per batch)                              |      |
|  +-------------------------------------------------------------------------+      |
+-----------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------+
|  quality-checks.yaml                                                              |
|  ------------------------------------------------------------------------------   |
|  Trigger: Pull requests to dev, staging, prod                                     |
|                                                                                   |
|  +-------------------------------------------------------------------------+      |
|  |  Jobs:                                                                  |      |
|  |  - typecheck: npx tsc --noEmit                                          |      |
|  |  - build: npm run build                                                 |      |
|  |  - format: prettier --check                                             |      |
|  |  - lint: eslint                                                         |      |
|  +-------------------------------------------------------------------------+      |
+-----------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------+
|  race-condition-tests.yml                                                         |
|  ------------------------------------------------------------------------------   |
|  Trigger: Push to dev OR manual workflow_dispatch                                 |
|                                                                                   |
|  +-------------------------------------------------------------------------+      |
|  |  Purpose: Test concurrent payment scenarios                             |      |
|  |  - Uses mock Redis by default (save Upstash quota)                      |      |
|  |  - 25-minute timeout                                                    |      |
|  |  - Uploads test reports as artifacts                                    |      |
|  +-------------------------------------------------------------------------+      |
+-----------------------------------------------------------------------------------+
```

### Vercel Cron Jobs

```
+-----------------------------------------------------------------------------------+
|  Vercel Cron (defined in vercel.json or via Vercel dashboard)                     |
|  ------------------------------------------------------------------------------   |
|                                                                                   |
|  +-------------------------------------------------------------------------+      |
|  |  */15 * * * *  ->  GET /api/cleanup/reconcile-refunds                   |      |
|  |  0 */6 * * *   ->  GET /api/cleanup/reconcile-disputes                  |      |
|  |  0 * * * *     ->  GET /api/cleanup/approval-payments                   |      |
|  +-------------------------------------------------------------------------+      |
|                                                                                   |
|  Authorization: CRON_SECRET or VERCEL_CRON_SECRET header                          |
+-----------------------------------------------------------------------------------+
```

### Summary Table

| Workflow/Job                | Schedule       | Purpose                      | Critical |
| --------------------------- | -------------- | ---------------------------- | -------- |
| Cleanup Abandoned Payments  | Every 15 min   | Cancel stale payment intents | Yes      |
| Refund Reconciliation       | Every 15 min   | Fix stuck refunds            | Yes      |
| Dispute Reconciliation      | Every 6 hours  | Sync dispute status          | Yes      |
| Approval Payment Expiration | Every hour     | Expire 48-hour payment links | Yes      |
| Stream User Sync            | Daily 3:30 UTC | Clean stale chat users       | No       |
| Race Condition Tests        | On push to dev | Test concurrent payments     | No       |
| Quality Checks              | On PR          | CI/CD checks                 | No       |

---

## Complete Data Flow Summary

### Payment Lifecycle Sequence

```
     USER                    APP                      GATEWAY                DB
      |                       |                          |                    |
      |  Select Plan          |                          |                    |
      |---------------------->|                          |                    |
      |                       |                          |                    |
      |                       |  Create Payment Intent   |                    |
      |                       |------------------------->|                    |
      |                       |                          |                    |
      |                       |  pi_xxx / order_xxx      |                    |
      |                       |<-------------------------|                    |
      |                       |                          |                    |
      |                       |  Create Tentative        |                    |
      |                       |  Appointment + Payment   |                    |
      |                       |-------------------------------------------- ->|
      |                       |                          |                    |
      |                       |                          |    Payment{       |
      |                       |                          |      status:      |
      |                       |                          |      PENDING      |
      |                       |                          |    }              |
      |                       |                          |    Slot{          |
      |                       |                          |      isTentative: |
      |                       |                          |      true         |
      |                       |                          |    }              |
      |                       |                          |                    |
      |  Redirect to Gateway  |                          |                    |
      |<----------------------|                          |                    |
      |                       |                          |                    |
      |  Enter Card Details   |                          |                    |
      |------------------------------------------------->|                    |
      |                       |                          |                    |
      |                       |        [ASYNC]           |                    |
      |                       |      Payment Webhook     |                    |
      |                       |<-------------------------|                    |
      |                       |                          |                    |
      |                       |  Confirm Appointment     |                    |
      |                       |-------------------------------------------->  |
      |                       |                          |                    |
      |                       |                          |    Payment{       |
      |                       |                          |      status:      |
      |                       |                          |      SUCCEEDED    |
      |                       |                          |    }              |
      |                       |                          |    Slot{          |
      |                       |                          |      isTentative: |
      |                       |                          |      false        |
      |                       |                          |    }              |
      |                       |                          |                    |
      |  Redirect to Success  |                          |                    |
      |<----------------------|                          |                    |
      |                       |                          |                    |
      v                       v                          v                    v
```

### Refund Flow Sequence

```
    ADMIN                    APP                      GATEWAY                DB
      |                       |                          |                    |
      |  Initiate Refund      |                          |                    |
      |---------------------->|                          |                    |
      |                       |                          |                    |
      |                       |  Create PENDING Refund   |                    |
      |                       |  (Phase 1 - atomic)      |                    |
      |                       |------------------------------------------->  |
      |                       |                          |                    |
      |                       |                          |    Refund{        |
      |                       |                          |      refundId:    |
      |                       |                          |      pending_xxx  |
      |                       |                          |      status:      |
      |                       |                          |      PENDING      |
      |                       |                          |    }              |
      |                       |                          |                    |
      |                       |  Call Gateway Refund     |                    |
      |                       |  (Phase 2)               |                    |
      |                       |------------------------->|                    |
      |                       |                          |                    |
      |                       |  re_xxx (refund ID)      |                    |
      |                       |<-------------------------|                    |
      |                       |                          |                    |
      |                       |  Update Refund           |                    |
      |                       |  (Phase 3)               |                    |
      |                       |------------------------------------------->  |
      |                       |                          |                    |
      |                       |                          |    Refund{        |
      |                       |                          |      refundId:    |
      |                       |                          |      re_xxx       |
      |                       |                          |      status:      |
      |                       |                          |      SUCCEEDED    |
      |                       |                          |    }              |
      |                       |                          |                    |
      |  Refund Confirmed     |                          |                    |
      |<----------------------|                          |                    |
      |                       |                          |                    |
      v                       v                          v                    v
```

### Dispute Flow Sequence

```
  CUSTOMER                   APP                      GATEWAY                DB
      |                       |                          |                    |
      |  File Dispute with    |                          |                    |
      |  Bank                 |                          |                    |
      |------------------------------------------------->|                    |
      |                       |                          |                    |
      |                       |        [ASYNC]           |                    |
      |                       |    Dispute Webhook       |                    |
      |                       |<-------------------------|                    |
      |                       |                          |                    |
      |                       |  Create Dispute Record   |                    |
      |                       |------------------------------------------->  |
      |                       |                          |                    |
      |                       |                          |    Dispute{       |
      |                       |                          |      status:      |
      |                       |                          |      NEEDS_       |
      |                       |                          |      RESPONSE     |
      |                       |                          |      dueBy: date  |
      |                       |                          |    }              |
      |                       |                          |                    |
    ADMIN                     |                          |                    |
      |  Submit Evidence      |                          |                    |
      |---------------------->|                          |                    |
      |                       |  Submit to Gateway       |                    |
      |                       |------------------------->|                    |
      |                       |                          |                    |
      |                       |        [ASYNC]           |                    |
      |                       |   Update Webhook         |                    |
      |                       |<-------------------------|                    |
      |                       |                          |                    |
      |                       |  Update Dispute Status   |                    |
      |                       |------------------------------------------->  |
      |                       |                          |                    |
      |                       |                          |    Dispute{       |
      |                       |                          |      status:      |
      |                       |                          |      UNDER_REVIEW |
      |                       |                          |    }              |
      |                       |                          |                    |
      |                       |        [DAYS LATER]      |                    |
      |                       |   Resolution Webhook     |                    |
      |                       |<-------------------------|                    |
      |                       |                          |                    |
      |                       |  Final Status Update     |                    |
      |                       |------------------------------------------->  |
      |                       |                          |                    |
      |                       |                          |    Dispute{       |
      |                       |                          |      status:      |
      |                       |                          |      WON/LOST     |
      |                       |                          |    }              |
      |                       |                          |                    |
      v                       v                          v                    v
```

---

## Quick Reference

### Environment Variables Required

```bash
# Database
DATABASE_URL=
DIRECT_URL=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=

# Razorpay (Payments)
RAZORPAY_KEY_ID=
RAZORPAY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
NEXT_PUBLIC_RAZORPAY_KEY_ID=

# RazorpayX (Payouts)
RAZORPAYX_KEY_ID=
RAZORPAYX_KEY_SECRET=
RAZORPAYX_ACCOUNT_NUMBER=
RAZORPAYX_WEBHOOK_SECRET=

# Cron Jobs
CRON_SECRET=
# or
VERCEL_CRON_SECRET=
```

### Key API Endpoints

| Endpoint                   | Method   | Purpose                                                          |
| -------------------------- | -------- | ---------------------------------------------------------------- |
| `/api/checkout`            | POST     | Create payment intent & tentative appointment                    |
| `/api/checkout/verify`     | GET      | Verify payment status                                            |
| `/api/webhooks/stripe`     | POST     | Stripe webhook handler                                           |
| `/api/webhooks/razorpay`   | POST     | Razorpay webhook handler                                         |
| `/api/payments/refunds`    | GET/POST | List/create refunds                                              |
| `/api/payments/disputes`   | GET/POST | List disputes/submit evidence                                    |
| `/api/cleanup/[job]`       | GET/POST | Dynamic cron dispatcher for all cleanup & reconciliation sweeps  |
| `/api/admin/reconcile-ledgers` | POST | On-demand set-based double-entry ledger integrity verification   |

---

## Deprecated & Superseded Approaches

The following historical payment and ledger patterns have been permanently superseded. Any residual references should be removed rather than extended:

- **Three Single-Entry Logs (`FundingLedgerEntry`, `WalletEntry`, `SettlementLedgerEntry`)**: Replaced by the unified immutable double-entry journal (`LedgerAccount`, `LedgerTransaction`, `LedgerEntry` in `lib/payments/ledger/post.ts`) enforced at transaction `COMMIT` by Postgres `CONSTRAINT TRIGGER` `ledger_balance_check` (`prisma/sql/ledger-triggers.sql`).
- **In-Memory `PaymentIntentManager` Expiry Timers**: Previously scheduled `setTimeout` callbacks inside serverless Node processes to cancel uncaptured intents, which vanished on Lambda freeze/recycle. Superseded by stateless database-backed expiration in `cleanupTentativeSlots` (`scripts/appointments/cleanup-tentative-slots.ts`) invoked every 5 minutes via `/api/cleanup/abandoned-payments`.
- **Two-Way CreditNote Trigger XOR (`refundId` vs `disputeId` only)**: Previously `credit_note_trigger_xor` only permitted credit notes on `Refund` or `Dispute` rows, blocking GST credit notes when an already-invoiced `OverageEvent` was refunded. Superseded by the three-way XOR constraint `CHECK (num_nonnulls("refundId", "disputeId", "overageEventId") = 1)` in `prisma/sql/check-constraints.sql` and unified reversal handling in `lib/payments/operations/reversal-engine.ts`.
- **Multi-Step Cursor Background Ledger Reconciler (`reconcile-ledgers-background`, `advanceReconcileRun`)**: Previously iterated through accounts in JS batches across multiple background invocations. Superseded by 5 single-query set-based SQL checks in `scripts/reconcile/reconcile-ledgers.ts` that run synchronously in under a second.
- **3-Layer Cron Wrapper Files (`jobs/<domain>/<job>.ts` + 50 `app/api/cleanup/<job>/route.ts` directories + 41 individual GHA cron YAML files)**: Superseded by `lib/cron/cleanup-registry.ts`, the dynamic route `app/api/cleanup/[job]/route.ts`, and the 3 consolidated workflow files (`cron-intra-day.yml`, `cron-daily.yml`, `cron-weekly.yml`).
