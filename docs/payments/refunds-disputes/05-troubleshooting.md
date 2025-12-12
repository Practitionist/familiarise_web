# Troubleshooting Guide

## Refund Issues

### 1. Stuck PENDING Refunds

**Symptom**: Refund record shows PENDING status for more than 5 minutes

**Possible Causes**:

- Gateway API call failed but error handling didn't update status
- Server crashed between Phase 2 and Phase 3
- Network timeout during gateway call

**Diagnostic Steps**:

```sql
-- Find stuck PENDING refunds
SELECT
  id,
  "refundId",
  amount,
  "paymentId",
  "createdAt",
  metadata
FROM "Refund"
WHERE status = 'PENDING'
  AND "createdAt" < NOW() - INTERVAL '5 minutes';
```

**Resolution**:

1. Check gateway dashboard for actual refund status
2. If refund succeeded at gateway:
   ```sql
   UPDATE "Refund"
   SET status = 'SUCCEEDED',
       "refundId" = 'actual_gateway_refund_id',
       "updatedAt" = NOW()
   WHERE id = 'stuck_refund_id';
   ```
3. If refund failed at gateway:
   ```sql
   UPDATE "Refund"
   SET status = 'FAILED',
       metadata = '{"error": "Manual reconciliation - gateway call failed"}',
       "updatedAt" = NOW()
   WHERE id = 'stuck_refund_id';
   ```

---

### 2. "Refund amount exceeds available balance" Error

**Symptom**: Refund request fails even though payment seems fully available

**Possible Causes**:

- Another PENDING refund is claiming the balance
- Previously successful refunds not visible in UI

**Diagnostic Steps**:

```sql
-- Check all refunds for a payment
SELECT
  id,
  status,
  amount,
  "createdAt"
FROM "Refund"
WHERE "paymentId" = 'payment_id_here'
ORDER BY "createdAt" DESC;

-- Calculate available balance
SELECT
  p.amount as payment_amount,
  COALESCE(SUM(r.amount) FILTER (WHERE r.status IN ('SUCCEEDED', 'PENDING')), 0) as claimed_amount,
  p.amount - COALESCE(SUM(r.amount) FILTER (WHERE r.status IN ('SUCCEEDED', 'PENDING')), 0) as available
FROM "Payment" p
LEFT JOIN "Refund" r ON r."paymentId" = p.id
WHERE p.id = 'payment_id_here'
GROUP BY p.id, p.amount;
```

**Resolution**:

1. If PENDING refund is stuck, resolve it first (see above)
2. Request smaller refund amount if partial refunds already exist

---

### 3. Double Refund Occurred

**Symptom**: Customer received refund twice for same payment

**Investigation**:

```sql
-- Check for duplicate refunds
SELECT
  "paymentId",
  COUNT(*) as refund_count,
  SUM(amount) as total_refunded,
  array_agg(status) as statuses
FROM "Refund"
WHERE status = 'SUCCEEDED'
GROUP BY "paymentId"
HAVING COUNT(*) > 1;

-- Check timing of refunds
SELECT
  r.id,
  r."refundId",
  r.amount,
  r.status,
  r."createdAt",
  r.metadata
FROM "Refund" r
WHERE r."paymentId" = 'payment_id_here'
ORDER BY r."createdAt";
```

**Root Cause Analysis**:

- If refunds have different `refundId` from gateway: Likely a bug in two-phase pattern or gateway processed twice
- If same `refundId`: Duplicate database records (shouldn't happen with unique constraint)

**Prevention**: The two-phase pattern should prevent this. If it occurred, review the code path.

---

### 4. Gateway Timeout Errors

**Symptom**: Refund fails with timeout error

**Possible Causes**:

- Stripe/Razorpay API experiencing issues
- Network connectivity problems
- Request payload too large

**Resolution**:

1. Check gateway status:
   - Stripe: https://status.stripe.com
   - Razorpay: https://status.razorpay.com

2. Retry after a few minutes

3. If persistent, check application logs:
   ```bash
   grep "Refund creation error" /var/log/application.log | tail -20
   ```

---

## Dispute Issues

### 5. "Only Stripe supports direct evidence submission" Error

**Symptom**: Cannot submit evidence for Razorpay dispute

**Explanation**: Razorpay does not provide an API for evidence submission. Evidence must be submitted through their dashboard.

**Resolution**:

1. Log in to Razorpay Dashboard
2. Navigate to Disputes section
3. Find the dispute by ID
4. Submit evidence through their interface

---

### 6. Dispute Evidence Submission Failed

**Symptom**: Stripe returns error when submitting evidence

**Possible Causes**:

- Invalid file URLs in evidence
- Dispute already resolved
- Evidence deadline passed

**Diagnostic Steps**:

1. Check dispute status:

   ```sql
   SELECT
     id,
     "disputeId",
     status,
     "dueBy",
     evidence
   FROM "Dispute"
   WHERE id = 'dispute_id_here';
   ```

2. Verify deadline hasn't passed:

   ```sql
   SELECT
     id,
     "dueBy",
     NOW() > "dueBy" as deadline_passed
   FROM "Dispute"
   WHERE id = 'dispute_id_here';
   ```

3. Check Stripe Dashboard for detailed error

**Resolution**:

- If deadline passed: Dispute is automatically lost
- If status is terminal (WON/LOST): Cannot submit more evidence
- If file URL invalid: Re-upload file and get valid URL

---

### 7. Missed Dispute Deadline

**Symptom**: Dispute auto-resolved as LOST

**Prevention**: Set up monitoring for urgent disputes:

```sql
-- Disputes due within 3 days
SELECT
  id,
  "disputeId",
  status,
  "dueBy",
  "dueBy" - NOW() as time_remaining
FROM "Dispute"
WHERE status IN ('WARNING_NEEDS_RESPONSE', 'NEEDS_RESPONSE')
  AND "dueBy" BETWEEN NOW() AND NOW() + INTERVAL '3 days'
ORDER BY "dueBy";
```

**Recommended Alert**: Configure alerting when `urgentDisputes > 0` from admin API response.

---

### 8. Dispute Webhook Not Creating Record

**Symptom**: Dispute exists in Stripe but not in database

**Possible Causes**:

- Webhook endpoint not configured
- Webhook signature verification failing
- Database error during creation

**Diagnostic Steps**:

1. Check Stripe webhook logs:
   - Dashboard → Developers → Webhooks → Recent events

2. Verify webhook configuration:

   ```bash
   # Check webhook secret is set
   echo $STRIPE_WEBHOOK_SECRET
   ```

3. Check application logs:
   ```bash
   grep "dispute" /var/log/application.log | tail -50
   ```

**Manual Recovery**:

```typescript
// Create dispute record manually if needed
await prisma.dispute.create({
  data: {
    disputeId: "dp_xxx",
    amount: 10000,
    currency: "USD",
    reason: "fraudulent",
    status: "NEEDS_RESPONSE",
    dueBy: new Date("2025-12-20"),
    isChargeRefundable: true,
    paymentGateway: "STRIPE",
    paymentId: "clx_payment_id",
  },
});
```

---

## Database Queries for Monitoring

### Refund Health Check

```sql
-- Refund summary by status
SELECT
  status,
  COUNT(*) as count,
  SUM(amount) as total_amount
FROM "Refund"
WHERE "createdAt" > NOW() - INTERVAL '30 days'
GROUP BY status;

-- Recent refund failures
SELECT
  id,
  "paymentId",
  amount,
  metadata,
  "createdAt"
FROM "Refund"
WHERE status = 'FAILED'
  AND "createdAt" > NOW() - INTERVAL '7 days'
ORDER BY "createdAt" DESC;
```

### Dispute Health Check

```sql
-- Active disputes requiring attention
SELECT
  id,
  "disputeId",
  status,
  amount,
  "dueBy",
  "dueBy" - NOW() as time_remaining
FROM "Dispute"
WHERE status IN ('WARNING_NEEDS_RESPONSE', 'NEEDS_RESPONSE', 'UNDER_REVIEW')
ORDER BY "dueBy" NULLS LAST;

-- Dispute outcomes (last 90 days)
SELECT
  status,
  COUNT(*) as count,
  SUM(amount) as total_amount
FROM "Dispute"
WHERE status IN ('WON', 'LOST', 'CHARGE_REFUNDED')
  AND "updatedAt" > NOW() - INTERVAL '90 days'
GROUP BY status;
```

---

## Emergency Procedures

### Refund System Down

1. **Disable refund UI** if possible
2. **Check gateway status pages**
3. **Review recent deployments** for breaking changes
4. **Check database connectivity**
5. **Escalate to on-call engineer**

### Dispute Deadline Emergency

If a dispute deadline is imminent (< 24 hours):

1. **Gather all available evidence immediately**
2. **Submit via Stripe Dashboard directly** (faster than API for emergencies)
3. **Document the response** in your system manually
4. **Set reminder** to verify status next day

---

## Contact Information

- **Stripe Support**: https://support.stripe.com
- **Razorpay Support**: https://razorpay.com/support
- **Internal Engineering**: #engineering channel or oncall@company.com
