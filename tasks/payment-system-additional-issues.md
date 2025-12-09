# Payment System - Additional Issues & Improvements

**Date**: 2025-12-06
**Status**: Identified - Awaiting Fix
**Priority**: Mixed (P1-P3)
**Related**: `tasks/payment-workflow-critical-bugs.md` (Issues 1-8 now fixed)

---

## Executive Summary

After fixing the 8 critical bugs documented in `payment-workflow-critical-bugs.md`, a comprehensive audit revealed **5 additional bugs**, **3 performance optimizations**, **2 type safety issues**, and **3 code cleanup items**.

| Category      | Count | Highest Severity |
| ------------- | ----- | ---------------- |
| Bugs          | 5     | High             |
| Optimizations | 3     | High Impact      |
| Type Safety   | 2     | High             |
| Code Cleanup  | 3     | Low              |

---

## BUG-A: Missing Past Webinar Validation

### Severity: HIGH

### Situation

The webinar checkout validates that a webinar is scheduled (has appointment with slots), but does NOT validate that the scheduled time is in the future. Users can book webinars that have already occurred.

**Code Location**: `lib/payments/operations/checkout.ts:936-940`

```typescript
// Current code - only checks if scheduled, not if in future
if (!webinar.appointment?.slotsOfAppointment?.[0]) {
  throw new Error(
    "This webinar has not been scheduled yet. Please wait for the consultant to set a date and time.",
  );
}
// ❌ Missing: Check if webinar.appointment.slotsOfAppointment[0].startsAt > now
```

### How It Happens

1. Consultant creates webinar scheduled for Jan 1, 2025
2. Webinar occurs on Jan 1, 2025
3. User visits webinar page on Jan 5, 2025
4. User clicks "Book Now"
5. Checkout succeeds - user pays for past webinar!

### Impact

| Impact              | Description                                |
| ------------------- | ------------------------------------------ |
| **Revenue Issues**  | Refund requests for past events            |
| **User Confusion**  | Paying for something that already happened |
| **Support Tickets** | Users complaining about missed webinars    |
| **Data Quality**    | Bookings for past events pollute analytics |

### Fix Options

**Option A: Add time validation in checkout (Recommended)**

```typescript
// After existing schedule validation
const scheduledStart = webinar.appointment.slotsOfAppointment[0].startsAt;
if (new Date(scheduledStart) < new Date()) {
  throw new Error(
    "This webinar has already occurred and is no longer available for booking.",
  );
}
```

**Option B: Add buffer time (15 minutes before start)**

```typescript
const scheduledStart = webinar.appointment.slotsOfAppointment[0].startsAt;
const bufferMs = 15 * 60 * 1000; // 15 minutes
if (new Date(scheduledStart).getTime() - bufferMs < Date.now()) {
  throw new Error("This webinar is starting soon or has already occurred.");
}
```

**Recommended**: Option B (allows late joiners but prevents past bookings)

### Testing Checklist

- [ ] Booking webinar in past throws error
- [ ] Booking webinar starting in 10 minutes throws error (with buffer)
- [ ] Booking webinar in future succeeds
- [ ] Error message is user-friendly

---

## BUG-B: Race Condition in Refund Calculation

### Severity: HIGH

### Situation

When processing refunds, the available refund amount is calculated by summing existing refunds. This calculation is not protected by a transaction, allowing concurrent refund requests to exceed the original payment amount.

**Code Location**: `app/api/payments/refunds/route.ts:84-103`

```typescript
// Current code - no transaction protection
const existingRefunds = await prisma.refund.findMany({
  where: { paymentId: payment.id },
});

const totalRefunded = existingRefunds.reduce((sum, r) => sum + r.amount, 0);
const availableForRefund = payment.amount - totalRefunded;

// ⚠️ Between this check and creating the refund, another request could succeed
if (amount > availableForRefund) {
  throw new Error("Refund amount exceeds available balance");
}

// Create refund - race condition window!
await prisma.refund.create({ ... });
```

### How It Happens

```
T=0:00   Payment of $100 exists, no refunds yet
T=0:01   Request A: Calculate available = $100 - $0 = $100
T=0:02   Request B: Calculate available = $100 - $0 = $100
T=0:03   Request A: Create $50 refund (succeeds)
T=0:04   Request B: Create $75 refund (succeeds!)
         Total refunded: $125 > $100 original payment!
```

### Impact

| Impact              | Description                              |
| ------------------- | ---------------------------------------- |
| **Financial Loss**  | Refunding more than paid                 |
| **Gateway Errors**  | Stripe/Razorpay will reject over-refunds |
| **Data Corruption** | Refund totals don't match payment        |
| **Audit Issues**    | Financial records inconsistent           |

### Fix Options

**Option A: Wrap in transaction with row lock (Recommended)**

```typescript
await prisma.$transaction(async (tx) => {
  // Lock the payment row for update
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    // Prisma doesn't support SELECT FOR UPDATE directly
    // Use raw query or optimistic locking
  });

  const existingRefunds = await tx.refund.findMany({
    where: { paymentId: payment.id },
  });

  const totalRefunded = existingRefunds.reduce((sum, r) => sum + r.amount, 0);
  const availableForRefund = payment.amount - totalRefunded;

  if (amount > availableForRefund) {
    throw new Error("Refund amount exceeds available balance");
  }

  await tx.refund.create({ ... });
});
```

**Option B: Use distributed lock (Redis)**

```typescript
const lock = await lockPaymentRefund(paymentId);
try {
  // ... refund logic
} finally {
  await unlockPaymentRefund(lock);
}
```

**Option C: Optimistic locking with version field**

Add `refundVersion` field to Payment model, increment on each refund.

**Recommended**: Option A (simplest, uses existing Prisma transaction)

### Testing Checklist

- [ ] Concurrent refund requests don't exceed payment amount
- [ ] Sequential refunds work correctly
- [ ] Error message clear when exceeding balance
- [ ] Transaction rolls back on failure

---

## BUG-C: Zero/Negative Amount Payments

### Severity: MEDIUM

### Situation

The payment intent creation doesn't validate that the amount is positive. Zero-cost items (100% discount) or calculation errors could create invalid payment intents.

**Code Location**: `lib/payments/core/stripe.ts:76-122`

```typescript
export async function createStripePaymentIntent(params: {
  amount: number;
  currency: string;
  // ...
}) {
  // ❌ No validation of amount > 0
  const session = await stripe.checkout.sessions.create({
    line_items: [
      {
        price_data: {
          unit_amount: params.amount, // Could be 0 or negative!
          // ...
        },
      },
    ],
  });
}
```

### How It Happens

1. Plan costs $100
2. User applies 100% discount code
3. Discounted amount = $0
4. Payment intent created with amount = 0
5. Stripe may reject or create invalid session

### Impact

| Impact             | Description                         |
| ------------------ | ----------------------------------- |
| **Gateway Errors** | Stripe rejects zero-amount payments |
| **UX Issues**      | Confusing error messages            |
| **Free Access**    | If bypassed, users get free access  |
| **Reporting**      | $0 payments skew revenue metrics    |

### Fix Options

**Option A: Validate in payment creation (Recommended)**

```typescript
export async function createStripePaymentIntent(params: { amount: number; ... }) {
  if (params.amount <= 0) {
    throw new Error("Payment amount must be greater than zero");
  }
  // ... rest of function
}
```

**Option B: Handle zero-amount as free checkout**

```typescript
if (params.amount === 0) {
  // Skip payment gateway, directly confirm appointment
  return {
    id: `free_${Date.now()}`,
    client_secret: null,
    isFreeCheckout: true,
  };
}
```

**Option C: Validate discount doesn't exceed plan price**

```typescript
// In checkout.ts discount calculation
const discountedAmount =
  discount.discountType === "PERCENTAGE"
    ? amount * (1 - discount.discountValue / 100)
    : Math.max(1, amount - discount.discountValue); // Minimum $0.01

if (discountedAmount < 100) {
  // Minimum 1 INR/USD in cents
  throw new Error("Discount cannot reduce price below minimum");
}
```

**Recommended**: Option A + Option C (validate at both points)

### Testing Checklist

- [ ] 100% discount code throws appropriate error
- [ ] Negative amount throws error
- [ ] Minimum payment amount enforced
- [ ] Error messages guide user to contact support

---

## BUG-D: Approval Flow Missing User Profile Validation

### Severity: MEDIUM

### Situation

The approval payment creation doesn't verify that the user has a consultee profile before creating the payment intent. This could cause issues during webhook processing.

**Code Location**: `lib/payments/operations/approval-payment.ts:55-113`

```typescript
export async function createApprovalPaymentIntent(
  params: CreateApprovalPaymentParams,
): Promise<ApprovalPaymentResult> {
  // Validates consultationId/subscriptionId exist
  if (params.appointmentType === "CONSULTATION" && !params.consultationId) {
    throw new Error("consultationId required...");
  }

  // ❌ Missing: Validate user has consultee profile
  // The webhook handler (handlers.ts:335) will fail if profile missing

  const paymentResponse = await createPaymentIntent({ ... });
  // ...
}
```

### How It Happens

1. Admin/consultant creates user without consultee profile
2. Consultant approves a request for this user
3. Payment link generated successfully
4. User pays
5. Webhook fails: "User profile not found for payment"
6. User charged but no appointment created!

### Impact

| Impact                      | Description                            |
| --------------------------- | -------------------------------------- |
| **Payment Without Service** | User pays but gets nothing             |
| **Manual Recovery**         | Admin must create appointment manually |
| **Support Burden**          | Confusing situation for all parties    |
| **Trust Issues**            | User loses trust in platform           |

### Fix Options

**Option A: Validate profile before payment creation (Recommended)**

```typescript
export async function createApprovalPaymentIntent(params) {
  // ... existing validation

  // Validate user has consultee profile
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    include: { consulteeProfile: true },
  });

  if (!user) {
    throw new Error("User not found");
  }

  if (!user.consulteeProfile) {
    throw new Error(
      "User does not have a consultee profile. Please complete profile setup first.",
    );
  }

  // ... rest of function
}
```

**Option B: Auto-create consultee profile if missing**

```typescript
if (!user.consulteeProfile) {
  await prisma.consulteeProfile.create({
    data: { userId: user.id },
  });
}
```

**Recommended**: Option A (fail fast, don't auto-create incomplete profiles)

### Testing Checklist

- [ ] User without profile gets clear error
- [ ] User with profile can create payment
- [ ] Error prevents payment intent creation (no charge)
- [ ] Consultant sees helpful error message

---

## BUG-E: Plan Deletion Race Condition

### Severity: MEDIUM

### Situation

Plan validation occurs before acquiring the distributed lock. Between validation and checkout completion, the plan could be deleted or disabled.

**Code Location**: `lib/payments/operations/checkout.ts:178-293` (validation) vs `1152-1165` (lock)

```typescript
// Step 1: Validate plan (OUTSIDE LOCK)
const { amount, currency } = await calculateAmountAndValidate(data, userId);
// Plan confirmed to exist here

// Step 2: Acquire lock
lock = await acquireCheckoutLock(data, planData);

// ⚠️ Between steps 1 and 2, plan could be deleted!

// Step 3: Inside lock - plan assumed to still exist
const result = await prisma.$transaction(async (tx) => {
  // Uses planId from step 1, but plan might be gone
});
```

### How It Happens

```
T=0:00   User A: Validate plan P1 exists ✓
T=0:01   Admin: Delete plan P1
T=0:02   User A: Acquire lock for P1 checkout
T=0:03   User A: Create payment for deleted plan → ERROR
```

### Impact

| Impact             | Description                                |
| ------------------ | ------------------------------------------ |
| **Cryptic Errors** | "Plan not found" during checkout           |
| **Payment Issues** | Payment intent created but DB insert fails |
| **UX Degradation** | User sees error after entering payment     |
| **Cleanup Needed** | Orphaned payment intents                   |

### Fix Options

**Option A: Re-validate plan inside lock (Recommended)**

```typescript
// After acquiring lock, before transaction
await revalidateInsideLock(validatedData, userId);

// Add to revalidateInsideLock:
async function revalidateInsideLock(data, userId) {
  // Existing slot validation...

  // Add: Re-verify plan exists
  const plan = await getPlanById(data.appointmentType, data.planId);
  if (!plan) {
    throw new Error("Plan is no longer available");
  }
}
```

**Option B: Use database-level constraints**

Rely on foreign key constraints to fail the insert if plan deleted.

**Option C: Soft-delete plans with availability window**

Plans are never hard-deleted, just marked inactive. Checkout checks active status.

**Recommended**: Option A (explicit validation is clearest)

### Testing Checklist

- [ ] Deleting plan during checkout causes clear error
- [ ] Payment intent cancelled if plan deleted
- [ ] Lock released on plan deletion error
- [ ] User sees friendly "plan unavailable" message

---

## OPT-1: Heavy Include Chains in Notifications

### Category: Performance

### Impact: HIGH

### Situation

Payment notification functions fetch entire entity graphs with 4+ levels of nested includes, when only consultant name and email are needed.

**Code Location**: `lib/payments/webhooks/handlers.ts:246-278, 804-841`

```typescript
// Current: Fetches EVERYTHING
const payment = await tx.payment.findUnique({
  where: { paymentIntent: paymentIntentId },
  include: {
    user: true,
    appointment: {
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true, // Just need name!
                  },
                },
              },
            },
          },
        },
        subscription: {
          /* same deep nesting */
        },
      },
    },
  },
});
```

### Impact

- Fetches 10+ tables when only 2-3 fields needed
- Slower response times under load
- Higher database connection usage
- Memory pressure from large result sets

### Fix

```typescript
// Optimized: Fetch only what's needed
const notificationData = await tx.payment.findUnique({
  where: { paymentIntent: paymentIntentId },
  select: {
    id: true,
    amount: true,
    currency: true,
    user: {
      select: { email: true, name: true },
    },
    appointment: {
      select: {
        consultation: {
          select: {
            consultationPlan: {
              select: {
                consultantProfile: {
                  select: {
                    user: { select: { name: true } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});
```

### Estimated Improvement

- Query size: ~80% reduction
- Response time: 20-50ms improvement
- Memory: ~70% reduction per request

---

## OPT-2: Duplicate Participant Counting Logic

### Category: Code Duplication

### Impact: MEDIUM

### Situation

Participant counting for webinars and classes is implemented differently in 3 locations with subtle differences.

**Locations**:

1. `checkout.ts:245-250` (webinar validation)
2. `checkout.ts:277-281` (class validation)
3. `checkout.ts:1005-1012` (class checkout)

```typescript
// Location 1: Simple optional chaining
const currentParticipants =
  webinar.appointment?.slotsOfAppointment?.length || 0;

// Location 2: Reduce pattern
const currentParticipants = classInstance.appointments.reduce(
  (total, apt) => total + apt.slotsOfAppointment.length,
  0,
);

// Location 3: Set-based unique counting
const uniqueUserIds = new Set<string>();
for (const apt of classInstance.appointments) {
  for (const slot of apt.slotsOfAppointment) {
    if (slot.user && Array.isArray(slot.user)) {
      slot.user.forEach((u) => uniqueUserIds.add(u.id));
    }
  }
}
```

### Issues

- Location 1 counts slots, Location 3 counts unique users
- For multi-slot-per-user scenarios, counts differ
- Bug potential: Inconsistent capacity enforcement

### Fix

```typescript
// utils/eventParticipants.ts
export function countUniqueParticipants(
  appointments: Array<{
    slotsOfAppointment: Array<{ user?: Array<{ id: string }> }>;
  }>,
): number {
  const uniqueUserIds = new Set<string>();

  for (const apt of appointments) {
    for (const slot of apt.slotsOfAppointment) {
      if (Array.isArray(slot.user)) {
        slot.user.forEach((u) => uniqueUserIds.add(u.id));
      }
    }
  }

  return uniqueUserIds.size;
}

// For single-appointment events (webinars)
export function countWebinarParticipants(
  appointment: {
    slotsOfAppointment: Array<{ user?: Array<{ id: string }> }>;
  } | null,
): number {
  if (!appointment) return 0;
  return countUniqueParticipants([appointment]);
}
```

---

## OPT-3: Missing Database Indexes

### Category: Performance

### Impact: HIGH (at scale)

### Situation

The `validateSlotAvailability` function performs complex range queries without optimal indexes.

**Query Pattern** (checkout.ts:356-378):

```sql
SELECT * FROM "SlotOfAppointment"
WHERE (
  (startsAt <= $1 AND endsAt > $1)
  OR (startsAt < $2 AND endsAt >= $2)
)
AND isTentative = false
```

### Current Indexes

```prisma
model SlotOfAppointment {
  // ...
  @@index([appointmentId])
  @@index([isTentative, appointmentId])
}
```

### Recommended Additional Indexes

```prisma
model SlotOfAppointment {
  // Existing
  @@index([appointmentId])
  @@index([isTentative, appointmentId])

  // New: For time range queries
  @@index([startsAt, endsAt])
  @@index([isTentative, startsAt, endsAt])
}
```

### Migration

```sql
CREATE INDEX idx_slot_time_range ON "SlotOfAppointment" ("startsAt", "endsAt");
CREATE INDEX idx_slot_tentative_time ON "SlotOfAppointment" ("isTentative", "startsAt", "endsAt");
```

---

## TYPE-1: Unsafe `any` Type in Payment Response

### Category: Type Safety

### Severity: HIGH

### Situation

**Code Location**: `checkout.ts:1149`

```typescript
let paymentResponse: any = null; // ❌ Loses all type safety
```

### Fix

```typescript
interface PaymentIntentResponse {
  id: string;
  client_secret: string | null;
  status?: string;
}

let paymentResponse: PaymentIntentResponse | null = null;
```

---

## TYPE-2: Unsafe Type Casting

### Category: Type Safety

### Severity: MEDIUM

### Situation

**Code Location**: `checkout.ts:1008`

```typescript
slot.user.forEach((u: { id: string }) => uniqueUserIds.add(u.id));
// Casting without validation
```

### Fix

```typescript
// Add type guard
function isUserWithId(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && "id" in value;
}

// Use safely
if (Array.isArray(slot.user)) {
  slot.user.filter(isUserWithId).forEach((u) => uniqueUserIds.add(u.id));
}
```

---

## CLEAN-1: Dead Code - Unused `confirmAppointment`

### Category: Code Cleanup

### Severity: LOW

**Location**: `checkout.ts:1078-1127`

This function duplicates `confirmExistingAppointment` in handlers.ts but is never called. The handlers.ts version is more complete (handles multi-user events).

**Action**: Remove function entirely.

---

## CLEAN-2: Unused Import

### Category: Code Cleanup

### Severity: LOW

**Location**: `checkout.ts:19`

```typescript
import { handlePaymentSuccess } from "@/lib/payments/webhooks/handlers";
// ❌ Never used in file
```

**Action**: Remove import.

---

## CLEAN-3: Unused Parameter

### Category: Code Cleanup

### Severity: LOW

**Location**: `checkout.ts:1081`

```typescript
export async function confirmAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
  _appointmentType: string,  // ❌ Never used
) {
```

**Action**: Remove parameter (or remove entire function per CLEAN-1).

---

## Implementation Priority Matrix

| ID      | Severity | Effort  | Risk if Unfixed | Priority |
| ------- | -------- | ------- | --------------- | -------- |
| BUG-A   | High     | Low     | Medium          | P1       |
| BUG-B   | High     | Medium  | High            | P1       |
| BUG-C   | Medium   | Low     | Low             | P2       |
| BUG-D   | Medium   | Low     | Medium          | P2       |
| BUG-E   | Medium   | Low     | Low             | P3       |
| OPT-1   | High     | Medium  | N/A (perf)      | P2       |
| OPT-2   | Medium   | Low     | N/A (maint)     | P3       |
| OPT-3   | High     | Low     | N/A (perf)      | P2       |
| TYPE-1  | High     | Low     | Medium          | P2       |
| TYPE-2  | Medium   | Low     | Low             | P3       |
| CLEAN-1 | Low      | Low     | N/A             | P3       |
| CLEAN-2 | Low      | Trivial | N/A             | P3       |
| CLEAN-3 | Low      | Trivial | N/A             | P3       |

---

## Recommended Fix Order

**Phase 1 - Quick Wins (30 min)**

1. BUG-A: Past webinar validation
2. CLEAN-2: Remove unused import
3. CLEAN-3: Remove unused parameter
4. TYPE-1: Add PaymentIntentResponse type

**Phase 2 - Critical Bugs (1-2 hours)** 5. BUG-B: Refund race condition 6. BUG-C: Zero amount validation 7. BUG-D: Profile validation

**Phase 3 - Optimization (2-3 hours)** 8. OPT-1: Optimize notification queries 9. OPT-2: Extract participant counting 10. OPT-3: Add database indexes

**Phase 4 - Cleanup** 11. CLEAN-1: Remove dead code 12. TYPE-2: Add type guards 13. BUG-E: Plan deletion race

---

_Created by: Payment System Audit_
_Last Updated: 2025-12-06_
