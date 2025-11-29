# Payment System Comprehensive Test Report

**Date:** November 6, 2025
**Test Environment:** Local Development (http://localhost:3000)
**Database:** Supabase (pzmbxqdgibfkhjwzeprf)

---

## Test Environment Setup

### Database State (Pre-Test)

```
Users: 100
Consultation Plans: 120
Subscription Plans: 120
Webinar Plans: 120
Class Plans: 120
Weekly Availability Slots: 345
Existing Payments: 100
```

### Server Status

- ✅ Next.js Dev Server Running (Port 3000)
- ✅ Stripe Integration Configured
- ✅ Razorpay Integration Configured
- ⚠️ Warning: Using HTTP (Stripe recommends HTTPS for production)

---

## Phase 1: Consultation Checkout Testing

### Test 1.1: Consultation Checkout Page Access

**URL:** `/checkout/plans/consultation/cmhn3g1c9008cmfimzqkk0h12`

**Result:** ❌ FAILED
**Error:** Validation failed: Required, Required
**Console Error:** Error fetching event data

**Analysis:**

- Page loaded successfully (HTTP 200)
- Client-side validation error occurred
- Likely causes:
  1. User not authenticated
  2. Missing availability slots for consultation
  3. Form fields not properly initialized

**Recommendation:**

- Verify authentication flow before checkout
- Ensure consultation plans have associated availability slots
- Check if consulteeProfile exists for test user

---

---

## Database Analysis

### Existing Payment Data

```
Total Payments: 100
Sample Payment Records:
- Payment ID: ccb20e47-cb40-4897-afc4-f5bd2edae4d0
  Amount: €22.98
  Status: FAILED
  Gateway: LEMON_SQUEEZY

- Payment ID: 11ba8f0a-9bfa-44a7-8336-6b09eed384ad
  Amount: $335.21
  Status: SUCCEEDED
  Gateway: STRIPE

- Payment ID: 977f8069-757b-450b-accb-fcc9c0296528
  Amount: $94.61
  Status: PENDING
  Gateway: XFLOW
```

### Payment Status Distribution

Query:

```sql
SELECT
  "paymentStatus",
  "paymentGateway",
  COUNT(*) as count
FROM "Payment"
GROUP BY "paymentStatus", "paymentGateway";
```

### Admin User Created

- User ID: admin_test_user_001
- Email: admin@familiarise.test
- Role: ADMIN
- Status: ✅ Created Successfully

---

## Issues Identified

### Issue 1: Authentication Required

**Severity:** HIGH
**Description:** Cannot test checkout flows without authenticated user session
**Impact:** All checkout pages require authentication
**Workaround:** Manual testing required with proper authentication

### Issue 2: Consultation Validation Error

**Severity:** MEDIUM
**Description:** "Validation failed: Required, Required" error on consultation checkout
**Potential Causes:**

1. Missing availability slots
2. Form fields not initialized
3. Client-side validation failing before data load

**Console Error:** `Error fetching event data`

### Issue 3: HTTP Warning

**Severity:** LOW
**Description:** Stripe.js requires HTTPS for production
**Current:** Using HTTP (localhost)
**Recommendation:** Use HTTPS for production deployment

---

## Phase 2: Manual Testing Guide

### Prerequisites

1. ✅ Server running on http://localhost:3000
2. ✅ Database seeded with test data
3. ✅ Admin user created (admin@familiarise.test)
4. ⚠️ User authentication required

### Test Suite 1: Admin Dashboard

#### Test 1.1: Admin Home Page

**URL:** `/dashboard/admin/home`
**Steps:**

1. Login as admin user (admin@familiarise.test)
2. Navigate to admin dashboard home
3. Verify statistics display:
   - Total Payments count
   - Pending Payments count
   - Total Refunds count
   - Active Disputes count
   - Gateway breakdown (Stripe, Razorpay, etc.)

**Expected Results:**

- Stats cards show correct counts
- Recent payments list displays (max 5)
- Recent refunds list displays (max 5)
- Gateway status indicators show active/inactive

**Database Verification:**

```sql
-- Total payments
SELECT COUNT(*) FROM "Payment";
-- Expected: 100

-- Pending payments
SELECT COUNT(*) FROM "Payment" WHERE "paymentStatus" = 'PENDING';

-- Gateway breakdown
SELECT "paymentGateway", COUNT(*)
FROM "Payment"
GROUP BY "paymentGateway";
```

#### Test 1.2: Payments List Page

**URL:** `/dashboard/admin/payments`
**Steps:**

1. Navigate to payments list
2. Test pagination (20 per page)
3. Test filters:
   - Status filter (PENDING, SUCCEEDED, FAILED)
   - Gateway filter (STRIPE, RAZORPAY, LEMON_SQUEEZY, XFLOW)
   - Appointment type filter
   - Search by payment ID
4. Verify table displays:
   - Payment Intent ID
   - Amount and currency
   - Status badge
   - Gateway
   - Mock payment indicator
   - Date

**Expected Results:**

- All 100 payments loadable via pagination
- Filters work correctly
- Search finds exact matches
- Mock payment badge shows for isMockPayment=true

**Test Data Query:**

```sql
-- Get payment for search test
SELECT "paymentIntent", id
FROM "Payment"
WHERE "paymentStatus" = 'SUCCEEDED'
LIMIT 1;
```

#### Test 1.3: Payment Details Page

**URL:** `/dashboard/admin/payments/[paymentId]`
**Test Payment ID:** `11ba8f0a-9bfa-44a7-8336-6b09eed384ad`

**Steps:**

1. Click "View" on a succeeded payment
2. Verify details display:
   - Payment Intent ID
   - Amount and currency
   - Status
   - Gateway
   - Mock payment indicator
   - Created date
3. Check "Issue Refund" button availability (only for SUCCEEDED)
4. Test refund functionality:
   - Click "Issue Refund"
   - Leave amount empty for full refund
   - Submit
   - Verify refund record created

**Expected Results:**

- All payment details accurate
- Refund button only shows for succeeded payments
- Refund creates record in database
- Page updates to show refund in list

**Database Verification:**

```sql
-- Verify refund created
SELECT * FROM "Refund"
WHERE "paymentId" = '11ba8f0a-9bfa-44a7-8336-6b09eed384ad'
ORDER BY "createdAt" DESC;
```

#### Test 1.4: Refunds List Page

**URL:** `/dashboard/admin/refunds`

**Steps:**

1. Navigate to refunds page
2. Test filters (status, gateway, search)
3. Verify table columns
4. Click "View Payment" link
5. Verify navigation to original payment

**Expected Results:**

- Refunds display with correct status
- Link to payment works
- Filters function correctly

#### Test 1.5: Disputes List Page

**URL:** `/dashboard/admin/disputes`

**Steps:**

1. Navigate to disputes page
2. Check for urgency alerts (due within 3 days)
3. Test filters (status, gateway)
4. Verify dispute details display
5. Check "View" link

**Expected Results:**

- Urgent disputes highlighted in red
- Status badges color-coded
- Due date显示 formatted

---

### Test Suite 2: Consultation Checkout

#### Prerequisites

- Login as consultee user
- Consultation plan: cmhn3g1c9008cmfimzqkk0h12
- Ensure availability slots exist

#### Test 2.1: Stripe Real Payment

**URL:** `/checkout/plans/consultation/cmhn3g1c9008cmfimzqkk0h12`

**Steps:**

1. Select time slot
2. Fill any required fields
3. Click "Pay with Stripe" button
4. Verify network request:
   - POST to `/api/checkout`
   - Payload includes: planId, appointmentType, paymentGateway=STRIPE
5. Check response:
   - paymentIntent object
   - client_secret
   - amount and currency
6. Monitor payment record:
   ```sql
   SELECT * FROM "Payment"
   WHERE "userId" = '[your-user-id]'
   ORDER BY "createdAt" DESC LIMIT 1;
   ```
7. Complete Stripe checkout
8. Verify webhook processing:

   ```sql
   -- Check payment updated to SUCCEEDED
   SELECT "paymentStatus", "appointmentId"
   FROM "Payment"
   WHERE id = '[payment-id]';

   -- Check appointment created
   SELECT * FROM "Appointment" WHERE id = '[appointment-id]';

   -- Check consultation created
   SELECT * FROM "Consultation"
   WHERE "requestStatus" = 'APPROVED';
   ```

**Expected Results:**

- ✅ Payment intent created with status PENDING
- ✅ Redirect to Stripe checkout
- ✅ Webhook processes success
- ✅ Payment status → SUCCEEDED
- ✅ Appointment created
- ✅ Consultation status → APPROVED

**Network Monitoring:**

```javascript
// Check request payload
{
  "planId": "cmhn3g1c9008cmfimzqkk0h12",
  "appointmentType": "CONSULTATION",
  "paymentGateway": "STRIPE",
  "slotStartTimeInUTC": "2025-11-06T10:00:00.000Z",
  "slotEndTimeInUTC": "2025-11-06T11:00:00.000Z",
  "slotOfAvailabilityWeeklyId": "..."
}
```

#### Test 2.2: Stripe Mock Payment

**URL:** Same as above

**Steps:**

1. Fill form
2. Click "Mock Pay (Stripe)" button
3. Verify immediate response (no redirect)
4. Check payment record:
   ```sql
   SELECT
     "paymentIntent",
     "paymentStatus",
     "isMockPayment",
     "appointmentId"
   FROM "Payment"
   WHERE "userId" = '[your-user-id]'
   ORDER BY "createdAt" DESC LIMIT 1;
   ```
5. Verify appointment created immediately
6. Check payment intent format: should contain `_mock_`

**Expected Results:**

- ✅ Payment intent format: `cs_mock_...`
- ✅ Payment status immediately SUCCEEDED
- ✅ isMockPayment = true
- ✅ Appointment created synchronously (no webhook needed)
- ✅ Consultation approved immediately

#### Test 2.3: Razorpay Real Payment

**Steps:**

1. Same as Stripe but click "Pay with Razorpay"
2. Verify payment intent format: `order_...`
3. Complete Razorpay checkout
4. Verify webhook processing

**Expected Results:**

- Payment intent: `order_[random]`
- Razorpay checkout modal opens
- Webhook processes payment.captured event

#### Test 2.4: Razorpay Mock Payment

**Steps:**

1. Click "Mock Pay (Razorpay)"
2. Verify immediate success
3. Check payment intent: `order_mock_...`

---

### Test Suite 3: Subscription Checkout

**URL:** `/checkout/plans/subscription/[planId]`

**Additional Fields Required:**

- schedulingPeriodStartsAt
- schedulingPeriodEndsAt

**Test Variants:**

- 3.1: Stripe Real
- 3.2: Stripe Mock
- 3.3: Razorpay Real
- 3.4: Razorpay Mock

**Unique Verifications:**

```sql
-- Check subscription created
SELECT
  id,
  "schedulingPeriodStartsAt",
  "schedulingPeriodEndsAt",
  "requestStatus"
FROM "Subscription"
WHERE id = '[subscription-id]';

-- Verify duration calculation
SELECT
  "durationInMonths",
  "subscriptionPlanId"
FROM "Subscription";
```

---

### Test Suite 4: Webinar Checkout

**URL:** `/checkout/plans/webinar/[webinarPlanId]`

**Additional Field Required:**

- eventId (webinar instance ID)

**Test Cases:**

- 4.1: Normal enrollment (capacity available)
- 4.2: Full capacity (should add to waitlist)
- 4.3: Verify participant count increments

**Database Queries:**

```sql
-- Get webinar instance
SELECT
  w.id,
  wp.title,
  wp."maxParticipants",
  (SELECT COUNT(*) FROM "SlotOfAppointment" soa
   JOIN "Appointment" a ON soa."appointmentId" = a.id
   WHERE a."webinarId" = w.id) as current_participants
FROM "Webinar" w
JOIN "WebinarPlan" wp ON w."webinarPlanId" = wp.id
LIMIT 1;

-- After payment, verify participant added
SELECT * FROM "SlotOfAppointment" soa
JOIN "Appointment" a ON soa."appointmentId" = a.id
WHERE a."webinarId" = '[webinar-id]';
```

---

### Test Suite 5: Class Checkout

**URL:** `/checkout/plans/class/[classPlanId]`

**Similar to webinar but:**

- Separate appointment per participant
- Check class status updates

---

### Test Suite 6: Refund Operations

#### Test 6.1: Full Refund via API

**API:** `POST /api/payments/refunds`

**Payload:**

```json
{
  "paymentId": "11ba8f0a-9bfa-44a7-8336-6b09eed384ad"
}
```

**Expected:**

- Refund record created
- Amount = full payment amount
- Status = PENDING (then SUCCEEDED via webhook)

#### Test 6.2: Partial Refund

**Payload:**

```json
{
  "paymentId": "11ba8f0a-9bfa-44a7-8336-6b09eed384ad",
  "amount": 167.6,
  "reason": "Partial refund for cancellation"
}
```

**Verify:**

```sql
SELECT
  amount,
  reason,
  status
FROM "Refund"
WHERE "paymentId" = '11ba8f0a-9bfa-44a7-8336-6b09eed384ad';
```

#### Test 6.3: Over-Refund Prevention

**Test:**

1. Issue partial refund of 200
2. Try to issue another refund of 200
3. Should fail with "exceeds payment amount" error

---

### Test Suite 7: Dispute Operations

#### Test 7.1: View Disputes

**API:** `GET /api/payments/disputes`

**Expected:**

- List all disputes
- Filter by status
- Show due dates

#### Test 7.2: Submit Evidence (Stripe Only)

**API:** `POST /api/payments/disputes`

**Payload:**

```json
{
  "disputeId": "dp_...",
  "evidence": {
    "customerName": "John Doe",
    "customerEmailAddress": "john@example.com",
    "productDescription": "Consultation session",
    "cancellationPolicy": "Full refund within 24 hours",
    "cancellationRebuttal": "Service was delivered as agreed"
  }
}
```

**Verify:**

```sql
SELECT evidence FROM "Dispute" WHERE "disputeId" = 'dp_...';
```

---

## Network Request Monitoring

### Key Endpoints to Monitor

#### 1. Checkout API

- **URL:** `POST /api/checkout`
- **Monitor:** Request payload, response time, payment intent format
- **Success:** 200 with paymentIntent object
- **Failure:** 400/500 with error message

#### 2. Refunds API

- **URL:** `POST /api/payments/refunds`
- **Monitor:** Refund creation, gateway API calls
- **Success:** 200 with refund ID

#### 3. Webhooks

- **Stripe:** `POST /api/webhooks/stripe`
- **Razorpay:** `POST /api/webhooks/razorpay`
- **Monitor:** Signature verification, event processing

---

## Console Error Monitoring

### Expected Warnings (Safe to Ignore)

- `[next-auth][warn][DEBUG_ENABLED]` - Debug mode warning
- Stripe HTTPS warning in development

### Critical Errors to Watch

- Payment intent creation failures
- Webhook signature verification failures
- Database transaction errors
- Appointment creation failures

---

## Test Results Summary

### Completed Tests

- ✅ Database seeded successfully
- ✅ Server running and accessible
- ✅ Admin user created
- ✅ Payment data verified (100 records)

### Blocked Tests (Authentication Required)

- ⚠️ Consultation checkout flows
- ⚠️ Subscription checkout flows
- ⚠️ Webinar checkout flows
- ⚠️ Class checkout flows
- ⚠️ Admin dashboard UI testing

### Manual Testing Required

All checkout and admin dashboard tests require manual execution with proper user authentication.

---

## Recommendations

### Immediate Actions

1. **Fix Consultation Validation Error**
   - Debug "Required, Required" error
   - Check form initialization
   - Verify availability slots exist

2. **Implement Test Authentication**
   - Create test user credentials
   - Add authentication helper for testing
   - Consider e2e test framework (Playwright/Cypress)

3. **Add HTTPS for Production**
   - Configure SSL certificate
   - Update Stripe webhook URLs

### Future Enhancements

1. **Automated Testing**
   - E2E tests for all checkout flows
   - API integration tests
   - Webhook simulation tests

2. **Monitoring**
   - Add payment failure alerts
   - Track refund requests
   - Monitor dispute deadlines

3. **Documentation**
   - API documentation
   - Webhook event catalog
   - Error code reference

---

## Appendix: Useful SQL Queries

### Payment Analysis

```sql
-- Payment status distribution
SELECT "paymentStatus", COUNT(*)
FROM "Payment"
GROUP BY "paymentStatus";

-- Revenue by gateway
SELECT
  "paymentGateway",
  COUNT(*) as transactions,
  SUM(amount) as total_amount,
  AVG(amount) as avg_amount
FROM "Payment"
WHERE "paymentStatus" = 'SUCCEEDED'
GROUP BY "paymentGateway";

-- Mock vs Real payments
SELECT
  "isMockPayment",
  COUNT(*) as count,
  SUM(amount) as total
FROM "Payment"
GROUP BY "isMockPayment";
```

### Refund Analysis

```sql
-- Refund rate
SELECT
  COUNT(DISTINCT r."paymentId")::FLOAT / COUNT(DISTINCT p.id) * 100 as refund_rate_percent
FROM "Payment" p
LEFT JOIN "Refund" r ON p.id = r."paymentId";

-- Average refund time
SELECT
  AVG(EXTRACT(EPOCH FROM (r."createdAt" - p."createdAt"))/3600) as avg_hours_to_refund
FROM "Refund" r
JOIN "Payment" p ON r."paymentId" = p.id;
```

### Dispute Analysis

```sql
-- Dispute resolution rate
SELECT
  status,
  COUNT(*) as count,
  COUNT(*)::FLOAT / SUM(COUNT(*)) OVER () * 100 as percentage
FROM "Dispute"
GROUP BY status;

-- Urgent disputes
SELECT *
FROM "Dispute"
WHERE "dueBy" < NOW() + INTERVAL '3 days'
  AND status IN ('NEEDS_RESPONSE', 'WARNING_NEEDS_RESPONSE')
ORDER BY "dueBy" ASC;
```

---

**Test Report Generated:** November 6, 2025
**Status:** Partial - Manual testing required for complete coverage
**Next Steps:** Execute manual test suites with authenticated users
