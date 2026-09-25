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

### What the consultant sees

Until PR-Y (#1675, #1527 W2) no consultant route read `ConsultantPayout` at all, so the withholding was invisible to the person it was withheld from. The Paid-out segment of the Earnings page now lists the consultant's payouts through `getConsultantPayouts` in `lib/payments/payouts/payout-service.ts`, whose select (`CONSULTANT_PAYOUT_SELECT`) carries the money walk, the dates, the failure reason and the UTR and never `providerPayoutId`, `idempotencyKey` or batch internals. Each row is worded by `derivePayoutPresentation` in `lib/dashboard/earnings-state.ts`, as the table below shows, and opens a sheet that walks share → TDS at the stamped `tdsRateAppliedBps` (Section 194-O) → net, with the UTR and the date.

| `PayoutStatus`        | Badge                 | Tone     | Line                                                                                              |
| --------------------- | --------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `PENDING`, `APPROVED` | Queued                | neutral  | "Queued for the next payout run"                                                                  |
| `PROCESSING`          | On its way            | info     | "Sent to your bank"                                                                               |
| `COMPLETED`           | Paid                  | success  | "Paid <date> · UTR <utr>"                                                                         |
| `FAILED`              | Failed                | warning  | The failure reason reduced to plain words by `sanitizePayoutFailure`, then "; we retry on Monday" |
| `CANCELLED`           | Cancelled             | neutral  | "Cancelled before it was sent — the money stays in your balance"                                  |
| `REVERSED`            | Returned by your bank | critical | "Your bank sent the transfer back — check your account details"                                   |

The failure reason is sanitised on the server before the payload leaves (`buildConsultantEarningsPayload`), because the raw gateway text can embed a provider payout id; the sanitiser is idempotent so the client derivation can run it again safely.

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
                Note over DB: Set payoutId and status = BATCHED<br/>on each earning (cash has not left yet)
                PS->>PS: Count-mismatch guard
                Note over PS: Verify linked count == expected count
            end
        end
        PS->>DB: COMMIT $transaction
    end

    PS-->>GH: Batch complete
```

> **Batch Integrity (Mar 2026):** Each consultant's payout is now wrapped in a `$transaction` that re-queries exact READY earnings, sums them, creates the payout, and links earnings by ID while moving them to `BATCHED` (the cash has not left yet, so they are not yet `PAID`) -- all atomically. A count-mismatch guard ensures the number of linked earnings matches expectations, preventing partial batches from concurrent modifications.

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

## Instant payout (#1771 row 6)

An expert can be paid their READY earnings at once, free and at most once per IST calendar day, with the "Get paid now" button on the Available tile of the Earnings page. The platform absorbs the RazorpayX transfer fee, so an instant payout carries no fee and no GST line, and it pays only READY earnings, never PENDING or HELD ones.

`createInstantPayout` in `payout-service.ts` answers every anticipated refusal as a typed `InstantPayoutError` (a `Refusal`), which the table below lists.

| Code                    | Status | When                                                                               |
| ----------------------- | ------ | ---------------------------------------------------------------------------------- |
| `PAYOUTS_DISABLED`      | 503    | `ENABLE_LIVE_PAYOUTS` is off.                                                      |
| `NOTHING_AVAILABLE`     | 409    | There are no READY earnings.                                                       |
| `PAYOUT_NOT_ELIGIBLE`   | 409    | `checkPayoutEligibility` names a reason, which the response carries as `reason`.   |
| `PAYOUT_BUSY`           | 409    | The Monday batch holds the batch lock ("A payout run is in progress — try again"). |
| `INSTANT_ALREADY_TODAY` | 409    | Today's instant payout already exists.                                             |

The instant payout takes the Monday batch's own Redis lock and mints through the same per-consultant internals (`mintConsultantPayout`), so the READY-to-BATCHED compare-and-set with its count check decides which of the two a READY row joins. Its idempotency key is `instant_<consultantProfileId>_<YYYYMMDD>` on the IST date, and the unique index on `ConsultantPayout.idempotencyKey` is what enforces once a day; the RazorpayX header is folded to 36 characters by `boundPayoutIdempotencyKey`. The row carries `kind: 'INSTANT'`, where a null `kind` means the Monday batch. A payout at or below `INSTANT_PAYOUT_AUTO_APPROVE_PAISE` (₹25,000 by default, overridable by environment) is approved and disbursed at once through `processPayoutById`, which runs the `processSinglePayout` core under the processing lock with `assertPayoutBalance` on that one amount, so the per-payout TDS path reads the financial-year running total serially. A larger payout is created PENDING and joins the admin approval queue, and the response says `awaitingApproval: true`. The mode is IMPS or UPI through `determinePayoutMode`.

The routes are `POST /api/consultant/payouts/instant` and `GET /api/consultant/payouts/instant/preview`, both session-scoped to the expert's own profile and answered with `Cache-Control: no-store`; the POST is rate-limited by `moneyOpsLimiter` and refused in DEGRADED mode. The preview returns the READY total, a TDS estimate at the 194-O rate, the net amount, the label "Free · once a day" and `nextAllowedAt`, which is the next IST midnight once today's instant payout has been used.

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

An unknown provider status never downgrades a payout (R-5). The RazorpayX and Stripe webhook mappers in `app/api/webhooks/utils.ts` and the switch in `handlePayoutWebhook` all keep the payout's current status when they meet a status they do not recognise, and `reportUnknownPayoutStatus` leaves a Sentry breadcrumb and a WARN `PAYOUT` system event so the new status is noticed.

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
    B --> C[payout_{payoutId}]
    C --> D[Send to Provider]
    D --> E{Duplicate Request?}
    E -->|Yes| F[Return Original Response]
    E -->|No| G[Process & Return New Response]

    style C fill:#8b5cf6,color:#fff
```

### Key Format

```typescript
// Idempotency key generation — deterministic, not time-based.
// razorpay-payouts.ts generateIdempotencyKey():
const idempotencyKey = `payout_${payoutId}`;

// RazorpayX: X-Payout-Idempotency header (lib/payments/payouts/razorpay-payouts.ts:328)
// Stripe: Idempotency-Key header
```

An instant payout's row key is `instant_<consultantProfileId>_<YYYYMMDD>` (IST), and the Monday batch's is `payout_<consultantProfileId>_<batchId>`; both are folded into RazorpayX's 36-character limit at the header.

> **Note (#771 P1-6):** The key is intentionally deterministic (`payout_<id>`). Using `Date.now()` would generate a new key on every retry — defeating RazorpayX's duplicate-suppression for that `payoutId` and potentially double-disbursing.

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

The stuck-payout handler re-arms a payout for retry through a compare-and-set, not a bare update (#1407). `scripts/payouts/handle-stuck-payouts.ts` reads its cohort of `PROCESSING` payouts once and then spends a gateway HTTP round-trip on each one in turn, which leaves a wide window in which a concurrent `process-payouts` run or an inbound payout webhook can move a row that the handler has already read. The reset to `APPROVED` therefore carries the state it expects to find in its `WHERE` clause — `status = PROCESSING` and `providerPayoutId IS NULL` — so a row that something else has advanced in the meantime is no longer matched. When the update affects zero rows the handler counts the payout as skipped and logs that it raced; it neither throws nor retries, because whichever writer moved the row now owns it. Without that guard the handler would stamp a payout back to `APPROVED` after a webhook had already completed it, and the next weekly batch would disburse the same money a second time.

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
