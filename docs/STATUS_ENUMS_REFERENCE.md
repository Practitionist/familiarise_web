# Status Enums Reference Guide

Complete reference for all status enums used throughout the Familiarise application.

**Last Updated**: 2025-11-28
**Related Files**: `prisma/schema.prisma`

---

## Table of Contents

1. [Core Request/Booking Flow](#core-requestbooking-flow)
2. [Appointment Type-Specific Statuses](#appointment-type-specific-statuses)
3. [Payment-Related Statuses](#payment-related-statuses)
4. [Support/Feedback Statuses](#supportfeedback-statuses)
5. [User & Access Control](#user--access-control)
6. [Status Flow Diagrams](#status-flow-diagrams)
7. [Best Practices](#best-practices)

---

## Core Request/Booking Flow

### RequestStatus

**Location**: `prisma/schema.prisma`
**Models**: `Consultation`, `Subscription`

Tracks the lifecycle of consultation and subscription **requests** from initial submission through final scheduling.

```prisma
enum RequestStatus {
  PENDING
  APPROVED
  APPROVED_PENDING_PAYMENT // Approved by consultant but awaiting payment
  SCHEDULED
  REJECTED
  CANCELLED
  EXPIRED
}
```

#### Status Definitions

| Status                     | Description                               | Can Transition To                                     | Triggered By                         |
| -------------------------- | ----------------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| `PENDING`                  | Initial state when user submits request   | APPROVED, APPROVED_PENDING_PAYMENT, REJECTED, EXPIRED | User submission                      |
| `APPROVED`                 | Consultant approved and payment confirmed | SCHEDULED, CANCELLED                                  | Consultant approval + payment exists |
| `APPROVED_PENDING_PAYMENT` | Consultant approved but awaiting payment  | APPROVED, PENDING, CANCELLED                          | Consultant approval without payment  |
| `SCHEDULED`                | Appointment created and confirmed         | CANCELLED                                             | Appointment creation                 |
| `REJECTED`                 | Consultant declined the request           | -                                                     | Consultant rejection                 |
| `CANCELLED`                | Either party cancelled the request        | -                                                     | User or consultant cancellation      |
| `EXPIRED`                  | Request expired without action            | -                                                     | Reserved for future use              |

#### Important Notes

- **APPROVED_PENDING_PAYMENT** is a security feature added to prevent payment bypass
- Payments must be completed within 48 hours or request reverts to PENDING
- Only APPROVED requests can transition to SCHEDULED status
- SCHEDULED status is final for successful bookings

---

### BookingSource

**Location**: `prisma/schema.prisma`
**Models**: `Consultation`, `Subscription`

Indicates how the appointment was created.

```prisma
enum BookingSource {
  DIRECT_CHECKOUT
  REQUEST_SUBMITTED
}
```

| Value               | Description                      | Payment Flow                    |
| ------------------- | -------------------------------- | ------------------------------- |
| `DIRECT_CHECKOUT`   | User paid upfront during booking | Payment → Approval → Scheduling |
| `REQUEST_SUBMITTED` | Request-for-approval flow        | Approval → Payment → Scheduling |

---

## Appointment Type-Specific Statuses

### WebinarStatus

**Location**: `prisma/schema.prisma`
**Model**: `Webinar`

Tracks the **execution** state of webinars (not the booking process).

```prisma
enum WebinarStatus {
  SCHEDULED
  IN_PROGRESS
  COMPLETED
  CANCELLED
}
```

| Status        | Description                             | Triggered By                     |
| ------------- | --------------------------------------- | -------------------------------- |
| `SCHEDULED`   | Appointment booked, awaiting start time | Appointment creation             |
| `IN_PROGRESS` | Webinar currently happening             | Manual update or automated start |
| `COMPLETED`   | Webinar finished successfully           | Manual update or automated end   |
| `CANCELLED`   | Webinar cancelled                       | Consultant/admin cancellation    |

---

### ClassStatus

**Location**: `prisma/schema.prisma`
**Model**: `Class`

Tracks the **execution** state of classes.

```prisma
enum ClassStatus {
  SCHEDULED
  IN_PROGRESS
  COMPLETED
  CANCELLED
}
```

Same values and semantics as WebinarStatus.

---

### ConsultationMode

**Location**: `prisma/schema.prisma`
**Model**: `Consultation`

Defines the consultation delivery method.

```prisma
enum ConsultationMode {
  VIDEO
  AUDIO
  IN_PERSON
}
```

---

## Payment-Related Statuses

### PaymentStatus

**Location**: `prisma/schema.prisma`
**Model**: `Payment`

Tracks individual payment transaction states.

```prisma
enum PaymentStatus {
  PENDING
  SUCCEEDED
  FAILED
}
```

| Status      | Description                         | Next Steps                        |
| ----------- | ----------------------------------- | --------------------------------- |
| `PENDING`   | Payment initiated but not confirmed | Wait for webhook confirmation     |
| `SUCCEEDED` | Payment completed successfully      | Create appointment                |
| `FAILED`    | Payment attempt failed              | User can retry or contact support |

#### Webhook Integration

- **PENDING → SUCCEEDED**: Triggered by `checkout.session.completed` (Stripe) or `payment.captured` (Razorpay)
- **PENDING → FAILED**: Triggered by `checkout.session.expired` or `payment.failed`
- Always validate webhook metadata before transitioning to SUCCEEDED (see `schemas/webhooks/metadata.ts`)

---

### RefundStatus

**Location**: `prisma/schema.prisma`
**Model**: `Refund`

Tracks refund transaction states.

```prisma
enum RefundStatus {
  PENDING    // Refund initiated but not yet processed
  SUCCEEDED  // Refund completed successfully
  FAILED     // Refund failed
  CANCELLED  // Refund cancelled
}
```

| Status      | Description                        | User Impact                               |
| ----------- | ---------------------------------- | ----------------------------------------- |
| `PENDING`   | Refund initiated but not processed | Funds not yet returned                    |
| `SUCCEEDED` | Refund completed                   | Funds returned to original payment method |
| `FAILED`    | Refund processing failed           | Contact support for resolution            |
| `CANCELLED` | Refund cancelled before processing | No funds returned                         |

---

### DisputeStatus

**Location**: `prisma/schema.prisma`
**Model**: `Dispute`

Tracks payment disputes and chargebacks.

```prisma
enum DisputeStatus {
  WARNING_NEEDS_RESPONSE   // Early fraud warning, needs response
  WARNING_UNDER_REVIEW     // Early fraud warning under review
  WARNING_CLOSED           // Early fraud warning closed
  NEEDS_RESPONSE           // Dispute filed, needs evidence
  UNDER_REVIEW             // Evidence submitted, under review
  CHARGE_REFUNDED          // Charge was refunded
  WON                      // Dispute won
  LOST                     // Dispute lost
}
```

#### Status Flow

```
Early Warning Flow:
WARNING_NEEDS_RESPONSE → WARNING_UNDER_REVIEW → WARNING_CLOSED

Formal Dispute Flow:
NEEDS_RESPONSE → UNDER_REVIEW → WON/LOST/CHARGE_REFUNDED
```

#### Important Notes

- Early warnings (WARNING\_\*) give merchants a chance to respond before formal dispute
- `NEEDS_RESPONSE` has a deadline (typically 7-14 days) to submit evidence
- Once status reaches `WON`, `LOST`, or `CHARGE_REFUNDED`, it's final
- Razorpay disputes can only be accessed via webhooks (no direct API)

---

## Support/Feedback Statuses

### FeedbackStatus

**Location**: `prisma/schema.prisma`
**Model**: `Feedback`

Tracks user feedback submission lifecycle.

```prisma
enum FeedbackStatus {
  PENDING
  ACKNOWLEDGED
  IN_PROGRESS
  RESOLVED
  CLOSED
}
```

| Status         | Description                           | SLA                   |
| -------------- | ------------------------------------- | --------------------- |
| `PENDING`      | New feedback submitted                | Response within 24hrs |
| `ACKNOWLEDGED` | Team reviewed and acknowledged        | -                     |
| `IN_PROGRESS`  | Team actively working on it           | -                     |
| `RESOLVED`     | Issue fixed or feedback implemented   | -                     |
| `CLOSED`       | Ticket closed (resolved or dismissed) | -                     |

---

### SupportTicketStatus

**Location**: `prisma/schema.prisma`
**Model**: `SupportTicket`

Tracks support ticket lifecycle.

```prisma
enum SupportTicketStatus {
  OPEN
  IN_PROGRESS
  ON_HOLD
  RESOLVED
  CLOSED
}
```

| Status        | Description                     | When Used                                 |
| ------------- | ------------------------------- | ----------------------------------------- |
| `OPEN`        | New support ticket created      | Initial submission                        |
| `IN_PROGRESS` | Team actively working on ticket | Agent assignment                          |
| `ON_HOLD`     | Waiting for external input      | Awaiting user response, third-party, etc. |
| `RESOLVED`    | Issue successfully resolved     | Problem fixed                             |
| `CLOSED`      | Ticket closed                   | After resolution or escalation closure    |

---

### SupportPriority

**Location**: `prisma/schema.prisma`
**Model**: `SupportTicket`

Defines ticket priority levels.

```prisma
enum SupportPriority {
  LOW
  MEDIUM
  HIGH
  URGENT
}
```

---

## User & Access Control

### UserRole

**Location**: `prisma/schema.prisma`
**Model**: `User`

Defines user permission levels.

```prisma
enum UserRole {
  CONSULTANT
  CONSULTEE
  ADMIN
  STAFF
}
```

| Role         | Description          | Permissions                                                       |
| ------------ | -------------------- | ----------------------------------------------------------------- |
| `CONSULTANT` | Service provider     | Manage own profile, accept/reject requests, view own appointments |
| `CONSULTEE`  | Service consumer     | Book consultations, submit requests, view own appointments        |
| `ADMIN`      | Full system access   | All operations, user management, system configuration             |
| `STAFF`      | Limited admin access | Support tickets, content moderation, limited user management      |

---

## Status Flow Diagrams

### Request-to-Appointment Flow (Consultation/Subscription)

#### Direct Checkout Flow

```
User Action: Book + Pay
    ↓
Payment: PENDING
    ↓ (webhook)
Payment: SUCCEEDED
    ↓
RequestStatus: APPROVED
    ↓
RequestStatus: SCHEDULED
    ↓
Appointment Created
```

#### Request-for-Approval Flow (NEW - Security Enhanced)

```
User Action: Submit Request (no payment)
    ↓
RequestStatus: PENDING
    ↓
Consultant: Approve Request
    ↓
Payment Check: No Payment Found
    ↓
RequestStatus: APPROVED_PENDING_PAYMENT
Payment: PENDING (link generated)
    ↓
User: Complete Payment
    ↓ (webhook)
Payment: SUCCEEDED
    ↓
RequestStatus: APPROVED
    ↓
RequestStatus: SCHEDULED
    ↓
Appointment Created
```

#### Payment Timeout Flow

```
RequestStatus: APPROVED_PENDING_PAYMENT
Payment: PENDING
    ↓
Wait 48 hours
    ↓ (cron job: /api/cleanup/approval-payments)
Payment: FAILED
RequestStatus: PENDING or EXPIRED
```

---

### Webinar/Class Execution Flow

```
Appointment: Created
    ↓
WebinarStatus/ClassStatus: SCHEDULED
    ↓
Event: Start Time Reached
    ↓
WebinarStatus/ClassStatus: IN_PROGRESS
    ↓
Event: End Time Reached
    ↓
WebinarStatus/ClassStatus: COMPLETED
```

---

### Payment Dispute Flow

```
Payment: SUCCEEDED
    ↓
(User initiates chargeback)
    ↓
DisputeStatus: WARNING_NEEDS_RESPONSE
    ↓
Merchant: Submit Response
    ↓
DisputeStatus: WARNING_UNDER_REVIEW
    ↓
Gateway: Accept/Escalate
    ↓
If Escalated:
  DisputeStatus: NEEDS_RESPONSE
      ↓
  Merchant: Submit Evidence (7-14 days)
      ↓
  DisputeStatus: UNDER_REVIEW
      ↓
  Gateway Decision:
      → WON (merchant keeps funds)
      → LOST (customer refunded, merchant fee charged)
      → CHARGE_REFUNDED (merchant voluntarily refunded)
```

---

## Best Practices

### When Working with RequestStatus

1. **Always check for existing payments** before transitioning to APPROVED_PENDING_PAYMENT

   ```typescript
   const hasPayment = await checkPaymentExists(requestId);
   if (!hasPayment) {
     // Generate payment link
     status = RequestStatus.APPROVED_PENDING_PAYMENT;
   } else {
     status = RequestStatus.APPROVED;
   }
   ```

2. **Set payment expiration** when creating APPROVED_PENDING_PAYMENT requests

   ```typescript
   expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours
   ```

3. **Never skip APPROVED status** - always transition through the proper flow:
   - PENDING → APPROVED_PENDING_PAYMENT → APPROVED → SCHEDULED ✅
   - PENDING → SCHEDULED ❌

### When Working with PaymentStatus

1. **Always validate webhook metadata** before marking payments as SUCCEEDED

   ```typescript
   import { validateWebhookMetadata } from "@/schemas/webhooks/metadata";

   try {
     validateWebhookMetadata(metadata);
     // Proceed with payment success
   } catch (error) {
     // Flag for manual review
   }
   ```

2. **Use transactions** when updating payment status and creating appointments

   ```typescript
   await prisma.$transaction(async (tx) => {
     await tx.payment.update({
       /* ... */
     });
     await tx.appointment.create({
       /* ... */
     });
   });
   ```

3. **Handle race conditions** - payments can succeed/fail while user is still on checkout page

### When Working with WebinarStatus/ClassStatus

1. **Separate booking state from execution state**
   - RequestStatus: Tracks the booking/approval process
   - WebinarStatus/ClassStatus: Tracks the event execution

2. **Don't transition to IN_PROGRESS until event actually starts**
   - Use scheduled jobs or manual triggers
   - Verify start time has passed

3. **Mark as COMPLETED only after event ends**
   - Enables tracking of currently active events

### Status Transition Checklist

Before implementing any status change:

- [ ] Is this transition allowed? (Check flow diagram)
- [ ] Are prerequisites met? (e.g., payment confirmed, consultant approved)
- [ ] Does this require a webhook/cron job?
- [ ] Should this be in a transaction?
- [ ] Are there side effects? (e.g., send email, create appointment)
- [ ] Is there a rollback strategy if it fails?
- [ ] Are proper logs/analytics captured?

---

## Related Documentation

- [Payment System Flow](./payments/flow/CHECKOUT_FLOW_PART1.md)
- [Webhook Monitoring](./webhook-monitoring.md)
- [Abandoned Payment Solutions](./abandoned-payment-solutions.md)
- [Cron Setup Guide](./cron-setup.md)
- [Booking Algorithm](./booking-algorithm/00_README.md)

---

## Changelog

### 2025-11-28 - Security Enhancement

- **Added**: `APPROVED_PENDING_PAYMENT` status to RequestStatus enum
- **Purpose**: Prevent payment bypass vulnerability where consultations could be scheduled without payment
- **Implementation**: Pay-after-approval workflow with 48-hour payment timeout
- **Files Modified**:
  - `prisma/schema.prisma` - Added new enum value
  - `lib/payments/webhooks/handlers.ts` - Added APPROVED_PENDING_PAYMENT handling
  - `app/api/events/consultations/[consultationId]/route.ts` - Approval payment enforcement
  - `app/api/events/subscriptions/[subscriptionId]/route.ts` - Approval payment enforcement
  - `app/api/cleanup/approval-payments/route.ts` - Payment expiration cron job

---

**Questions or Issues?**
See related documentation above or check the PR that introduced these changes: `fix/payment-algorithm-1`
