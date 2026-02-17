# Rescheduling Payment Flow

## Overview

When an appointment is rescheduled, the **existing payment is reused** — no new payment is charged and no refund is issued. The payment record stays linked to the appointment, and consultant earnings remain unchanged.

---

## Payment Reuse Flow

```
┌─────────────────────────────────────────────────────────────┐
│ USER RESCHEDULES APPOINTMENT                                 │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ├─→ Slots marked isTentative: true
                   ├─→ Status reverted to PENDING
                   │
                   ├─→ NO new payment
                   ├─→ NO refund
                   ├─→ Earnings stay same
                   │
                   └─→ User selects new times
                       └─→ Slots confirmed (isTentative: false)
                           └─→ Original payment covers new slots
```

---

## What Stays Unchanged

| Concern | Behavior on Reschedule |
|---------|----------------------|
| **Payment record** | Stays `SUCCEEDED`, no modification |
| **Payment amount** | Same (no price difference logic) |
| **Consultant earnings** | Status unchanged (PENDING/READY/PAID) |
| **Hold period** | Not reset (still based on original payment time) |
| **Invoice** | Unchanged, original invoice remains valid |

---

## What Changes

| Concern | Behavior on Reschedule |
|---------|----------------------|
| **Appointment status** | Reverted to `PENDING` (full reschedule) or stays `APPROVED` (single session) |
| **Slot records** | Marked `isTentative: true` until new times confirmed |
| **Slot timing** | Old slots released, new slots acquired |

---

## Reschedule Types

### 1. Entire Booking Reschedule
- Status → `PENDING`
- ALL slots across all appointments marked tentative
- User must select entirely new times

### 2. Individual Session Reschedule (Subscriptions)
- Status stays `APPROVED` (only for single-session reschedule)
- Only specified slot(s) marked tentative
- Other sessions unaffected

### 3. Multiple Session Reschedule (Subscriptions)
- Status → `PENDING`
- Specified slots marked tentative
- Non-specified sessions unaffected

**Code location:** `app/api/appointments/[appointmentId]/reschedule/route.ts`

---

## Constraints

- **24-hour minimum notice:** Cannot reschedule if ANY affected slot is within 24 hours
- **No price adjustment:** If consultant's price changed since original booking, the original payment amount still stands
- **No earnings reset:** Hold period is NOT restarted — it continues from the original payment timestamp

---

## Related Documents

- [Cancellation Payment Flow](./01-cancellation-payment-flow.md) — When user cancels instead of rescheduling
- Booking-side reschedule docs: `docs/booking/06-reschedule-implementation-plan.md`
