# Payment System - Production Readiness

> **Severity Level:** HIGH
> **Last Updated:** 2024
> **Status:** Requires Hardening Before Production

## Executive Summary

The payment system supports multiple gateways (Stripe, Razorpay, LemonSqueezy) with comprehensive webhook handling. However, critical vulnerabilities exist around idempotency, race conditions, and refund processing that must be addressed before production.

---

## Table of Contents

1. [Payment Architecture Overview](#1-payment-architecture-overview)
2. [Webhook Security](#2-webhook-security)
3. [Race Conditions](#3-race-conditions)
4. [Refund Vulnerabilities](#4-refund-vulnerabilities)
5. [Dispute Handling](#5-dispute-handling)
6. [Payment Flow Issues](#6-payment-flow-issues)
7. [Fraud Prevention](#7-fraud-prevention)
8. [Remediation Guide](#8-remediation-guide)

---

## 1. Payment Architecture Overview

### 1.1 Supported Gateways

| Gateway      | Status      | Implementation               |
| ------------ | ----------- | ---------------------------- |
| Stripe       | Complete    | Full feature support         |
| Razorpay     | Complete    | Full feature support         |
| LemonSqueezy | Partial     | Missing appointment creation |
| XFlow        | Unknown     | Limited documentation        |
| Mock         | Development | Testing only                 |

### 1.2 File Structure

```
lib/payments/
├── index.ts                 # Unified gateway abstraction
├── core/
│   ├── stripe.ts           # Stripe implementation
│   ├── razorpay.ts         # Razorpay implementation
│   ├── types.ts            # Shared types
│   └── transactions.ts     # Prisma transaction helpers
├── webhooks/
│   └── handlers.ts         # Core webhook business logic
└── operations/
    └── checkout.ts         # Checkout flow orchestration

app/api/webhooks/
├── stripe/route.ts         # Stripe webhook handler
├── razorpay/route.ts       # Razorpay webhook handler
├── lemon-squeezy/route.ts  # LemonSqueezy webhook handler
├── xflow/route.ts          # XFlow webhook handler
└── utils.ts                # Shared webhook utilities
```

### 1.3 Payment Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. CHECKOUT INITIATION                                       │
├─────────────────────────────────────────────────────────────┤
│ User selects plan → Validate session → Check slot availability│
│ → Create tentative booking → Create payment intent           │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. PAYMENT PROCESSING                                        │
├─────────────────────────────────────────────────────────────┤
│ User completes payment → Gateway processes → Webhook sent    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. WEBHOOK HANDLING                                          │
├─────────────────────────────────────────────────────────────┤
│ Verify signature → Parse event → Process in transaction      │
│ → Confirm booking → Update payment status → Send notifications│
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Webhook Security

### 2.1 Current Implementation

**File:** `app/api/webhooks/utils.ts:13-53`

```typescript
// GOOD: Signature verification implemented
export async function verifyWebhookSignature(
  req: NextRequest,
  secret: string,
  gateway: "stripe" | "razorpay",
): Promise<{ isValid: boolean; body: string }> {
  const signature =
    req.headers.get(
      gateway === "stripe" ? "stripe-signature" : "x-razorpay-signature",
    ) || "";

  const body = await req.text();

  if (gateway === "stripe") {
    stripeClient.webhooks.constructEvent(body, signature, secret);
    return { isValid: true, body };
  } else {
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");
    return { isValid: signature === expectedSignature, body };
  }
}
```

**Status:** ✅ Signature verification is properly implemented

### 2.2 Missing: Event Deduplication

**Issue:** No mechanism to prevent webhook replay attacks.

**Current Flow:**

```
Webhook 1 (event: abc123) → Process → Success
Webhook 2 (event: abc123) → Process → DUPLICATE PROCESSING
```

**Attack Vector:**

1. Attacker intercepts webhook
2. Replays webhook multiple times
3. Each replay is processed

### 2.3 Remediation: Add WebhookLog Table

```prisma
// Add to schema.prisma
model WebhookLog {
  id          String   @id @default(cuid())
  eventId     String
  gateway     String   // STRIPE, RAZORPAY, LEMONSQUEEZY
  eventType   String   // payment_intent.succeeded, etc.
  payload     Json?
  processed   Boolean  @default(true)
  processedAt DateTime @default(now())
  createdAt   DateTime @default(now())

  @@unique([eventId, gateway])
  @@index([createdAt])
  @@index([gateway, eventType])
}
```

```typescript
// Webhook handler with deduplication
export async function handleWebhook(
  eventId: string,
  gateway: string,
  eventType: string,
  handler: () => Promise<void>,
): Promise<{ status: string }> {
  // Check for existing processing
  const existing = await prisma.webhookLog.findUnique({
    where: { eventId_gateway: { eventId, gateway } },
  });

  if (existing) {
    return { status: "already_processed" };
  }

  // Create log entry (acts as lock)
  try {
    await prisma.webhookLog.create({
      data: { eventId, gateway, eventType },
    });
  } catch (error) {
    // Unique constraint violation = concurrent processing
    return { status: "already_processing" };
  }

  // Process webhook
  await handler();

  return { status: "processed" };
}
```

---

## 3. Race Conditions

### 3.1 Payment Success Race Condition

**File:** `lib/payments/webhooks/handlers.ts:76-117`

**Issue:** Two concurrent webhooks can both pass the status check.

```typescript
// CURRENT CODE - VULNERABLE
const payment = await tx.payment.findUnique({...});

// RACE WINDOW: Both webhooks see PENDING status
if (payment.paymentStatus === PaymentStatus.SUCCEEDED) {
  return; // This check passes for BOTH webhooks
}

// Both webhooks update to SUCCEEDED
await tx.payment.update({...});

// Both attempt to create/confirm appointment
// One succeeds, one fails or creates duplicate
```

**Attack Scenario:**

```
T0: Webhook A queries payment (status: PENDING)
T1: Webhook B queries payment (status: PENDING)
T2: Webhook A updates to SUCCEEDED
T3: Webhook B updates to SUCCEEDED (no conflict)
T4: Webhook A creates appointment
T5: Webhook B creates appointment → DUPLICATE or ERROR
```

### 3.2 Slot Booking Race Condition

**File:** `lib/payments/operations/checkout.ts:320-476`

**Issue:** Time gap between availability check and booking creation.

```typescript
// CURRENT CODE - VULNERABLE
// Step 1: Check availability
const existingBooking = await tx.slotOfAppointment.findFirst({
  where: {
    AND: [
      { OR: [ /* overlap detection */ ] },
      { isTentative: false }
    ]
  }
});

// RACE WINDOW: Another request could book same slot here

// Step 2: Create booking
await tx.slotOfAppointment.create({...});
```

### 3.3 Remediation: Optimistic Locking

```typescript
// Add version field to Payment model
model Payment {
  version Int @default(0)
}

// Update with version check
async function processPaymentSuccess(paymentIntentId: string) {
  return await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId }
    });

    if (payment.paymentStatus === PaymentStatus.SUCCEEDED) {
      return { status: 'already_processed' };
    }

    // Atomic update with version check
    const updated = await tx.payment.updateMany({
      where: {
        id: payment.id,
        version: payment.version,  // Optimistic lock
        paymentStatus: PaymentStatus.PENDING  // Double-check status
      },
      data: {
        paymentStatus: PaymentStatus.SUCCEEDED,
        version: { increment: 1 }
      }
    });

    if (updated.count === 0) {
      // Another transaction already processed
      return { status: 'concurrent_update' };
    }

    // Safe to proceed with appointment creation
    await createAppointment(payment);

    return { status: 'processed' };
  }, {
    isolationLevel: 'Serializable'
  });
}
```

### 3.4 Remediation: Database Constraints

```prisma
// Prevent double booking at database level
model SlotOfAppointment {
  // ... existing fields

  // Unique constraint prevents same slot being booked twice
  @@unique([startsAt, endsAt, consultantProfileId, isTentative], name: "unique_confirmed_slot")
}
```

---

## 4. Refund Vulnerabilities

### 4.1 Over-Refund Bug

**File:** `app/api/payments/refunds/route.ts:83-103`

**Issue:** Only counts SUCCEEDED refunds, ignoring PENDING refunds.

```typescript
// CURRENT CODE - VULNERABLE
const totalRefunded = payment.refunds
  .filter((r) => r.status === "SUCCEEDED") // BUG: Missing PENDING
  .reduce((sum, r) => sum + r.amount, 0);

if (totalRefunded >= payment.amount) {
  return NextResponse.json(
    { error: "Payment has already been fully refunded" },
    { status: 400 },
  );
}

const refundAmount = amount || payment.amount - totalRefunded;

if (refundAmount > payment.amount - totalRefunded) {
  return NextResponse.json(
    { error: "Refund amount exceeds available balance" },
    { status: 400 },
  );
}
```

**Attack Scenario:**

```
Original Payment: $100
Request 1: Refund $50 → PENDING (not counted)
Request 2: Refund $50 → PENDING (not counted)
Request 3: Refund $50 → PENDING (not counted)
...
Result: Multiple $50 refunds processed = $150+ refunded for $100 payment
```

### 4.2 Remediation

```typescript
// FIXED CODE
const totalRefunded = payment.refunds
  .filter((r) => r.status === "SUCCEEDED" || r.status === "PENDING")
  .reduce((sum, r) => sum + r.amount, 0);

// Use Redis distributed lock for serverless environments
// Local Map-based locks DON'T work in serverless - each instance has its own memory!
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

async function acquireLock(
  key: string,
  ttlSeconds: number = 30,
): Promise<boolean> {
  // SET with NX (only if not exists) and EX (expiry)
  const result = await redis.set(key, "locked", { nx: true, ex: ttlSeconds });
  return result === "OK";
}

async function releaseLock(key: string): Promise<void> {
  await redis.del(key);
}

async function processRefundWithLock(paymentId: string, amount: number) {
  const lockKey = `refund:lock:${paymentId}`;
  const maxRetries = 5;
  const retryDelayMs = 200;

  // Try to acquire lock with retries
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const acquired = await acquireLock(lockKey);

    if (acquired) {
      try {
        return await createRefund(paymentId, amount);
      } finally {
        await releaseLock(lockKey);
      }
    }

    // Wait before retrying
    await new Promise((resolve) =>
      setTimeout(resolve, retryDelayMs * (attempt + 1)),
    );
  }

  throw new Error(
    "Could not acquire lock for refund processing. Please try again.",
  );
}
```

### 4.3 Additional Refund Safeguards

```typescript
// Add refund velocity checks
async function validateRefundRequest(userId: string, paymentId: string) {
  const recentRefunds = await prisma.refund.count({
    where: {
      payment: { userId },
      createdAt: { gte: subDays(new Date(), 30) },
    },
  });

  if (recentRefunds > 5) {
    // Flag for manual review
    await prisma.refundReview.create({
      data: {
        paymentId,
        reason: "HIGH_REFUND_VELOCITY",
        status: "PENDING_REVIEW",
      },
    });
    throw new Error("Refund requires manual approval");
  }
}
```

---

## 5. Dispute Handling

### 5.1 Current Implementation

**File:** `app/api/payments/disputes/route.ts`

| Feature         | Stripe | Razorpay          |
| --------------- | ------ | ----------------- |
| View disputes   | ✅     | ✅                |
| Submit evidence | ✅     | ❌ (webhook only) |
| Update status   | ✅     | ❌                |

### 5.2 Dispute Status Mapping Gap

**File:** `lib/payments/core/stripe.ts:428-448`

```typescript
// CURRENT - Missing some Stripe statuses
function mapStripeDisputeStatus(status: string): DisputeStatus {
  switch (status) {
    case "needs_response":
      return "NEEDS_RESPONSE";
    case "under_review":
      return "UNDER_REVIEW";
    case "won":
      return "WON";
    case "lost":
      return "LOST";
    default:
      return "NEEDS_RESPONSE"; // Fallback hides unknown statuses
  }
}

// MISSING STATUSES:
// - "warning_needs_response"
// - "warning_under_review"
// - "warning_closed"
// - "charge_refunded"
```

### 5.3 Remediation

```typescript
function mapStripeDisputeStatus(status: string): DisputeStatus {
  const mapping: Record<string, DisputeStatus> = {
    needs_response: "NEEDS_RESPONSE",
    warning_needs_response: "NEEDS_RESPONSE",
    under_review: "UNDER_REVIEW",
    warning_under_review: "UNDER_REVIEW",
    won: "WON",
    warning_closed: "WON",
    lost: "LOST",
    charge_refunded: "LOST",
  };

  const mapped = mapping[status];
  if (!mapped) {
    console.warn(`Unknown dispute status: ${status}`);
    return "NEEDS_RESPONSE";
  }
  return mapped;
}
```

---

## 6. Payment Flow Issues

### 6.1 Slot Overlap Detection Bug

**File:** `lib/payments/operations/checkout.ts:330-353`

**Issue:** Incomplete overlap detection logic.

```typescript
// CURRENT CODE - MISSING CASE
const existingBooking = await tx.slotOfAppointment.findFirst({
  where: {
    AND: [
      {
        OR: [
          // Case 1: Existing slot starts during new slot
          {
            AND: [
              { startsAt: { lte: slotStart } },
              { endsAt: { gt: slotStart } },
            ],
          },
          // Case 2: Existing slot ends during new slot
          {
            AND: [{ startsAt: { lt: slotEnd } }, { endsAt: { gte: slotEnd } }],
          },
          // MISSING: Case 3: New slot completely contains existing slot
        ],
      },
      { isTentative: false },
    ],
  },
});

// EXAMPLE OF MISSING CASE:
// Existing: 2pm - 4pm
// New:      1pm - 5pm
// Result:   NOT detected as overlap!
```

### 6.2 Remediation

```typescript
// FIXED: Simplified overlap detection (covers all cases)
const existingBooking = await tx.slotOfAppointment.findFirst({
  where: {
    AND: [
      // This single condition covers ALL overlap cases:
      // Two ranges overlap if and only if start1 < end2 AND start2 < end1
      { startsAt: { lt: slotEnd } },
      { endsAt: { gt: slotStart } },
      { consultantProfileId: consultantId },
      { isTentative: false },
    ],
  },
});
```

### 6.3 Payment Timeout Handling

**File:** `lib/payments/operations/checkout.ts:870`

```typescript
expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
```

**Issue:** Users aren't warned about impending expiration.

**Remediation:**

```typescript
// Frontend: Check expiration and warn user
function usePaymentExpiration(payment: Payment) {
  const [timeRemaining, setTimeRemaining] = useState<number>();

  useEffect(() => {
    if (!payment.expiresAt) return;

    const interval = setInterval(() => {
      const remaining = Math.floor(
        (new Date(payment.expiresAt).getTime() - Date.now()) / 1000 / 60,
      );
      setTimeRemaining(remaining);

      if (remaining <= 5 && remaining > 0) {
        toast.warning(`Payment expires in ${remaining} minutes`);
      }
    }, 60000);

    return () => clearInterval(interval);
  }, [payment.expiresAt]);

  return timeRemaining;
}
```

### 6.4 LemonSqueezy Incomplete Implementation

**File:** `app/api/webhooks/lemon-squeezy/route.ts:230-236`

```typescript
// TODO: Implement appointment creation based on stored payment data
console.warn("Lemon Squeezy appointment creation needs implementation...");
```

**Impact:** LemonSqueezy payments succeed but appointments are not created.

---

## 7. Fraud Prevention

### 7.1 Current State

| Control                | Status         |
| ---------------------- | -------------- |
| Signature verification | ✅ Implemented |
| Amount validation      | ✅ Implemented |
| User verification      | ⚠️ Partial     |
| Velocity checks        | ❌ Missing     |
| Device fingerprinting  | ❌ Missing     |
| IP reputation          | ❌ Missing     |

### 7.2 Recommended Fraud Checks

```typescript
// lib/payments/fraud.ts
interface FraudSignals {
  userId: string;
  ipAddress: string;
  amount: number;
  paymentMethod: string;
  deviceFingerprint?: string;
}

interface FraudScore {
  score: number; // 0-100, higher = more risky
  flags: string[];
  action: "ALLOW" | "REVIEW" | "BLOCK";
}

async function calculateFraudScore(signals: FraudSignals): Promise<FraudScore> {
  const flags: string[] = [];
  let score = 0;

  // Check 1: High-value transaction
  if (signals.amount > 500) {
    score += 10;
    flags.push("HIGH_VALUE");
  }

  // Check 2: New user
  const user = await prisma.user.findUnique({
    where: { id: signals.userId },
    select: { createdAt: true },
  });
  if (user && differenceInDays(new Date(), user.createdAt) < 7) {
    score += 15;
    flags.push("NEW_ACCOUNT");
  }

  // Check 3: Multiple cards
  const recentPayments = await prisma.payment.count({
    where: {
      userId: signals.userId,
      createdAt: { gte: subDays(new Date(), 30) },
    },
  });
  if (recentPayments > 10) {
    score += 20;
    flags.push("HIGH_VELOCITY");
  }

  // Check 4: Refund rate
  const refundRate = await calculateRefundRate(signals.userId);
  if (refundRate > 0.3) {
    score += 30;
    flags.push("HIGH_REFUND_RATE");
  }

  // Check 5: IP reputation (integrate with service like MaxMind)
  // const ipRisk = await checkIpReputation(signals.ipAddress);

  // Determine action
  let action: "ALLOW" | "REVIEW" | "BLOCK";
  if (score >= 50) {
    action = "BLOCK";
  } else if (score >= 25) {
    action = "REVIEW";
  } else {
    action = "ALLOW";
  }

  return { score, flags, action };
}

// Integration in checkout
export async function processCheckout(data: CheckoutData) {
  const fraudScore = await calculateFraudScore({
    userId: data.userId,
    ipAddress: data.ipAddress,
    amount: data.amount,
    paymentMethod: data.paymentMethod,
  });

  if (fraudScore.action === "BLOCK") {
    await logFraudAttempt(data, fraudScore);
    throw new Error("Transaction declined");
  }

  if (fraudScore.action === "REVIEW") {
    await createFraudReview(data, fraudScore);
    // Allow transaction but flag for review
  }

  // Proceed with payment
}
```

### 7.3 Dispute Pattern Detection

```typescript
async function detectDisputePatterns(userId: string): Promise<{
  isHighRisk: boolean;
  patterns: string[];
}> {
  const patterns: string[] = [];

  // Pattern 1: Multiple disputes
  const disputeCount = await prisma.dispute.count({
    where: { payment: { userId } },
  });
  if (disputeCount >= 2) {
    patterns.push("MULTIPLE_DISPUTES");
  }

  // Pattern 2: Dispute after refund denial
  const refundThenDispute = await prisma.dispute.findFirst({
    where: {
      payment: {
        userId,
        refunds: { some: { status: "FAILED" } },
      },
    },
  });
  if (refundThenDispute) {
    patterns.push("REFUND_DENIAL_DISPUTE");
  }

  // Pattern 3: Disputes near end of service
  // (User disputes after receiving most of the service)

  return {
    isHighRisk: patterns.length >= 2,
    patterns,
  };
}
```

---

## 8. Remediation Guide

### 8.1 Priority 1: Critical (Implement Immediately)

#### Add Webhook Deduplication

```bash
# 1. Add migration
npx prisma migrate dev --name add_webhook_log

# 2. Update webhook handlers to use deduplication
```

#### Fix Refund Amount Calculation

**File:** `app/api/payments/refunds/route.ts`

```typescript
// Change line 83-84 from:
.filter((r) => r.status === "SUCCEEDED")

// To:
.filter((r) => r.status === "SUCCEEDED" || r.status === "PENDING")
```

#### Fix Slot Overlap Detection

**File:** `lib/payments/operations/checkout.ts`

Replace the OR conditions with simplified overlap detection (see Section 6.2).

### 8.2 Priority 2: High (Fix This Week)

#### Add Optimistic Locking

```prisma
// Add to Payment and Appointment models
model Payment {
  version Int @default(0)
}

model Appointment {
  version Int @default(0)
}
```

#### Implement LemonSqueezy Appointment Creation

**File:** `app/api/webhooks/lemon-squeezy/route.ts`

Complete the TODO implementation for appointment creation.

### 8.3 Priority 3: Medium (Fix This Sprint)

#### Add Fraud Detection

1. Create `lib/payments/fraud.ts`
2. Integrate into checkout flow
3. Set up monitoring dashboard

#### Add Dispute Pattern Detection

1. Create detection logic
2. Add automated flagging
3. Set up review workflow

### 8.4 Monitoring Checklist

```typescript
// Metrics to track
const PAYMENT_METRICS = {
  // Volume
  "payment.created": "Counter",
  "payment.succeeded": "Counter",
  "payment.failed": "Counter",

  // Errors
  "webhook.duplicate": "Counter",
  "webhook.invalid_signature": "Counter",
  "webhook.processing_error": "Counter",

  // Fraud
  "fraud.score.high": "Counter",
  "fraud.blocked": "Counter",
  "fraud.reviewed": "Counter",

  // Refunds
  "refund.requested": "Counter",
  "refund.approved": "Counter",
  "refund.denied": "Counter",
  "refund.overrefund_attempt": "Counter",

  // Disputes
  "dispute.created": "Counter",
  "dispute.won": "Counter",
  "dispute.lost": "Counter",

  // Latency
  "checkout.duration": "Histogram",
  "webhook.processing_duration": "Histogram",
};
```

---

## Appendix: Testing Checklist

### Webhook Testing

```bash
# Test webhook signature verification
curl -X POST http://localhost:3000/api/webhooks/stripe \
  -H "Content-Type: application/json" \
  -H "stripe-signature: invalid" \
  -d '{"type": "payment_intent.succeeded"}'
# Expected: 400 Invalid signature

# Test webhook deduplication
# Send same event twice, second should return "already_processed"
```

### Race Condition Testing

```typescript
// Concurrent booking test
async function testConcurrentBooking() {
  const slotStart = new Date("2024-01-15T10:00:00Z");
  const slotEnd = new Date("2024-01-15T11:00:00Z");

  // Simulate 10 concurrent bookings for same slot
  const promises = Array(10)
    .fill(null)
    .map(() =>
      bookSlot({ slotStart, slotEnd, consultantId: "test-consultant" }),
    );

  const results = await Promise.allSettled(promises);
  const successes = results.filter((r) => r.status === "fulfilled");

  // Only 1 should succeed
  expect(successes.length).toBe(1);
}
```

### Refund Testing

```typescript
// Over-refund test
async function testOverRefund() {
  // Create $100 payment
  const payment = await createPayment({ amount: 100 });

  // Request $50 refund 3 times concurrently
  const promises = Array(3)
    .fill(null)
    .map(() => requestRefund({ paymentId: payment.id, amount: 50 }));

  const results = await Promise.allSettled(promises);
  const successes = results.filter((r) => r.status === "fulfilled");

  // Only 2 should succeed ($100 total)
  expect(successes.length).toBe(2);

  // Total refunded should not exceed original amount
  const totalRefunded = await getTotalRefunded(payment.id);
  expect(totalRefunded).toBeLessThanOrEqual(100);
}
```
