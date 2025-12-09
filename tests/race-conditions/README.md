# Race Condition Fix - Testing Guide

## Overview

This directory contains tests to verify that the race condition fix for concurrent checkout prevents duplicate bookings.

## What Was Fixed

### The Problem (Before Fix)
1. User A clicks checkout → Validates slot (available ✓) → Creates payment with `appointmentId: null`
2. User B clicks checkout → Validates slot (available ✓) → Creates payment with `appointmentId: null`
3. Both payments created → Slot permanently blocked with duplicate pending payments

**Root Cause**: Validation checked `slotOfAppointment` table, but payments were invisible until webhook created appointments later.

### The Solution (After Fix)
1. User A acquires distributed lock → Re-validates → **Creates tentative appointment** → Creates payment linked to appointment
2. User B acquires distributed lock (waits) → Re-validates → **Sees tentative appointment** → Validation fails ✗
3. Only ONE payment + tentative appointment created
4. Webhook confirms appointment by setting `isTentative: false`

## Key Changes

### 1. Modified `handleCheckout()` (`/lib/payments/operations/checkout.ts`)
- Now creates tentative appointments INSIDE the distributed lock
- Payment is linked to appointment immediately (not null)
- Validation can see tentative bookings

### 2. Updated `handlePaymentSuccess()` (`/lib/payments/webhooks/handlers.ts`)
- **NEW FLOW**: If `appointmentId` exists → confirm it (set `isTentative: false`)
- **LEGACY FLOW**: If `appointmentId` is null → create appointment from metadata
- Backwards compatible with older payments

### 3. No Changes to Handlers
- `handleConsultationCheckout()`, `handleSubscriptionCheckout()`, etc. already support `isTentative` flag
- They use `skipPayment` parameter which maps to `!isTentative`

## Running Tests

### Prerequisites

1. Update test configuration with real database IDs:
   ```typescript
   const TEST_CONFIG = {
     PLAN_ID: "clx123...",              // Consultation plan ID
     CONSULTANT_PROFILE_ID: "clx456...", // Consultant profile ID
     USER_A_ID: "user_a_id",            // First test user
     USER_B_ID: "user_b_id",            // Second test user
     SLOT_START: "...",                 // Future slot start time
     SLOT_END: "...",                   // Future slot end time
   };
   ```

2. Ensure Redis is running (required for distributed locking):
   ```bash
   # Check if Redis is accessible
   curl -X GET "https://your-upstash-redis-url.upstash.io"
   ```

### Run the Test

```bash
# Run the concurrent checkout test
npx tsx tests/race-conditions/test-checkout-race-condition-fix.ts
```

### Expected Output

```
🧪 Starting Concurrent Checkout Race Condition Test

🧹 Cleaning up test data...

🚀 Simulating concurrent checkout by User A and User B...
Slot: 2025-12-01T10:00:00.000Z to 2025-12-01T11:00:00.000Z

📊 Checkout Results:
✅ User A: SUCCESS
   Payment Intent: pi_mock_abc123
❌ User B: FAILED
   Error: Time slot is already booked

Summary: 1 succeeded, 1 failed

🔍 Verifying Database State:
📋 Appointments found: 1
   [1] ID: apt_123
       Type: CONSULTATION
       Slots: 1
         - 2025-12-01T10:00:00.000Z to 2025-12-01T11:00:00.000Z
           Tentative: false

💳 Payments found: 1
   [1] Intent: pi_mock_abc123
       User: user_a_id
       Status: SUCCEEDED
       Appointment: apt_123

✅ Test Assertions:
1. ✅ PASS: Exactly ONE checkout should succeed (actual: 1)
2. ✅ PASS: Exactly ONE checkout should fail (actual: 1)
3. ✅ PASS: Exactly ONE appointment should exist (actual: 1)
4. ✅ PASS: Appointment slots should be confirmed (isTentative=false)
5. ✅ PASS: Exactly ONE payment should exist (actual: 1)
6. ✅ PASS: Payment status should be SUCCEEDED

🎉 ALL TESTS PASSED - Race condition fix is working correctly!
```

## Manual Testing

For manual testing with real users:

1. Open two browser windows (incognito mode for different users)
2. Navigate to the same consultation slot
3. Click "Book Now" simultaneously in both windows
4. Expected result:
   - One user: "Payment processing..."
   - Other user: "Time slot is already booked" or "Another user is currently booking this slot"

## Monitoring

Check logs for these events:

```json
// Lock acquisition
{"event": "lock_acquired", "key": "slot-booking:consultant_id:slot_time", "attempts": 1}

// Appointment creation
{"event": "checkout_appointment_created", "appointmentType": "CONSULTATION", "appointmentId": "apt_123", "isMockPayment": false}

// Webhook confirmation
{"event": "webhook_confirming_existing_appointment", "appointmentId": "apt_123"}
```

## Troubleshooting

### Test fails with "Lock acquisition timeout"
- **Cause**: Redis is down or unreachable
- **Fix**: Check Redis connection in `/lib/redis.ts`

### Both users succeed (race condition not fixed)
- **Cause**: Distributed locking not working or appointments not being created
- **Fix**: Check logs for lock acquisition failures

### Second user gets different error
- **Cause**: Validation error message may vary
- **Expected errors**:
  - "Time slot is already booked"
  - "Another user is currently booking this slot"
  - "Failed to acquire lock after N attempts"

## Database Cleanup

If tests fail and leave orphaned data:

```sql
-- Find orphaned tentative appointments
SELECT * FROM "SlotOfAppointment" WHERE "isTentative" = true;

-- Find pending payments older than 30 minutes
SELECT * FROM "Payment"
WHERE "paymentStatus" = 'PENDING'
  AND "createdAt" < NOW() - INTERVAL '30 minutes';

-- Run cleanup job manually
-- (Your cron job should handle this automatically)
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      CONCURRENT CHECKOUT FLOW                        │
└─────────────────────────────────────────────────────────────────────┘

User A                                        User B
  │                                             │
  ├─ calculateAmountAndValidate()              ├─ calculateAmountAndValidate()
  │  └─ Validates slot (available ✓)           │  └─ Validates slot (available ✓)
  │                                             │
  ├─ Acquire Lock (SUCCESS) ──┐                ├─ Acquire Lock (WAITING...)
  │                            │                │
  ├─ revalidateInsideLock()    │                │
  │  └─ Re-validates (available ✓)             │
  │                            │                │
  ├─ CREATE TENTATIVE APPOINTMENT ─────────────┼─ Tentative slot visible
  │  └─ isTentative: true      │                │
  │                            │                │
  ├─ CREATE PAYMENT            │                │
  │  └─ appointmentId: apt_123 │                │
  │                            │                │
  ├─ Release Lock ─────────────┘                ├─ Acquire Lock (SUCCESS)
  │                                             │
  │                                             ├─ revalidateInsideLock()
  │                                             │  └─ Sees tentative slot ✗
  │                                             │
  │                                             ├─ VALIDATION FAILS
  │                                             │  └─ Error: "Slot already booked"
  │                                             │
  ├─ Webhook: payment.succeeded                ├─ Release Lock
  │  └─ Confirm appointment                    │
  │     └─ isTentative: false                  └─ User sees error
  │
  └─ Appointment confirmed
```

## Success Criteria

✅ Only ONE payment record created for concurrent attempts
✅ Only ONE appointment record created
✅ Second user receives clear error message
✅ No orphaned payments with `appointmentId: null`
✅ Webhook confirms existing appointment (doesn't create new one)
✅ Distributed lock logs show sequential processing

## Related Files

- `/lib/payments/operations/checkout.ts` - Main checkout logic
- `/lib/payments/webhooks/handlers.ts` - Webhook confirmation
- `/utils/appointmentlock.ts` - Distributed locking
- `/app/api/checkout/route.ts` - API endpoint
