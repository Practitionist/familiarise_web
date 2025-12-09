# Payment Workflow Critical Bugs

**Date**: 2025-12-06
**Status**: Identified - Awaiting Fix
**Priority**: P0 (Critical)
**Affected Files**:

- `lib/payments/operations/checkout.ts`
- `lib/payments/webhooks/handlers.ts`

---

## Executive Summary

During a comprehensive validation of all payment workflows for the 4 appointment types (Consultation, Subscription, Webinar, Class), **3 critical bugs**, **3 high-priority issues**, and **2 medium-priority issues** were identified. These bugs can result in:

- Users receiving paid services without paying
- Duplicate database records causing data corruption
- Partial service delivery (only 1 of N sessions accessible)
- Race conditions under high load
- Incorrect slot times for webinars
- Development/testing data inconsistencies

| #   | Severity    | Issue                               | Affected Types             |
| --- | ----------- | ----------------------------------- | -------------------------- |
| 1   | 🔴 Critical | Wrong user's slots confirmed        | Webinar, Class             |
| 2   | 🔴 Critical | Duplicate subscription creation     | Subscription               |
| 3   | 🔴 Critical | Only first session confirmed        | Class                      |
| 4   | 🟠 High     | Lock TTL mismatch (30s vs 60s)      | All types                  |
| 5   | 🟠 High     | Webinar slot timing defaults to now | Webinar                    |
| 6   | 🟠 High     | Mock payment status never updated   | All (dev)                  |
| 7   | 🟡 Medium   | Approval flow no duplicate check    | Consultation, Subscription |
| 8   | 🟡 Medium   | Failure handler lacks idempotency   | All types                  |

---

## Issue #1: Webinar/Class Confirms Wrong User's Slots

### Situation

When a user's payment succeeds for a webinar or class, the webhook handler confirms **all tentative slots** for that shared appointment, not just the paying user's slot.

**Code Location**: `lib/payments/webhooks/handlers.ts:624-631`

```typescript
async function confirmExistingAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
) {
  // BUG: Updates ALL slots for this appointment, regardless of user
  await tx.slotOfAppointment.updateMany({
    where: { appointmentId }, // ⚠️ No user filter!
    data: { isTentative: false },
  });
  // ...
}
```

### How It Happens

**Webinar Database Model**:

```
Webinar "React Basics" (max 50 participants)
  └── Appointment (shared by all participants)
        ├── SlotOfAppointment { userId: "user_A", isTentative: true }
        ├── SlotOfAppointment { userId: "user_B", isTentative: true }
        └── SlotOfAppointment { userId: "user_C", isTentative: true }
```

**Timeline**:

```
T=0:00  User A starts checkout → creates tentative slot for User A
T=0:05  User B starts checkout → creates tentative slot for User B
T=0:10  User C starts checkout → creates tentative slot for User C
T=0:30  User A completes payment
        → Webhook calls confirmExistingAppointment(webinarAppointmentId)
        → SQL: UPDATE slots SET isTentative=false WHERE appointmentId='xyz'
        → ALL 3 slots become confirmed!
T=1:00  User B abandons checkout (never pays)
T=2:00  User C's payment fails

RESULT: Users B and C have confirmed slots without paying!
```

### Impact

| Impact                | Description                                         |
| --------------------- | --------------------------------------------------- |
| **Revenue Loss**      | Users access paid content without payment           |
| **Capacity Issues**   | Confirmed non-paying users consume available slots  |
| **Audit Trail**       | Payment records don't match slot confirmations      |
| **Refund Complexity** | No payment to refund for non-paying confirmed users |

**Estimated Financial Impact**: If 10% of webinar/class checkouts are concurrent, approximately 5% of confirmed slots may be unpaid.

### Root Cause

The `confirmExistingAppointment` function was designed for 1:1 appointments (consultations) where each appointment has exactly one slot. For multi-user events (webinars/classes), the shared appointment model means the function confirms slots for ALL users.

### Fix

**Option A: Add userId parameter to confirmation function**

```typescript
async function confirmExistingAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
  userId?: string, // NEW: Optional user filter
) {
  const whereClause: Prisma.SlotOfAppointmentWhereInput = { appointmentId };

  // For multi-user events, only confirm the specific user's slot
  if (userId) {
    whereClause.user = { some: { id: userId } };
  }

  await tx.slotOfAppointment.updateMany({
    where: whereClause,
    data: { isTentative: false },
  });
  // ... rest of function
}
```

**Option B: Store slotId in payment record**

```typescript
// In checkout.ts, store the specific slot ID
const slot = await tx.slotOfAppointment.create({...});

await tx.payment.create({
  data: {
    // ...existing fields
    slotOfAppointmentId: slot.id,  // NEW: Link to specific slot
  },
});

// In webhook handler, confirm only that slot
await tx.slotOfAppointment.update({
  where: { id: payment.slotOfAppointmentId },
  data: { isTentative: false },
});
```

**Recommended**: Option B (more precise, no ambiguity)

### Testing Checklist

- [ ] Concurrent webinar checkout: only paying user's slot confirmed
- [ ] Concurrent class checkout: only paying user's slots confirmed
- [ ] Payment failure: only failing user's slot remains tentative
- [ ] Existing consultation flow unchanged (regression test)

---

## Issue #2: Subscription Duplicate Creation

### Situation

When a user checks out a subscription, the system creates the subscription record during checkout. When payment succeeds, the webhook handler creates **another subscription record** from metadata, resulting in duplicate subscriptions.

**Code Locations**:

- Checkout: `lib/payments/operations/checkout.ts:825-836`
- Webhook: `lib/payments/webhooks/handlers.ts:347-356, 412-474`

### How It Happens

**Step 1: Checkout creates Subscription A**

```typescript
// checkout.ts:825-836
const subscription = await tx.subscription.create({
  data: {
    subscriptionPlanId: plan.id,
    requestStatus: RequestStatus.PENDING,
    // ...
  },
});

// BUT: createdAppointment is set to null for subscriptions
createdAppointment = null; // Line 1174
```

**Step 2: Payment record has no appointmentId**

```typescript
// checkout.ts:1217
await tx.payment.create({
  data: {
    // ...
    appointmentId: createdAppointment?.id || null, // NULL for subscriptions!
  },
});
```

**Step 3: Webhook uses legacy flow and creates Subscription B**

```typescript
// handlers.ts:186-204
if (payment.appointmentId) {
  // NEW FLOW: Confirm existing
} else {
  // LEGACY FLOW: Creates NEW subscription!
  appointment = await createAppointmentFromWebhook(tx, metadata, payment);
}

// handlers.ts:347-356
case AppointmentsType.SUBSCRIPTION:
  appointment = await createSubscription(tx, {...});  // Creates SECOND subscription!
  break;
```

### Database State After Bug

```
Subscription A (created during checkout):
  id: "sub_abc123"
  status: PENDING  ← Never updated, orphaned forever
  planId: "plan_xyz"
  userId: "user_001"

Subscription B (created by webhook):
  id: "sub_def456"
  status: APPROVED
  planId: "plan_xyz"
  userId: "user_001"

Payment:
  id: "pay_789"
  appointmentId: null → points to Subscription B's appointment
```

### Impact

| Impact                 | Description                               |
| ---------------------- | ----------------------------------------- |
| **Data Corruption**    | Two subscription records for one purchase |
| **Orphaned Records**   | Subscription A remains PENDING forever    |
| **Reporting Errors**   | Analytics show double the subscriptions   |
| **User Confusion**     | Dashboard may show duplicate entries      |
| **Cleanup Complexity** | No automated way to identify orphans      |

### Root Cause

The subscription checkout flow was modified to not create appointments during checkout (consultant allocates slots later via Requests tab), but the webhook handler was not updated to handle this case. The payment record has no way to link back to the subscription created during checkout.

### Fix

**Option A: Store subscriptionId in payment record (Recommended)**

```typescript
// 1. Add subscriptionId to Payment model in schema.prisma
model Payment {
  // ...existing fields
  subscriptionId String?
  subscription   Subscription? @relation(fields: [subscriptionId], references: [id])
}

// 2. In checkout.ts, link payment to subscription
case "SUBSCRIPTION": {
  const subscriptionResult = await handleSubscriptionCheckout(...);

  await tx.payment.create({
    data: {
      // ...
      subscriptionId: subscriptionResult.subscription.id,  // NEW
    },
  });
  break;
}

// 3. In webhook handler, check for existing subscription
if (payment.subscriptionId) {
  // Subscription already exists, just confirm it
  await tx.subscription.update({
    where: { id: payment.subscriptionId },
    data: { requestStatus: RequestStatus.APPROVED },
  });
} else {
  // Legacy flow for old payments
  appointment = await createAppointmentFromWebhook(tx, metadata, payment);
}
```

**Option B: Store subscriptionId in metadata**

```typescript
// In buildPaymentMetadata
function buildPaymentMetadata(data, userId, subscriptionId?: string) {
  return {
    // ...existing
    subscriptionId: subscriptionId || "",
  };
}

// In webhook, check metadata first
if (metadata.subscriptionId) {
  await confirmExistingSubscription(tx, metadata.subscriptionId);
} else {
  // Legacy creation
}
```

**Recommended**: Option A (database-level integrity, queryable)

### Testing Checklist

- [ ] New subscription checkout: only one subscription created
- [ ] Payment success: existing subscription updated to APPROVED
- [ ] Payment failure: subscription cleaned up or remains PENDING
- [ ] Legacy payments (no subscriptionId): still create subscription
- [ ] No orphaned PENDING subscriptions after 24h

---

## Issue #3: Class Only First Session Confirmed

### Situation

When a user enrolls in a multi-session class (e.g., 10-week course), the checkout creates slots across ALL appointments (sessions). However, the payment record only stores the first appointment's ID. When payment succeeds, only the first session's slots are confirmed.

**Code Locations**:

- Slot creation: `lib/payments/operations/checkout.ts:986-1004`
- First appointment return: `lib/payments/operations/checkout.ts:1007-1017`
- Webhook confirmation: `lib/payments/webhooks/handlers.ts:628-631`

### How It Happens

**Step 1: Checkout creates slots for ALL sessions**

```typescript
// checkout.ts:986-1004
for (const appointment of classInstance.appointments) {
  const slot = await tx.slotOfAppointment.create({
    data: {
      appointmentId: appointment.id,
      isTentative: !skipPayment,
      user: { connect: { id: userId } },
    },
  });
  createdSlots.push(slot);
}
// createdSlots = [slot_week1, slot_week2, ..., slot_week10]
```

**Step 2: Only FIRST appointment returned**

```typescript
// checkout.ts:1007-1014
const firstAppointment = classInstance.appointments[0];
return {
  appointment: firstAppointment, // Only week 1!
  plan,
  amount: plan.price,
  slotsCreated: createdSlots.length,
};
```

**Step 3: Payment links to first appointment only**

```typescript
// checkout.ts:1217
appointmentId: createdAppointment?.id || null,  // Only week 1's appointment ID
```

**Step 4: Webhook confirms only first session**

```typescript
// handlers.ts:628-631
await tx.slotOfAppointment.updateMany({
  where: { appointmentId }, // Only matches week 1
  data: { isTentative: false },
});
```

### Database State After Bug

```
Class "Python Bootcamp" (10 weeks)
├── Appointment Week 1 (ID: appt_001)
│   └── User's Slot: isTentative = false  ✅ CONFIRMED
├── Appointment Week 2 (ID: appt_002)
│   └── User's Slot: isTentative = true   ❌ STILL TENTATIVE
├── Appointment Week 3 (ID: appt_003)
│   └── User's Slot: isTentative = true   ❌ STILL TENTATIVE
...
└── Appointment Week 10 (ID: appt_010)
    └── User's Slot: isTentative = true   ❌ STILL TENTATIVE

Payment:
  appointmentId: "appt_001"  ← Only links to week 1
```

### Impact

| Impact                             | Description                                 |
| ---------------------------------- | ------------------------------------------- |
| **Partial Access**                 | User can only access 1 of 10 sessions       |
| **Cleanup Job Deletes Paid Slots** | Weeks 2-10 slots deleted as "abandoned"     |
| **Support Tickets**                | Users report missing sessions               |
| **Refund Requests**                | Perceived as service not delivered          |
| **Manual Fix Required**            | Admin must manually confirm remaining slots |

### Root Cause

The class checkout was designed to create all slots at once for efficiency, but the payment linking was designed for single-appointment types. The return value only includes the first appointment, and there's no mechanism to confirm slots across multiple appointments.

### Fix

**Option A: Store all slot IDs in payment metadata**

```typescript
// In checkout.ts, store slot IDs
const createdSlotIds = createdSlots.map(s => s.id);

return {
  appointment: firstAppointment,
  plan,
  amount: plan.price,
  slotsCreated: createdSlots.length,
  slotIds: createdSlotIds,  // NEW
};

// In metadata
metadata: {
  ...buildPaymentMetadata(validatedData, userId),
  classSlotIds: createdSlotIds.join(','),  // NEW
}

// In webhook handler
if (metadata.classSlotIds) {
  const slotIds = metadata.classSlotIds.split(',');
  await tx.slotOfAppointment.updateMany({
    where: { id: { in: slotIds } },
    data: { isTentative: false },
  });
}
```

**Option B: Confirm by userId + classId**

```typescript
// In webhook handler, for CLASS type
if (appointment?.class) {
  // Confirm ALL user's slots for this class
  await tx.slotOfAppointment.updateMany({
    where: {
      appointment: { classId: appointment.class.id },
      user: { some: { id: payment.userId } },
    },
    data: { isTentative: false },
  });
}
```

**Option C: Store all appointment IDs in junction table**

```typescript
// Create PaymentAppointment junction table
model PaymentAppointment {
  paymentId     String
  appointmentId String
  payment       Payment     @relation(...)
  appointment   Appointment @relation(...)
  @@id([paymentId, appointmentId])
}

// In checkout, link all appointments
for (const appointment of classInstance.appointments) {
  await tx.paymentAppointment.create({
    data: { paymentId: payment.id, appointmentId: appointment.id },
  });
}

// In webhook, confirm all linked appointments
const linkedAppointments = await tx.paymentAppointment.findMany({
  where: { paymentId: payment.id },
});
for (const link of linkedAppointments) {
  await confirmExistingAppointment(tx, link.appointmentId, payment.userId);
}
```

**Recommended**: Option B (simplest, no schema changes)

### Testing Checklist

- [ ] Class enrollment: all 10 sessions confirmed after payment
- [ ] Payment failure: all 10 sessions cleaned up
- [ ] Partial cleanup: if week 1 confirmed manually, others still work
- [ ] Cleanup job: doesn't delete paid user's slots
- [ ] User dashboard: shows all sessions as confirmed

---

## Issue #4: Lock TTL Mismatch

### Situation

The checkout flow explicitly uses 30-second lock TTL, but the documentation and `appointmentlock.ts` specify 60 seconds as the default. This inconsistency can cause race conditions under high load.

**Code Locations**:

- Checkout locks: `lib/payments/operations/checkout.ts:576, 595, 610`
- Default TTL: `utils/appointmentlock.ts:47`

### How It Happens

```typescript
// checkout.ts uses explicit 30s
return await lockSlotBooking(consultantUserId, data.slotStartTimeInUTC, 30000); // 30s
return await lockEventCheckout(appointmentType, data.eventId, 30000); // 30s

// appointmentlock.ts default is 60s
const DEFAULT_LOCK_TTL = 60000; // 60 seconds
```

### When This Causes Problems

**Scenario: Slow Database Under Load**

```
T=0:00   User A acquires lock (TTL=30s)
T=0:05   User A starts database transaction
T=0:25   Database slow due to load (P99 latency spike)
T=0:30   Lock expires! ⚠️
T=0:31   User B acquires same lock
T=0:32   User B starts competing transaction
T=0:35   User A's transaction completes → creates slot
T=0:40   User B's transaction completes → creates DUPLICATE slot!
```

### Impact

| Impact                   | Description                         |
| ------------------------ | ----------------------------------- |
| **Race Conditions**      | Lock expires during slow operations |
| **Double Bookings**      | Two users book same slot            |
| **Data Integrity**       | Overlapping appointments            |
| **Production Incidents** | Under high load, issue manifests    |

### Root Cause

When the lock TTL was updated from 30s to 60s in `appointmentlock.ts`, the explicit overrides in `checkout.ts` were not updated.

### Fix

**Option A: Remove explicit TTL (use defaults)**

```typescript
// Before
return await lockSlotBooking(consultantUserId, data.slotStartTimeInUTC, 30000);

// After - use default 60s from appointmentlock.ts
return await lockSlotBooking(consultantUserId, data.slotStartTimeInUTC);
```

**Option B: Update to 60s explicitly**

```typescript
// Update all three locations
return await lockSlotBooking(consultantUserId, data.slotStartTimeInUTC, 60000);
return await lockEventCheckout(appointmentType, data.eventId, 60000);
return await lockEventCheckout(appointmentType, data.planId, 60000);
```

**Recommended**: Option A (DRY principle, single source of truth)

### Testing Checklist

- [ ] Lock TTL is 60s in production logs
- [ ] Slow database (simulate with pg_sleep) doesn't cause race
- [ ] Documentation matches implementation

---

## Implementation Priority

| Priority | Issue                          | Effort   | Risk if Unfixed           |
| -------- | ------------------------------ | -------- | ------------------------- |
| P0       | #1 Wrong user slots confirmed  | Medium   | Revenue loss, free access |
| P0       | #2 Duplicate subscriptions     | Medium   | Data corruption           |
| P0       | #3 Class partial confirmation  | Low      | Service not delivered     |
| P1       | #4 Lock TTL mismatch           | Low      | Race conditions           |
| P1       | #5 Webinar slot timing         | Low      | Incorrect slot times      |
| P1       | #6 Mock payment status         | Low      | Data inconsistency        |
| P2       | #7 Approval flow no dedup      | Low      | Duplicate payments        |
| P2       | #8 Failure handler idempotency | Very Low | Minor cleanup issues      |

### Recommended Implementation Order

1. **Issue #4** (5 min) - Quick fix, reduces risk for other fixes
2. **Issue #3** (30 min) - Simple fix with Option B
3. **Issue #1** (1 hour) - Requires careful testing with concurrent users
4. **Issue #2** (2 hours) - Requires schema change and migration
5. **Issue #5** (30 min) - Add scheduled time to Webinar model
6. **Issue #6** (15 min) - Update mock payment status in checkout
7. **Issue #7** (15 min) - Add check before creating approval payment
8. **Issue #8** (5 min) - Add idempotency check to failure handler

---

## Issue #5: Webinar Slot Timing Defaults to Current Time

### Situation

When the first user books a webinar, the slot creation code falls back to `new Date()` for start/end times because there are no existing slots to copy from. The Webinar model lacks scheduled time fields.

**Code Locations**:

- Checkout: `lib/payments/operations/checkout.ts:910-912`
- Webhook: `lib/payments/webhooks/handlers.ts:502-504`

### How It Happens

**Step 1: First webinar booking**

```typescript
// checkout.ts:910-912
await tx.slotOfAppointment.create({
  data: {
    startsAt:
      webinar.appointment?.slotsOfAppointment[0]?.startsAt || new Date(), // ⚠️ No existing slots!
    endsAt: webinar.appointment?.slotsOfAppointment[0]?.endsAt || new Date(), // ⚠️ Defaults to NOW
    // ...
  },
});
```

**Database Schema Issue**:

```prisma
model Webinar {
  id              String        @id @default(cuid())
  status          WebinarStatus @default(SCHEDULED)
  // ❌ NO scheduledStartAt field!
  // ❌ NO scheduledEndAt field!
  webinarPlanId   String
  appointment     Appointment?
}

// Compare to Class which HAS these fields:
model Class {
  schedulingPeriodStartsAt DateTime?  // ✅ Has time fields
  schedulingPeriodEndsAt   DateTime?  // ✅ Has time fields
}
```

### Impact

| Impact               | Description                                         |
| -------------------- | --------------------------------------------------- |
| **Wrong Slot Times** | First booking has start/end = checkout timestamp    |
| **Calendar Issues**  | Webinar appears at wrong time in user calendar      |
| **Notifications**    | Reminders sent for incorrect times                  |
| **Analytics**        | Duration calculations will be wrong (0 or negative) |

### Root Cause

The Webinar model was designed assuming an appointment with slots would be created BEFORE users book. But the checkout flow creates the appointment on first booking, with no scheduled time to reference.

### Fix

**Option A: Add scheduled time fields to Webinar model (Recommended)**

```prisma
model Webinar {
  id                       String        @id @default(cuid())
  scheduledStartAt         DateTime      @db.Timestamptz()  // NEW
  scheduledEndAt           DateTime      @db.Timestamptz()  // NEW
  status                   WebinarStatus @default(SCHEDULED)
  // ...
}
```

```typescript
// In checkout.ts
await tx.slotOfAppointment.create({
  data: {
    startsAt: webinar.scheduledStartAt, // Use webinar's scheduled time
    endsAt: webinar.scheduledEndAt,
    // ...
  },
});
```

**Option B: Require webinar appointment creation before bookings**

Consultants must create the webinar with scheduled time before users can book.

### Testing Checklist

- [ ] First webinar booking uses correct scheduled time
- [ ] Subsequent bookings use same time as first
- [ ] Calendar invites show correct time
- [ ] Migration updates existing webinars with placeholder times

---

## Issue #6: Mock Payment Status Never Updated

### Situation

Mock payments (used in development) create payment records with `PENDING` status. Unlike real payments, no webhook is called to update the status to `SUCCEEDED`, leaving mock payments in PENDING state forever.

**Code Location**: `lib/payments/operations/checkout.ts:1214`

### How It Happens

**Real Payment Flow**:

```
1. Checkout creates payment with status = PENDING
2. User pays via Stripe/Razorpay
3. Webhook calls handlePaymentSuccess()
4. Status updated to SUCCEEDED
```

**Mock Payment Flow**:

```
1. Checkout creates payment with status = PENDING
2. Mock payment intent returns immediately with status = "succeeded"
3. NO webhook is called ❌
4. Database status stays PENDING forever ❌
```

```typescript
// checkout.ts:1207-1221
await tx.payment.create({
  data: {
    // ...
    paymentStatus: PaymentStatus.PENDING, // Same for mock AND real payments
    isMockPayment,
    // ...
  },
});
// No code to update status for mock payments!
```

### Impact

| Impact                 | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| **Data Inconsistency** | Appointment confirmed but payment shows PENDING        |
| **Cleanup Job Issues** | May try to clean up "abandoned" mock payments          |
| **Reporting**          | Revenue reports don't count mock payments              |
| **Testing Confusion**  | Developers see PENDING status, think something's wrong |

### Root Cause

The mock payment system was designed to skip the payment gateway, but forgot to also skip the webhook step that updates payment status.

### Fix

```typescript
// In checkout.ts, after creating payment for mock flow
if (isMockPayment) {
  // Update payment status directly for mock payments
  await tx.payment.update({
    where: { paymentIntent: paymentResponse.id },
    data: { paymentStatus: PaymentStatus.SUCCEEDED },
  });
}
```

**Alternative**: Call `handlePaymentSuccess` for mock payments after checkout:

```typescript
if (isMockPayment) {
  await handlePaymentSuccess(
    paymentResponse.id,
    buildPaymentMetadata(validatedData, userId),
  );
}
```

### Testing Checklist

- [ ] Mock payment has SUCCEEDED status after checkout
- [ ] Mock payment not picked up by cleanup job
- [ ] Email notification sent for mock payments (if desired)

---

## Issue #7: Approval Flow Missing Duplicate Payment Prevention

### Situation

The `createApprovalPaymentIntent` function in the approval flow doesn't check for existing payments before creating a new payment link. A `checkExistingPayment` function exists but is never called.

**Code Location**: `lib/payments/operations/approval-payment.ts:55-103`

### How It Happens

```typescript
// approval-payment.ts:55-103
export async function createApprovalPaymentIntent(
  params: CreateApprovalPaymentParams,
): Promise<ApprovalPaymentResult> {
  // Validate params...

  // ❌ NO check for existing payment!
  // checkExistingPayment() function exists (line 214) but is never called

  const paymentResponse = await createPaymentIntent({...});
  await prisma.payment.create({...});  // Creates new payment every time

  return {...};
}

// This function exists but is NEVER USED:
export async function checkExistingPayment(params: {...}): Promise<boolean> {
  // Checks for existing PENDING or SUCCEEDED payments
}
```

**Scenario**:

1. Consultant clicks "Approve" on consultation
2. System creates Payment A with payment link
3. Consultant clicks "Approve" again (double-click, page reload, etc.)
4. System creates Payment B with different payment link
5. User receives two payment links
6. If user pays both, they're charged twice!

### Impact

| Impact                | Description                                         |
| --------------------- | --------------------------------------------------- |
| **Double Charges**    | User could pay twice if they receive multiple links |
| **Orphaned Payments** | One payment succeeds, others become orphaned        |
| **User Confusion**    | Multiple payment emails for same consultation       |

### Root Cause

The `checkExistingPayment` function was written but never integrated into `createApprovalPaymentIntent`.

### Fix

```typescript
export async function createApprovalPaymentIntent(
  params: CreateApprovalPaymentParams,
): Promise<ApprovalPaymentResult> {
  // Check for existing payment first
  const hasExistingPayment = await checkExistingPayment({
    consultationId: params.consultationId,
    subscriptionId: params.subscriptionId,
  });

  if (hasExistingPayment) {
    throw new Error(
      "A payment link has already been generated for this request",
    );
  }

  // Rest of function...
}
```

### Testing Checklist

- [ ] Double-clicking "Approve" doesn't create duplicate payments
- [ ] Page refresh after approval doesn't create duplicate
- [ ] Error message shown when duplicate attempted

---

## Issue #8: Payment Failure Handler Lacks Idempotency Check

### Situation

The `handlePaymentFailure` function doesn't check if a payment has already been marked as failed before processing. While mostly harmless, this could cause duplicate cleanup attempts.

**Code Location**: `lib/payments/webhooks/handlers.ts:241-303`

### How It Happens

```typescript
// handlers.ts:241-303
export async function handlePaymentFailure(paymentIntentId: string) {
  return await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({...});

    if (!payment) {
      console.warn(`Payment record not found...`);
      return;  // Early return for missing payment
    }

    // ❌ NO check for already-failed payment!
    // Unlike handlePaymentSuccess which checks:
    // if (payment.paymentStatus === PaymentStatus.SUCCEEDED) return;

    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.FAILED },  // Updates even if already FAILED
    });

    if (payment.appointment) {
      await cleanupFailedPaymentAppointment(tx, payment.appointment.id);  // Cleanup runs again
    }
  });
}
```

**Comparison with Success Handler**:

```typescript
// handlers.ts:106-108 - Success handler HAS idempotency check
if (payment.paymentStatus === PaymentStatus.SUCCEEDED) {
  console.log(`Payment ${paymentIntentId} has already been processed.`);
  return; // ✅ Early return
}
```

### Impact

| Impact          | Description                                         |
| --------------- | --------------------------------------------------- |
| **Minor**       | Duplicate cleanup attempts (mostly no-op)           |
| **Logs**        | Unnecessary log entries for already-failed payments |
| **Performance** | Extra database queries on duplicate webhooks        |

### Root Cause

Oversight - success handler was given idempotency check but failure handler wasn't.

### Fix

```typescript
export async function handlePaymentFailure(paymentIntentId: string) {
  return await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({...});

    if (!payment) {
      console.warn(`Payment record not found...`);
      return;
    }

    // ADD: Idempotency check
    if (payment.paymentStatus === PaymentStatus.FAILED) {
      console.log(`Payment ${paymentIntentId} has already been marked as failed.`);
      return;
    }

    // Rest of function...
  });
}
```

### Testing Checklist

- [ ] Duplicate failure webhooks don't cause errors
- [ ] Second failure webhook logs "already failed" message
- [ ] No duplicate cleanup operations

---

## Verification Queries

### Find Orphaned Subscriptions (Issue #2)

```sql
SELECT s.id, s.request_status, s.created_at, p.id as payment_id
FROM "Subscription" s
LEFT JOIN "Appointment" a ON a.subscription_id = s.id
LEFT JOIN "Payment" p ON p.appointment_id = a.id
WHERE s.request_status = 'PENDING'
AND s.created_at < NOW() - INTERVAL '1 hour'
AND p.id IS NULL;
```

### Find Partially Confirmed Class Enrollments (Issue #3)

```sql
SELECT c.id as class_id, u.id as user_id, u.email,
  COUNT(*) as total_slots,
  SUM(CASE WHEN s.is_tentative = false THEN 1 ELSE 0 END) as confirmed_slots
FROM "Class" c
JOIN "Appointment" a ON a.class_id = c.id
JOIN "SlotOfAppointment" s ON s.appointment_id = a.id
JOIN "_SlotOfAppointmentToUser" su ON su."A" = s.id
JOIN "User" u ON u.id = su."B"
GROUP BY c.id, u.id, u.email
HAVING COUNT(*) > SUM(CASE WHEN s.is_tentative = false THEN 1 ELSE 0 END)
AND SUM(CASE WHEN s.is_tentative = false THEN 1 ELSE 0 END) > 0;
```

### Find Unpaid Confirmed Webinar Slots (Issue #1)

```sql
SELECT w.id as webinar_id, s.id as slot_id, u.email,
  p.payment_status, s.is_tentative
FROM "Webinar" w
JOIN "Appointment" a ON a.webinar_id = w.id
JOIN "SlotOfAppointment" s ON s.appointment_id = a.id
JOIN "_SlotOfAppointmentToUser" su ON su."A" = s.id
JOIN "User" u ON u.id = su."B"
LEFT JOIN "Payment" p ON p.user_id = u.id AND p.appointment_id = a.id
WHERE s.is_tentative = false
AND (p.payment_status IS NULL OR p.payment_status != 'SUCCEEDED');
```

### Find Webinars with Wrong Slot Times (Issue #5)

```sql
-- Find slots where start time is suspiciously close to creation time (likely defaulted to new Date())
SELECT w.id as webinar_id, s.id as slot_id,
  s.starts_at, s.ends_at, s.created_at,
  EXTRACT(EPOCH FROM (s.starts_at - s.created_at)) as seconds_diff
FROM "Webinar" w
JOIN "Appointment" a ON a.webinar_id = w.id
JOIN "SlotOfAppointment" s ON s.appointment_id = a.id
WHERE ABS(EXTRACT(EPOCH FROM (s.starts_at - s.created_at))) < 60;  -- Within 60 seconds
```

### Find Mock Payments Still Pending (Issue #6)

```sql
SELECT p.id, p.payment_intent, p.payment_status, p.is_mock_payment,
  p.created_at, a.id as appointment_id
FROM "Payment" p
LEFT JOIN "Appointment" a ON a.id = p.appointment_id
WHERE p.is_mock_payment = true
AND p.payment_status = 'PENDING';
```

### Find Duplicate Approval Payments (Issue #7)

```sql
-- Consultations with multiple pending/succeeded payments
SELECT c.id as consultation_id, COUNT(p.id) as payment_count,
  array_agg(p.payment_status) as statuses
FROM "Consultation" c
JOIN "Appointment" a ON a.consultation_id = c.id
JOIN "Payment" p ON p.appointment_id = a.id
WHERE p.payment_status IN ('PENDING', 'SUCCEEDED')
GROUP BY c.id
HAVING COUNT(p.id) > 1;
```

---

## References

- **Related PR**: fix/payment-algorithm-2b (merged)
- **Documentation**: docs/payments/checkout-flow/KNOWN_ISSUES_AND_FIXES.md
- **Locking Docs**: docs/upstash/redis/locking/

---

_Created by: Payment Workflow Validation_
_Last Updated: 2025-12-06_
