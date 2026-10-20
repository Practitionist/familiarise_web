# Earnings Lifecycle

> **Moved (org/B2B side):** The organization-side documentation for earnings now lives in [`docs/enterprise/10-money-and-ledger/06-earnings-lifecycle.md`](../../enterprise/10-money-and-ledger/06-earnings-lifecycle.md) (and the payout batching in [`07-payout-pipeline.md`](../../enterprise/10-money-and-ledger/07-payout-pipeline.md)). This file keeps the consumer-marketplace (B2C) and gateway-generic details only.

> How consultant earnings flow from payment to payout

---

## Earnings Status Flow

```mermaid
stateDiagram-v2
    [*] --> PENDING: Payment Success

    PENDING --> READY: Hold Period Expires
    PENDING --> REFUNDED: Payment Refunded

    PENDING --> HELD: A hold is placed
    READY --> HELD: A hold is placed
    READY --> BATCHED: Rolled into payout batch

    BATCHED --> PAID: Payout Completed (COMPLETED + UTR)
    BATCHED --> READY: Batch failed or rejected

    HELD --> PENDING: Last hold released (was PENDING)
    HELD --> READY: Last hold released (was READY)
    HELD --> REFUNDED: Fully reversed (refund or lost dispute)

    PAID --> [*]
    REFUNDED --> [*]

    note right of PENDING
        Earnings held for
        24-168 hours
    end note

    note right of READY
        Eligible for
        payout batch
    end note

    note right of HELD
        At least one active
        EarningsHold
    end note
```

---

## Status Definitions

| Status       | Description                                                           | Next Actions            |
| ------------ | --------------------------------------------------------------------- | ----------------------- |
| **PENDING**  | Earnings created, within hold period                                  | Wait for hold expiry    |
| **READY**    | Hold period passed, eligible for payout                               | Include in batch        |
| **HELD**     | Frozen while at least one `EarningsHold` is active                    | Await each hold's owner |
| **BATCHED**  | Rolled into a payout batch, but cash has not left yet                 | Await payout completion |
| **PAID**     | Successfully paid to consultant (payout reached COMPLETED with a UTR) | Terminal state          |
| **REFUNDED** | Payment was refunded                                                  | Terminal state          |

---

## Earnings Creation Flow

```mermaid
sequenceDiagram
    participant WH as Webhook Handler
    participant ES as EarningsService
    participant DB as Database
    participant CP as ConsultantProfile

    WH->>ES: createEarningsFromPayment(payment)

    ES->>ES: Calculate revenue split
    Note over ES: grossAmount = payment.amount<br/>platformFee = 20%<br/>consultantShare = 80%

    ES->>ES: Determine hold period
    Note over ES: Based on appointmentType:<br/>CONSULTATION: 24h<br/>WEBINAR: 48h<br/>SUBSCRIPTION: 168h<br/>CLASS: 24h

    ES->>DB: Create ConsultantEarnings
    Note over DB: status: PENDING<br/>holdUntil: now + holdPeriod

    ES->>CP: Increment pendingRevenue
    Note over CP: pendingRevenue += consultantShare

    ES-->>WH: Earnings created
```

### Code Example

```typescript
// Payment of ₹1000 for consultation
const payment = {
  amount: 100000, // ₹1000 in paise
  appointmentType: "CONSULTATION",
};

// Earnings calculation
const earnings = {
  grossAmount: 100000,           // ₹1000
  platformFee: 20000,            // ₹200 (20%)
  consultantShare: 80000,        // ₹800 (80%)
  holdUntil: new Date() + 24h,   // 24 hours for consultation
  status: "PENDING",
};
```

---

## Hold Period Release

The `release-earnings` sweep runs on the five-minute Netlify ticker **every 15 minutes** (`netlify/functions/cron-tick.mts`), not in GitHub Actions.

```mermaid
flowchart TD
    A[Ticker: every 15 minutes] --> B[Find PENDING earnings]
    B --> C{holdUntil < now?}
    C -->|Yes| D[Update to READY]
    C -->|No| E[Skip - still in hold]
    D --> F[Log release count]
    E --> F
    F --> G[Complete]

    style D fill:#10b981,color:#fff
```

### Query Logic

```typescript
// Find earnings ready to release
const earningsToRelease = await prisma.consultantEarnings.findMany({
  where: {
    status: "PENDING",
    holdUntil: {
      lte: new Date(), // Hold period expired
    },
  },
});

// Update status
await prisma.consultantEarnings.updateMany({
  where: { id: { in: earningIds } },
  data: { status: "READY" },
});
```

---

## Hold Periods by Appointment Type

```mermaid
gantt
    title Hold Period Timeline
    dateFormat HH:mm
    axisFormat %H:%M

    section Consultation
    Hold Period (24h)    :active, cons, 00:00, 24h
    Ready for Payout     :done, cons-ready, after cons, 1h

    section Class
    Hold Period (24h)    :active, class, 00:00, 24h
    Ready for Payout     :done, class-ready, after class, 1h

    section Webinar
    Hold Period (48h)    :active, web, 00:00, 48h
    Ready for Payout     :done, web-ready, after web, 1h

    section Subscription
    Hold Period (7 days) :active, sub, 00:00, 168h
    Ready for Payout     :done, sub-ready, after sub, 1h
```

| Type             | Hold Period | Rationale                             |
| ---------------- | ----------- | ------------------------------------- |
| **Consultation** | 24 hours    | Short engagement, quick resolution    |
| **Class**        | 24 hours    | Similar to consultation               |
| **Webinar**      | 48 hours    | Allow time for participant feedback   |
| **Subscription** | 7 days      | Longer commitment, higher refund risk |

### New experts wait 7 days longer

`withNewExpertHold()` in `lib/payments/payouts/earnings-hold.ts` adds `NEW_EXPERT_EXTRA_HOLD_DAYS` (7) to `holdUntil` when the expert's first earning on a succeeded payment is under `NEW_EXPERT_TENURE_DAYS` (30) old or they have none, or when their lifetime consultant share net of refunds is under `NEW_EXPERT_LIFETIME_SHARE_PAISE` (₹50,000, 5,000,000 paise). The check is per consultant payee. Earnings whose hold is stamped later (subscription tranches, trial cancellations and the settlement of cancelled sessions) get the extra days through `stampConsultantHolds()`. For example, Hannah Anderson delivers a ₹1,000 consultation on Mon 26 Oct 2026, 10:00 to 11:00 IST. Her share is ₹800, and with no earlier earnings it turns READY on Tue 3 Nov 2026 at 11:00 IST instead of Tue 27 Oct 11:00 IST.

---

## Multi-Party Revenue Splits (Mar 2026)

For WEBINAR and CLASS payments with collaborators, the `sync-payment-earnings` job and the earnings creation flow now call `calculateRevenueSplit()` to create **multiple** `ConsultantEarnings` records per payment -- one for the owner and one for each collaborator, each with their `role` and `sharePercentage`. This replaces the previous single-earnings-per-payment assumption.

---

## Revenue Split Calculation

```mermaid
pie title Revenue Distribution
    "Consultant (80%)" : 80
    "Platform (20%)" : 20
```

### Calculation Formula

```typescript
const PLATFORM_FEE_PERCENTAGE = 20;
const CONSULTANT_SHARE_PERCENTAGE = 80;

function calculateSplit(grossAmount: number) {
  return {
    platformFee: Math.floor((grossAmount * PLATFORM_FEE_PERCENTAGE) / 100),
    consultantShare: Math.floor(
      (grossAmount * CONSULTANT_SHARE_PERCENTAGE) / 100,
    ),
  };
}

// Example: ₹1000 payment
// platformFee = ₹200
// consultantShare = ₹800
```

---

## Refund Handling

When a payment is refunded, the associated earnings are reversed proportionally (partial) or fully.

```mermaid
sequenceDiagram
    participant WH as Webhook Handler
    participant ES as EarningsService
    participant DB as Database
    participant CP as ConsultantProfile

    WH->>ES: refundEarnings(paymentId, opts)
    Note over WH,ES: opts: { refundAmount, paymentAmount }

    ES->>DB: Find earnings by paymentId
    DB-->>ES: earnings record

    alt Full refund or refundedShareAmount exhausted
        ES->>DB: Update status to REFUNDED
        ES->>DB: Increment refundedShareAmount
        ES->>CP: Decrement pendingRevenue/totalRevenue
        ES-->>WH: Refund processed (full)
    else Partial refund
        ES->>DB: Increment refundedShareAmount by proportional amount
        ES->>CP: Decrement pendingRevenue/totalRevenue proportionally
        ES-->>WH: Refund processed (partial)
    else Earnings status is PAID (with forceRefund)
        ES->>DB: Reverse via forceRefund path
        ES->>CP: Decrement totalRevenue
        ES-->>WH: Forced refund processed
    end
```

### Partial Refund Support (Mar 2026)

`refundEarnings()` now accepts `refundAmount`/`paymentAmount` for proportional reversal. A new `refundedShareAmount` field on `ConsultantEarnings` tracks cumulative partial refunds. Earnings auto-transition to `REFUNDED` when `refundedShareAmount >= consultantShare`.

### Refund States

| Original Status | Can Refund? | Action                                                           |
| --------------- | ----------- | ---------------------------------------------------------------- |
| PENDING         | Yes         | Proportional or full reversal, may mark REFUNDED                 |
| READY           | Yes         | Proportional or full reversal, may mark REFUNDED                 |
| HELD            | Yes         | Proportional or full reversal, may mark REFUNDED                 |
| PAID            | Yes\*       | Via `forceRefund: true` (lost disputes), decrements totalRevenue |
| REFUNDED        | No          | Already refunded                                                 |

> \*PAID earnings can now be refunded using `forceRefund: true`, used by the lost-dispute handler. This routes through the shared `recordTdsReversal` helper to write a negative `isReversal` `TDSRecord` (capped at the original withholding so a refund-then-chargeback can't double-reverse, #813) and decrements `totalRevenue`.

---

## Holds and Dispute Handling

An earning is `HELD` while it carries at least one active `EarningsHold`. A hold names a reason (`DISPUTE`, `MODERATION`, `OPERATOR` or `OVERAGE`) and a source reference, and each owner places and releases only its own hold. `lib/payments/payouts/earnings-holds.ts` (`placeEarningsHolds()` and `releaseEarningsHolds()`) is the only writer of the `HELD` status. The first hold stores the earning's prior status in `preHoldStatus`, and the last release restores it, so a PENDING earning that is held and released goes back to PENDING and a READY one back to READY.

| Reason       | Placed when                               | Released when                                       |
| ------------ | ----------------------------------------- | --------------------------------------------------- |
| `DISPUTE`    | A dispute opens on the payment            | That dispute settles, whatever the verdict          |
| `MODERATION` | The consultant is banned                  | An admin releases it                                |
| `OPERATOR`   | An admin holds the earning                | An admin releases it                                |
| `OVERAGE`    | A member overage on the payment is unpaid | The overage is paid, reversed or settled to the org |

```mermaid
flowchart TD
    A[Dispute opened] --> P{A payout already batched this payment?}
    P -->|PENDING or APPROVED| Q[Cancel that payout by CAS, its other earnings return to READY]
    P -->|No| H
    Q --> H[Place a DISPUTE hold on the unpaid earnings]
    H --> V{Verdict}
    V -->|Won or warning closed| W[Release this dispute's hold only]
    V -->|Lost or charge refunded| L[Reverse amount_deducted / payment.amount of each share, then release]
    V -->|Closed| C{amount_deducted > 0?}
    C -->|Yes| L
    C -->|No| W
    W --> R[Earning returns to its prior status]
    L --> M[Remainder returns to its prior status and stays payable; a share fully reversed is REFUNDED]

    style H fill:#f59e0b,color:#fff
    style W fill:#10b981,color:#fff
    style L fill:#ef4444,color:#fff
```

### Dispute settlement functions

The webhook (`handleDisputeUpdated()`) and the `reconcile-disputes` poll both settle a verdict through `settleDisputeVerdict()` in `app/api/webhooks/utils.ts`, which calls `settleWonDispute()`, `settleLostDispute()` or `settleClosedDispute()`. The poll adopts the gateway status and settles in one Serializable transaction, so a later webhook replay finds nothing left to do.

```typescript
// Lost: reverse the lost fraction of every share, then release this dispute's hold.
// prorationFactor = min(amount_deducted / payment.amount, 1); each share is floored.
await settleLostDispute(tx, dispute, amountDeductedPaise);

// Razorpay "closed": a loss for what it deducted, otherwise a release.
await settleClosedDispute(tx, dispute, amountDeductedPaise);
```

For example, Charlotte Brown pays ₹1,180 (118,000 paise) for Hannah Anderson's ₹1,000 consultation, and Hannah's share is ₹800 (80,000 paise). A dispute is opened and the earning is held. Razorpay reports it lost with `amount_deducted` of ₹590 (59,000 paise). The factor is 0.5, so ₹400 (40,000 paise) of the share is reversed (`refundedShareAmount` = 40,000), the hold is released, and the other ₹400 returns to its prior status and stays payable. If the earning had already been paid on a completed payout, the ₹400 less the TDS fraction of that payout becomes a clawback receivable, and the withheld tax is reversed through `recordTdsReversal`.

---

## Earnings Summary API

Consultants can view their earnings breakdown:

```typescript
interface EarningsSummary {
  totalEarnings: number; // All time
  pendingEarnings: number; // Status: PENDING
  readyForPayout: number; // Status: READY
  heldEarnings: number; // Status: HELD
  paidOutEarnings: number; // Status: PAID
  refundedEarnings: number; // Status: REFUNDED
}
```

### API Endpoint

```
GET /api/consultant/earnings

Response:
{
  "summary": {
    "totalEarnings": 150000,
    "pendingEarnings": 20000,
    "readyForPayout": 50000,
    "heldEarnings": 0,
    "paidOutEarnings": 80000,
    "refundedEarnings": 0
  },
  "earnings": [
    {
      "id": "...",
      "grossAmount": 10000,
      "consultantShare": 8000,
      "status": "READY",
      "holdUntil": "2025-12-27T10:00:00Z",
      "createdAt": "2025-12-26T10:00:00Z"
    }
  ]
}
```

---

## Database Schema

```typescript
model ConsultantEarnings {
  id                   String             @id @default(uuid())
  consultantProfile    ConsultantProfile  @relation(...)
  consultantProfileId  String
  payment              Payment            @relation(...)
  paymentId            String             @unique
  payout               Payout?            @relation(...)
  payoutId             String?

  // Amounts in paise
  grossAmount          Int                // Total payment amount
  platformFee          Int                // 20% platform cut
  consultantShare      Int                // 80% consultant share
  refundedShareAmount  Int  @default(0)   // Cumulative partial refund amount (Mar 2026)

  // Status tracking
  status               EarningStatus      @default(PENDING)
  holdUntil            DateTime           // When PENDING → READY
  paidAt               DateTime?          // When status became PAID
  preHoldStatus        EarningStatus?     // Status to restore when the last hold is released (column preDisputeStatus)
  releasedFromPayoutId String?            // The failed payout that last released this earning

  createdAt            DateTime           @default(now())
  updatedAt            DateTime           @updatedAt
}

enum EarningStatus {
  PENDING   // Within hold period
  READY     // Eligible for payout
  HELD      // At least one active EarningsHold (dispute, moderation, operator or overage)
  BATCHED   // Rolled into a payout batch; cash has not been disbursed yet
  PAID      // Payout completed (reached COMPLETED with a UTR)
  REFUNDED  // Payment was refunded
}
```

---

## Next: [03-payout-processing.md](./03-payout-processing.md)
