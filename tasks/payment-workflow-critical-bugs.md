# Payment Workflow Critical Bugs

**Date**: 2025-12-06
**Status**: Identified - Awaiting Fix
**Priority**: P0 (Critical)
**Affected Files**:
- `lib/payments/operations/checkout.ts`
- `lib/payments/webhooks/handlers.ts`

---

## Executive Summary

During a comprehensive validation of all payment workflows for the 4 appointment types (Consultation, Subscription, Webinar, Class), **3 critical bugs** and **1 high-priority issue** were identified. These bugs can result in:

- Users receiving paid services without paying
- Duplicate database records causing data corruption
- Partial service delivery (only 1 of N sessions accessible)
- Race conditions under high load

| # | Severity | Issue | Affected Types |
|---|----------|-------|----------------|
| 1 | 🔴 Critical | Wrong user's slots confirmed | Webinar, Class |
| 2 | 🔴 Critical | Duplicate subscription creation | Subscription |
| 3 | 🔴 Critical | Only first session confirmed | Class |
| 4 | 🟠 High | Lock TTL mismatch (30s vs 60s) | All types |

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
    where: { appointmentId },  // ⚠️ No user filter!
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

| Impact | Description |
|--------|-------------|
| **Revenue Loss** | Users access paid content without payment |
| **Capacity Issues** | Confirmed non-paying users consume available slots |
| **Audit Trail** | Payment records don't match slot confirmations |
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
  userId?: string,  // NEW: Optional user filter
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
createdAppointment = null;  // Line 1174
```

**Step 2: Payment record has no appointmentId**
```typescript
// checkout.ts:1217
await tx.payment.create({
  data: {
    // ...
    appointmentId: createdAppointment?.id || null,  // NULL for subscriptions!
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

| Impact | Description |
|--------|-------------|
| **Data Corruption** | Two subscription records for one purchase |
| **Orphaned Records** | Subscription A remains PENDING forever |
| **Reporting Errors** | Analytics show double the subscriptions |
| **User Confusion** | Dashboard may show duplicate entries |
| **Cleanup Complexity** | No automated way to identify orphans |

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
  appointment: firstAppointment,  // Only week 1!
  plan,
  amount: plan.price,
  slotsCreated: createdSlots.length
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
  where: { appointmentId },  // Only matches week 1
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

| Impact | Description |
|--------|-------------|
| **Partial Access** | User can only access 1 of 10 sessions |
| **Cleanup Job Deletes Paid Slots** | Weeks 2-10 slots deleted as "abandoned" |
| **Support Tickets** | Users report missing sessions |
| **Refund Requests** | Perceived as service not delivered |
| **Manual Fix Required** | Admin must manually confirm remaining slots |

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
return await lockSlotBooking(consultantUserId, data.slotStartTimeInUTC, 30000);  // 30s
return await lockEventCheckout(appointmentType, data.eventId, 30000);             // 30s

// appointmentlock.ts default is 60s
const DEFAULT_LOCK_TTL = 60000;  // 60 seconds
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

| Impact | Description |
|--------|-------------|
| **Race Conditions** | Lock expires during slow operations |
| **Double Bookings** | Two users book same slot |
| **Data Integrity** | Overlapping appointments |
| **Production Incidents** | Under high load, issue manifests |

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

| Priority | Issue | Effort | Risk if Unfixed |
|----------|-------|--------|-----------------|
| P0 | #1 Wrong user slots confirmed | Medium | Revenue loss, free access |
| P0 | #2 Duplicate subscriptions | Medium | Data corruption |
| P0 | #3 Class partial confirmation | Low | Service not delivered |
| P1 | #4 Lock TTL mismatch | Low | Race conditions |

### Recommended Implementation Order

1. **Issue #4** (5 min) - Quick fix, reduces risk for other fixes
2. **Issue #3** (30 min) - Simple fix with Option B
3. **Issue #1** (1 hour) - Requires careful testing with concurrent users
4. **Issue #2** (2 hours) - Requires schema change and migration

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
SELECT w.id as webinar_id, w.title, s.id as slot_id, u.email,
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

---

## References

- **Related PR**: fix/payment-algorithm-2b (merged)
- **Documentation**: docs/payments/checkout-flow/KNOWN_ISSUES_AND_FIXES.md
- **Locking Docs**: docs/upstash/redis/locking/

---

*Created by: Payment Workflow Validation*
*Last Updated: 2025-12-06*
