# Cancellation Payment Flow

## Overview

When an appointment is cancelled, the payment system must handle potential refunds and earnings reversal. Critically, **refunds are NOT automatic** — they must be initiated separately by an admin.

---

## Cancellation → Refund Flow

```
┌─────────────────────────────────────────────────────────────┐
│ USER CANCELS APPOINTMENT                                     │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ├─→ Appointment deleted
                   ├─→ Slots deleted
                   ├─→ Waitlist notified (if webinar/class)
                   │
                   └─→ NO automatic refund
                       │
                       └─→ Admin initiates refund via API
                           └─→ Refund created (PENDING)
                               ├─→ Gateway processes
                               └─→ Earnings marked REFUNDED
                                   └─→ pendingRevenue decremented
```

### Why Refunds Are Decoupled

1. **Business flexibility** — allows partial refunds, refund denial, or delayed refunds
2. **Earnings safety** — if consultant earnings are already PAID, the platform would absorb the loss
3. **Dispute prevention** — admin can review before issuing refund

---

## Cancellation Reasons

The system tracks structured cancellation reasons for analytics:

| Category | Reason | Code |
|----------|--------|------|
| User-initiated | Scheduling conflict | `SCHEDULE_CONFLICT` |
| User-initiated | Found another option | `FOUND_ALTERNATIVE` |
| User-initiated | Cannot afford it | `FINANCIAL_REASONS` |
| User-initiated | Unexpected situation | `PERSONAL_EMERGENCY` |
| User-initiated | No longer needed | `NO_LONGER_NEEDED` |
| Consultant-initiated | Can't make it | `CONSULTANT_UNAVAILABLE` |
| Consultant-initiated | Has an emergency | `CONSULTANT_EMERGENCY` |
| System-initiated | Payment couldn't process | `PAYMENT_FAILED` |
| System-initiated | Booking expired | `EXPIRED` |
| Other | Catchall | `OTHER` |

**Code location:** `app/api/appointments/[appointmentId]/cancel/route.ts`

---

## Refund Initiation (Two-Phase Pattern)

When an admin decides to refund a cancelled appointment:

**Phase 1: Create PENDING Refund (atomic transaction)**
- Validates payment status is `SUCCEEDED`
- Checks if consultant earnings have been `PAID` (blocks unless `forceRefund: true`)
- Creates refund record with `PENDING` status

**Phase 2: Call Payment Gateway (outside transaction)**
- Routes to Stripe or Razorpay based on original payment gateway
- Gateway processes the actual money reversal

**Phase 3: Update Status**
- Refund record updated to `SUCCEEDED` or `FAILED`

**Code location:** `app/api/payments/refunds/route.ts`

---

## Earnings Cascade on Refund

When a refund succeeds, consultant earnings must be reversed. This happens **asynchronously** via a scheduled job.

### Cascade Job

- **Schedule:** Every 15 minutes (GitHub Actions)
- **Code:** `scripts/refunds/cascade-refund-earnings.ts`
- **Logic:**
  1. Find all refunds with `status = SUCCEEDED`
  2. Check associated earnings are in `PENDING`, `HELD`, or `READY` status
  3. Mark earnings as `REFUNDED`
  4. Decrement consultant's `pendingRevenue`

### Earnings Refund Eligibility

| Earnings Status | Can be Refunded? | Notes |
|----------------|-----------------|-------|
| `PENDING` | Yes | Still in hold period |
| `HELD` | Yes | Under dispute |
| `READY` | Yes | Available for payout but not yet sent |
| `PAID` | No* | Already in consultant's bank |
| `REFUNDED` | N/A | Already refunded (idempotent skip) |

*Can be force-refunded with `forceRefund: true` — platform absorbs the loss.

**Code location:** `lib/payments/payouts/earnings-service.ts` → `refundEarnings()`

---

## Waitlist Payment Implications

When a webinar or class appointment is cancelled:

1. `handleSlotOpening()` notifies the next person in the waitlist queue
2. Notification expires after 48 hours
3. If they accept: redirected to checkout for a **new payment** (the original payment is NOT transferred)
4. If they decline or skip: next person in queue is notified

**Key:** Waitlist acceptance requires a completely new payment. The cancelled appointment's refund (if issued) goes back to the original payer.

---

## Related Documents

- [Refund Flow](../refunds-disputes/02-refund-flow.md) — Detailed two-phase refund pattern
- [Dispute Flow](../refunds-disputes/03-dispute-flow.md) — When customers dispute instead of requesting refund
- [Earnings Lifecycle](../payouts/02-earnings-lifecycle.md) — Complete earnings status machine
