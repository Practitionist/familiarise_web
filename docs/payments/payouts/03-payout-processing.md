# Payout Processing

> **Moved (org/B2B side):** The organization-side documentation for payouts now lives in [`docs/enterprise/10-money-and-ledger/07-payout-pipeline.md`](../../enterprise/10-money-and-ledger/07-payout-pipeline.md) and [`06-earnings-lifecycle.md`](../../enterprise/10-money-and-ledger/06-earnings-lifecycle.md). This file keeps the consumer-marketplace (B2C) and gateway-generic details only.

> Batch creation, approval workflow, and payment gateway integration

---

## Payout Status Flow

```mermaid
stateDiagram-v2
    [*] --> PENDING: Batch Created

    PENDING --> APPROVED: Admin Approves
    PENDING --> APPROVED: Auto-Approved (< ₹5000)
    PENDING --> CANCELLED: Admin Rejects

    APPROVED --> PROCESSING: Process Started
    PROCESSING --> COMPLETED: Provider Success
    PROCESSING --> FAILED: Provider Error

    FAILED --> APPROVED: Manual Retry
    FAILED --> CANCELLED: Max Retries Exceeded

    COMPLETED --> [*]
    CANCELLED --> [*]

    note right of PENDING
        Amount >= ₹5000
        needs approval
    end note

    note right of APPROVED
        Ready to send
        to provider
    end note

    note right of PROCESSING
        Sent to
        RazorpayX/Stripe
    end note
```

---

## Weekly Batch Creation

The `create-payout-batch.ts` script runs **every Monday at 1:30 AM IST** (Sunday 8:00 PM UTC).

```mermaid
sequenceDiagram
    participant GH as GitHub Actions
    participant PS as PayoutService
    participant DB as Database

    GH->>PS: createPayoutBatch()

    PS->>DB: Find unique consultants with READY earnings
    DB-->>PS: consultant list

    loop For each consultant
        PS->>DB: BEGIN $transaction
        PS->>DB: Re-query exact READY earnings (inside TX)
        DB-->>PS: earnings list (authoritative)

        PS->>PS: Sum consultantShare amounts

        alt Total < ₹500 (minimum)
            PS->>PS: Skip - below minimum
        else Total >= ₹500
            PS->>DB: Get default PayoutAccount
            DB-->>PS: account details

            alt No verified account
                PS->>PS: Skip - no payout account
            else Has verified account
                PS->>PS: Determine payout method
                Note over PS: UPI / BANK_TRANSFER / STRIPE_TRANSFER

                alt Amount < ₹5000
                    PS->>DB: Create Payout (APPROVED)
                    Note over DB: Auto-approved
                else Amount >= ₹5000
                    PS->>DB: Create Payout (PENDING)
                    Note over DB: Needs admin approval
                end

                PS->>DB: Link earnings to payout by ID
                Note over DB: Set payoutId on each earning
                PS->>PS: Count-mismatch guard
                Note over PS: Verify linked count == expected count
            end
        end
        PS->>DB: COMMIT $transaction
    end

    PS-->>GH: Batch complete
```

> **Batch Integrity (Mar 2026):** Each consultant's payout is now wrapped in a `$transaction` that re-queries exact READY earnings, sums them, creates the payout, and links earnings by ID -- all atomically. A count-mismatch guard ensures the number of linked earnings matches expectations, preventing partial batches from concurrent modifications.

### Eligibility Criteria

```mermaid
flowchart TD
    A[Consultant] --> B{Has READY earnings?}
    B -->|No| C[Skip]
    B -->|Yes| D{Total >= ₹500?}
    D -->|No| E[Skip - below minimum]
    D -->|Yes| F{Has verified payout account?}
    F -->|No| G[Skip - no account]
    F -->|Yes| H{Is account default?}
    H -->|No| I[Skip - no default account]
    H -->|Yes| J[Create Payout]

    J --> K{Amount < ₹5000?}
    K -->|Yes| L[Auto-Approve]
    K -->|No| M[Pending Approval]

    style J fill:#3b82f6,color:#fff
    style L fill:#10b981,color:#fff
    style M fill:#f59e0b,color:#fff
```

---

## Admin Approval Workflow

```mermaid
sequenceDiagram
    participant AD as Admin Dashboard
    participant API as Admin API
    participant PS as PayoutService
    participant DB as Database

    AD->>API: GET /api/admin/payouts?status=PENDING
    API->>PS: getPendingPayouts()
    PS->>DB: Query payouts
    DB-->>PS: pending payouts list
    PS-->>API: payouts
    API-->>AD: Display pending list

    alt Approve
        AD->>API: POST /api/admin/payouts/{id}
        Note over AD: { action: "approve" }
        API->>PS: approvePayout(id, adminId)
        PS->>DB: Update status to APPROVED
        PS->>DB: Set approvedAt, approvedBy
        DB-->>PS: Updated
        PS-->>API: Success
        API-->>AD: Payout approved
    else Reject
        AD->>API: POST /api/admin/payouts/{id}
        Note over AD: { action: "reject", reason: "..." }
        API->>PS: rejectPayout(id, reason)
        PS->>DB: Update status to CANCELLED
        PS->>DB: Unlink earnings (set payoutId = null)
        Note over DB: Earnings return to READY
        DB-->>PS: Updated
        PS-->>API: Success
        API-->>AD: Payout rejected
    end
```

### Approval Thresholds

| Amount Range | Approval                        |
| ------------ | ------------------------------- |
| < ₹5,000     | Auto-approved at batch creation |
| >= ₹5,000    | Requires admin approval         |

---

## Payout Processing

The `process-payouts.ts` script runs **every Monday at 2:30 AM IST** (Monday 9:00 PM UTC).

```mermaid
sequenceDiagram
    participant GH as GitHub Actions
    participant PS as PayoutService
    participant DB as Database
    participant RX as RazorpayX
    participant SC as Stripe Connect

    GH->>PS: processApprovedPayouts()
    PS->>DB: Get APPROVED payouts
    DB-->>PS: approved list

    loop For each payout
        PS->>DB: Update status to PROCESSING
        PS->>DB: Get PayoutAccount
        DB-->>PS: account details

        alt Provider = RAZORPAY
            PS->>RX: processSinglePayout()
            RX->>RX: getOrCreateContact()
            RX->>RX: getOrCreateFundAccount()
            RX->>RX: createPayout()
            RX-->>PS: { success, providerPayoutId }
        else Provider = STRIPE
            PS->>SC: processSinglePayout()
            SC->>SC: createTransfer()
            SC-->>PS: { success, providerPayoutId }
        end

        alt Success
            PS->>DB: Store providerPayoutId
            Note over DB: Await webhook for final status
        else Failure
            PS->>DB: Update status to FAILED
            PS->>DB: Store failureReason
            PS->>DB: Increment retryCount
            PS->>DB: Unlink earnings (return to READY)
        end
    end

    PS-->>GH: Processing complete
```

---

## Provider Routing

```mermaid
flowchart TD
    A[Process Payout] --> B{PayoutAccount Type?}

    B -->|BANK_ACCOUNT| C{Provider?}
    B -->|UPI| D[RazorpayX UPI]
    B -->|STRIPE_CONNECT| E[Stripe Transfer]

    C -->|RAZORPAY| F[RazorpayX Bank]
    C -->|STRIPE| E

    D --> G[RazorpayX API]
    F --> G
    E --> H[Stripe API]

    G --> I{Amount?}
    I -->|<= ₹5L| J[IMPS Mode]
    I -->|> ₹2L| K[RTGS Mode]
    I -->|Other| L[NEFT Mode]

    style D fill:#6366f1,color:#fff
    style F fill:#6366f1,color:#fff
    style E fill:#ec4899,color:#fff
```

### Payout Methods

| Method              | Provider  | Speed     | Limit         |
| ------------------- | --------- | --------- | ------------- |
| **UPI**             | RazorpayX | Instant   | ₹1 Lakh       |
| **IMPS**            | RazorpayX | < 5 min   | ₹5 Lakh       |
| **NEFT**            | RazorpayX | 2-4 hours | Unlimited     |
| **RTGS**            | RazorpayX | 30 min    | ₹2 Lakh+      |
| **Stripe Transfer** | Stripe    | 2-7 days  | Account limit |

---

## Webhook Handling

After sending payout to provider, the final status comes via webhook.

```mermaid
sequenceDiagram
    participant PG as Payment Gateway
    participant WH as Webhook Handler
    participant PS as PayoutService
    participant DB as Database

    PG->>WH: POST /api/webhooks/{provider}
    Note over PG,WH: payout.processed / transfer.created

    WH->>WH: Verify webhook signature
    WH->>PS: handlePayoutWebhook(event)

    PS->>DB: Find payout by providerPayoutId
    DB-->>PS: payout record

    alt Status: processed/succeeded
        PS->>DB: Atomic updateMany with guard
        Note over DB: WHERE status NOT IN<br/>(COMPLETED, CANCELLED)
        PS->>DB: Update payout status to COMPLETED
        PS->>DB: Set processedAt
        PS->>DB: Update linked earnings to PAID
        PS->>DB: Set paidAt on earnings
        PS->>DB: Update consultant totals
        Note over DB: totalRevenue += amount<br/>pendingRevenue -= amount
    else Status: failed/reversed
        PS->>DB: Update payout status to FAILED
        PS->>DB: Store failureReason
        PS->>DB: Unlink earnings (payoutId = null)
        Note over DB: Earnings return to READY for retry
    end

    PS-->>WH: Handled
    WH-->>PG: 200 OK
```

> **Idempotency (Mar 2026):** `handlePayoutWebhook` now uses atomic `updateMany` with a `status: { notIn: [COMPLETED, CANCELLED] }` guard to prevent double-applying revenue on duplicate webhooks. If the payout has already reached a terminal state, the duplicate webhook is safely ignored.

### Webhook Events

| Provider  | Event               | Our Action          |
| --------- | ------------------- | ------------------- |
| RazorpayX | `payout.processed`  | Mark COMPLETED      |
| RazorpayX | `payout.failed`     | Mark FAILED, retry  |
| RazorpayX | `payout.reversed`   | Mark FAILED, refund |
| Stripe    | `transfer.created`  | Mark COMPLETED      |
| Stripe    | `transfer.failed`   | Mark FAILED, retry  |
| Stripe    | `transfer.reversed` | Mark FAILED, refund |

---

## Idempotency

All payout requests use idempotency keys to prevent duplicates.

```mermaid
flowchart TD
    A[Create Payout Request] --> B[Generate Idempotency Key]
    B --> C[payout_{id}_{timestamp}]
    C --> D[Send to Provider]
    D --> E{Duplicate Request?}
    E -->|Yes| F[Return Original Response]
    E -->|No| G[Process & Return New Response]

    style C fill:#8b5cf6,color:#fff
```

### Key Format

```typescript
// Idempotency key generation
const idempotencyKey = `payout_${payout.id}_${Date.now()}`;

// RazorpayX: X-Payout-Idempotency header
// Stripe: Idempotency-Key header
```

---

## Retry Logic

Failed payouts are automatically retried in the next weekly batch.

```mermaid
flowchart TD
    A[Payout Failed] --> B{Retry Count < 3?}
    B -->|Yes| C[Unlink Earnings]
    C --> D[Earnings → READY]
    D --> E[Next Week: Re-batch]
    E --> F[Retry with new Payout]

    B -->|No| G[Max Retries Exceeded]
    G --> H[Mark CANCELLED]
    H --> I[Manual Intervention Required]

    style F fill:#10b981,color:#fff
    style I fill:#ef4444,color:#fff
```

### Retry Flow

1. **Payout fails** → Status: FAILED
2. **Earnings unlinked** → payoutId set to null
3. **Earnings status** → Remains READY
4. **Next batch** → Earnings included again
5. **New payout created** → Fresh retry

---

## Payout Database Schema

```typescript
model Payout {
  id                   String           @id @default(uuid())
  consultantProfile    ConsultantProfile @relation(...)
  consultantProfileId  String

  // Provider info
  provider             PaymentGateway   // RAZORPAY or STRIPE
  providerPayoutId     String?          @unique
  idempotencyKey       String           @unique

  // Amount
  amount               Int              // In paise
  currency             String           @default("INR")

  // Status tracking
  status               PayoutStatus     @default(PENDING)
  method               PayoutMethod     // UPI, BANK_TRANSFER, STRIPE_TRANSFER

  // Batch info
  batchId              String           // Weekly batch identifier

  // Error handling
  failureReason        String?
  retryCount           Int              @default(0)

  // Timestamps
  processedAt          DateTime?
  approvedAt           DateTime?
  approvedBy           String?          // Admin user ID or "SYSTEM_AUTO_APPROVE"

  // Relations
  earnings             ConsultantEarnings[]

  createdAt            DateTime         @default(now())
  updatedAt            DateTime         @updatedAt
}

enum PayoutStatus {
  PENDING      // Awaiting approval
  APPROVED     // Ready to process
  PROCESSING   // Sent to provider
  COMPLETED    // Successfully delivered
  FAILED       // Provider error
  CANCELLED    // Rejected or cancelled
}

enum PayoutMethod {
  UPI
  BANK_TRANSFER
  STRIPE_TRANSFER
}
```

---

## Next: [04-api-reference.md](./04-api-reference.md)
