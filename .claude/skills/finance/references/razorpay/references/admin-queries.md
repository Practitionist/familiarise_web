# Admin Diagnostic Queries & Razorpay cURL Reference

Read-only SQL queries against this repository's Prisma/PostgreSQL schema (`prisma/schema.prisma`) and `curl` commands for inspecting Razorpay and RazorpayX entities.

---

## 1. PostgreSQL / Prisma Diagnostic Queries (Read-Only)

All money columns in Postgres are stored in **integer paise (`BigInt`)** (`amount`, `originalAmount`, `taxAmount`, `amountPaise`, `consultantSharePaise`, etc.). Divide by `100.0` for display in `₹`.

### 1.1 Recent Payments & Gateway Identifiers
```sql
SELECT
  id,
  "userId",
  "paymentStatus",
  "paymentGateway",
  "paymentIntent"     AS razorpay_order_id,
  "gatewayPaymentId"  AS razorpay_payment_id,
  amount / 100.0      AS gross_inr,
  "originalAmount" / 100.0 AS base_inr,
  "taxAmount" / 100.0 AS gst_inr,
  "createdAt"
FROM "Payment"
WHERE "paymentGateway" = 'RAZORPAY'
ORDER BY "createdAt" DESC
LIMIT 25;
```

### 1.2 Stuck or Deferred Razorpay Webhook Events
```sql
SELECT
  "eventId",
  "eventType",
  processed,
  "deferCount",
  error,
  "createdAt",
  "processedAt"
FROM "WebhookEvent"
WHERE provider = 'razorpay'
  AND (processed = false OR error IS NOT NULL)
ORDER BY "createdAt" DESC
LIMIT 50;
```

### 1.3 Pending / Placeholder / Uncascaded Refunds
```sql
SELECT
  r.id,
  r."refundId",
  r.status,
  r."amountPaise" / 100.0 AS refund_inr,
  r."cascadedAt",
  r."failureReason",
  p."paymentIntent"       AS razorpay_order_id,
  p."gatewayPaymentId"    AS razorpay_payment_id,
  r."createdAt",
  r."updatedAt"
FROM "Refund" r
JOIN "Payment" p ON p.id = r."paymentId"
WHERE r.status = 'PENDING'
   OR (r.status = 'SUCCEEDED' AND r."cascadedAt" IS NULL AND r."amountPaise" > 0)
ORDER BY r."updatedAt" ASC;
```

### 1.4 Active Disputes Approaching Response Deadline (`respond_by`)
```sql
SELECT
  d.id,
  d."disputeId",
  d.status,
  d."amountPaise" / 100.0 AS disputed_inr,
  d.reason,
  d."dueBy",
  ROUND(EXTRACT(EPOCH FROM (d."dueBy" - NOW())) / 3600.0, 1) AS hours_until_deadline,
  p."paymentIntent"       AS razorpay_order_id,
  p."gatewayPaymentId"    AS razorpay_payment_id
FROM "Dispute" d
LEFT JOIN "Payment" p ON p.id = d."paymentId"
WHERE d.status IN ('NEEDS_RESPONSE', 'WARNING_NEEDS_RESPONSE', 'UNDER_REVIEW', 'WARNING_UNDER_REVIEW')
ORDER BY d."dueBy" ASC NULLS LAST;
```

### 1.5 Consultant & Organization Payouts In Flight
```sql
SELECT
  'CONSULTANT'          AS payee_type,
  id,
  "consultantProfileId" AS payee_id,
  status,
  method,
  amount / 100.0        AS payout_inr,
  "providerPayoutId"    AS razorpayx_payout_id,
  "idempotencyKey",
  "failureReason",
  "createdAt",
  "updatedAt"
FROM "ConsultantPayout"
WHERE status IN ('PENDING', 'APPROVED', 'PROCESSING')
UNION ALL
SELECT
  'ORGANIZATION'        AS payee_type,
  id,
  "organizationId"      AS payee_id,
  status,
  method,
  "amountPaise" / 100.0 AS payout_inr,
  "gatewayPayoutId"     AS razorpayx_payout_id,
  "idempotencyKey",
  "failureReason",
  "createdAt",
  "updatedAt"
FROM "OrganizationPayout"
WHERE status IN ('PENDING', 'APPROVED', 'PROCESSING')
ORDER BY "updatedAt" ASC;
```

### 1.6 Double-Entry Ledger Balance Sanity Check (`SUM(DEBIT) = SUM(CREDIT)`)
```sql
SELECT
  lt.id,
  lt."idempotencyKey",
  lt.kind,
  SUM(CASE WHEN le.direction = 'DEBIT'  THEN le."amountPaise" ELSE 0 END) AS total_debit_paise,
  SUM(CASE WHEN le.direction = 'CREDIT' THEN le."amountPaise" ELSE 0 END) AS total_credit_paise
FROM "LedgerTransaction" lt
JOIN "LedgerEntry" le ON le."transactionId" = lt.id
GROUP BY lt.id, lt."idempotencyKey", lt.kind
HAVING SUM(CASE WHEN le.direction = 'DEBIT'  THEN le."amountPaise" ELSE 0 END)
    <> SUM(CASE WHEN le.direction = 'CREDIT' THEN le."amountPaise" ELSE 0 END);
```

---

## 2. Razorpay & RazorpayX API Inspection (`curl`)

All commands below are **read-only (`GET`)** unless explicitly marked otherwise. Export `RAZORPAY_KEY_ID` and `RAZORPAY_SECRET` first.

```bash
# Fetch an Order and its Payments
curl -s -u "$RAZORPAY_KEY_ID:$RAZORPAY_SECRET" \
  "https://api.razorpay.com/v1/orders/order_XXXXX" | jq .

curl -s -u "$RAZORPAY_KEY_ID:$RAZORPAY_SECRET" \
  "https://api.razorpay.com/v1/orders/order_XXXXX/payments" | jq .

# Fetch a Payment and its Refunds
curl -s -u "$RAZORPAY_KEY_ID:$RAZORPAY_SECRET" \
  "https://api.razorpay.com/v1/payments/pay_XXXXX" | jq .

curl -s -u "$RAZORPAY_KEY_ID:$RAZORPAY_SECRET" \
  "https://api.razorpay.com/v1/payments/pay_XXXXX/refunds" | jq .

# Fetch a Refund by ID
curl -s -u "$RAZORPAY_KEY_ID:$RAZORPAY_SECRET" \
  "https://api.razorpay.com/v1/refunds/rfnd_XXXXX" | jq .

# Fetch a Dispute by ID
curl -s -u "$RAZORPAY_KEY_ID:$RAZORPAY_SECRET" \
  "https://api.razorpay.com/v1/disputes/disp_XXXXX" | jq .

# Fetch a Customer and their Saved-Card Tokens
curl -s -u "$RAZORPAY_KEY_ID:$RAZORPAY_SECRET" \
  "https://api.razorpay.com/v1/customers/cust_XXXXX" | jq .

curl -s -u "$RAZORPAY_KEY_ID:$RAZORPAY_SECRET" \
  "https://api.razorpay.com/v1/customers/cust_XXXXX/tokens" | jq .
```

### RazorpayX Payouts & Validations (`GET`)

```bash
# Fetch a Payout by ID (inspect status, utr, and status_details)
curl -s -u "${RAZORPAYX_KEY_ID:-$RAZORPAY_KEY_ID}:${RAZORPAYX_KEY_SECRET:-$RAZORPAY_SECRET}" \
  "https://api.razorpay.com/v1/payouts/pout_XXXXX" | jq .

# Look up a Payout by our internal row ID (reference_id)
curl -s -u "${RAZORPAYX_KEY_ID:-$RAZORPAY_KEY_ID}:${RAZORPAYX_KEY_SECRET:-$RAZORPAY_SECRET}" \
  "https://api.razorpay.com/v1/payouts?account_number=${RAZORPAYX_ACCOUNT_NUMBER}&reference_id=cpout_XXXXX" | jq .

# Fetch a Fund Account Validation (penny drop / reverse penny drop)
curl -s -u "${RAZORPAYX_KEY_ID:-$RAZORPAY_KEY_ID}:${RAZORPAYX_KEY_SECRET:-$RAZORPAY_SECRET}" \
  "https://api.razorpay.com/v1/fund_accounts/validations/fav_XXXXX" | jq .
```

> **Note on Razorpay Subscriptions API (not used in this repo):** If you ever inspect or manage a Razorpay Subscription externally, remember that `POST /v1/subscriptions/:id/pause` takes `{"pause_at": "now"}` and `POST /v1/subscriptions/:id/resume` takes `{"resume_at": "now"}` (`pause_initiated_by` is a response-only field, never a request parameter). See [`not-used-here/subscriptions.md`](not-used-here/subscriptions.md). <!-- drift-ok -->
