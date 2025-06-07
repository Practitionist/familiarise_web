# Unified Checkout System

This document describes the new unified checkout system that consolidates payment processing for all appointment types.

## Overview

The new system provides:
- **Single API Route**: `/api/checkout` handles all appointment types
- **Server Action**: `checkoutAction` for easy frontend integration
- **Skip Payment Mode**: For development and testing
- **Unified Webhooks**: Single webhook handler for all payment gateways
- **Transaction Safety**: Proper rollback on failures
- **Waitlist Management**: Automatic handling for full events

## Environment Variables

Add these to your `.env` file:

```bash
# Skip payment for development/testing
SKIP_PAYMENT=true  # Set to 'false' in production

# Payment gateway credentials (existing)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```

## API Usage

### Unified Checkout API Route

**Endpoint**: `POST /api/checkout`

**Request Body**:
```typescript
{
  appointmentType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";
  planId: string; // Plan ID for the service
  eventId?: string; // Required for WEBINAR and CLASS
  
  // Required for CONSULTATION and SUBSCRIPTION
  slotStartTimeInUTC?: string; // ISO datetime
  slotEndTimeInUTC?: string; // ISO datetime
  slotOfAvailabilityWeeklyId?: string;
  slotOfAvailabilityCustomId?: string;
  
  discountCode?: string;
  paymentGateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW";
  notes?: string;
}
```

**Response (Skip Payment Mode)**:
```typescript
{
  success: true;
  message: "Appointment booked successfully (payment skipped)";
  appointmentId: string;
  skipPayment: true;
}
```

**Response (Payment Required)**:
```typescript
{
  success: true;
  paymentIntent: StripePaymentIntent | RazorpayOrder;
  appointmentId: string;
  amount: number;
  currency: "USD" | "INR";
}
```

### Server Action Usage

```typescript
import { checkoutAction } from "@/actions/checkout.action";

const result = await checkoutAction({
  appointmentType: "CONSULTATION",
  planId: "plan_123",
  slotStartTimeInUTC: "2024-01-15T10:00:00Z",
  slotEndTimeInUTC: "2024-01-15T11:00:00Z",
  paymentGateway: "STRIPE",
  discountCode: "SAVE10"
});

if (result.error) {
  console.error(result.error);
} else if (result.skipPayment) {
  // Appointment booked immediately
  console.log("Booked:", result.appointmentId);
} else {
  // Process payment with result.paymentIntent
  console.log("Payment required:", result.paymentIntent);
}
```

## Appointment Type Handling

### Consultation & Subscription
- **Status**: Creates `PENDING` request (requires consultant approval)
- **Skip Payment**: Immediately approved (`APPROVED` status)
- **Timing**: Requires slot timing information
- **Validation**: Checks for slot conflicts

### Webinar & Class
- **Status**: Confirms appointment immediately
- **Skip Payment**: Immediately confirmed
- **Capacity**: Checks max participants
- **Waitlist**: Auto-adds to waitlist if full (skip payment mode)

## Webhook Configuration

Configure your payment gateway webhooks to point to:
- **Unified Handler**: `/api/webhooks/unified`

The system automatically detects the payment gateway and processes accordingly.

### Webhook Events Handled

**Stripe**:
- `payment_intent.succeeded` → Confirms appointment
- `payment_intent.payment_failed` → Cancels tentative booking

**Razorpay**:
- `payment.captured` → Confirms appointment  
- `payment.failed` → Cancels tentative booking

## Transaction Safety

The system uses Prisma transactions to ensure data consistency:

1. **Atomic Operations**: All database changes in single transaction
2. **Automatic Rollback**: On any failure, all changes are reverted
3. **Slot Locking**: Prevents double-booking
4. **Tentative Bookings**: Slots marked tentative until payment confirmed

## Migration from Legacy Routes ✅ COMPLETED

### Legacy Routes Removed

The following legacy routes have been **REMOVED** from the codebase:

- ✅ **REMOVED**: `/api/events/*/book`
- ✅ **REMOVED**: `/api/register/*`
- ✅ **REMOVED**: `/api/checkout/consultation/*`
- ✅ **REMOVED**: `/api/checkout/subscription/*`
- ✅ **REMOVED**: `/api/checkout/webinar/*`
- ✅ **REMOVED**: `/api/checkout/class/*`
- ✅ **REMOVED**: `/api/webhooks/stripe`
- ✅ **REMOVED**: `/api/webhooks/razorpay`
- ✅ **REMOVED**: `/api/webhooks/xflow`
- ✅ **REMOVED**: `/api/webhooks/lemon-squeezy`
- ✅ **REMOVED**: `/api/webhooks/payment`
- ✅ **REMOVED**: `/api/payments/*`

### Frontend Migration Completed

All frontend checkout pages have been updated to use the unified system:

- ✅ `app/checkout/plans/consultation/[planId]/page.tsx`
- ✅ `app/checkout/plans/subscription/[planId]/page.tsx`
- ✅ `app/checkout/plans/webinar/[webinarPlanId]/page.tsx`
- ✅ `app/checkout/plans/class/[classPlanId]/page.tsx`
- ✅ `app/checkout/events/webinar/[webinarId]/page.tsx`
- ✅ `app/checkout/events/class/[classId]/page.tsx`

### Migration Example

All checkout flows now use the unified endpoint:

```typescript
// Unified approach for all appointment types
const response = await fetch('/api/checkout', {
  method: 'POST',
  body: JSON.stringify({
    type: 'consultation', // or 'subscription', 'webinar', 'class'
    consultationPlanId: 'plan_123',
    slotStartTimeInUTC: '2024-01-15T10:00:00Z',
    slotEndTimeInUTC: '2024-01-15T11:00:00Z',
    paymentGateway: 'STRIPE'
  })
});
```

## Error Handling

The system provides comprehensive error handling:

- **Validation Errors**: Schema validation with detailed messages
- **Business Logic Errors**: Slot conflicts, capacity limits, etc.
- **Payment Errors**: Gateway-specific error handling
- **Transaction Errors**: Automatic rollback with error reporting

## Testing

### Skip Payment Mode

Set `SKIP_PAYMENT=true` to test booking flow without actual payments:

```typescript
const result = await checkoutAction({
  appointmentType: "WEBINAR",
  planId: "webinar_plan_123",
  eventId: "webinar_456",
  paymentGateway: "STRIPE"
});

// Result will have skipPayment: true
// Appointment is immediately confirmed
```

### Waitlist Testing

For webinars/classes at capacity with skip payment:

```typescript
// If webinar is full
const result = await checkoutAction({
  appointmentType: "WEBINAR",
  planId: "webinar_plan_123", 
  eventId: "full_webinar_456",
  paymentGateway: "STRIPE"
});

// Result.error: "Webinar is full. Added to waitlist."
```

## Schema Updates

The existing schema supports the unified system. No migrations required.

Key relationships:
- `Payment.appointmentId` → `Appointment.id`
- `Payment.discountCodeId` → `DiscountCode.id` 
- Appointment types handled via discriminated union

## Benefits

1. **Simplified Integration**: Single API for all appointment types
2. **Consistent Behavior**: Unified error handling and responses
3. **Better Testing**: Skip payment mode for development
4. **Transaction Safety**: Atomic operations with rollback
5. **Maintainability**: Single codebase vs multiple routes
6. **Type Safety**: Strong TypeScript typing throughout
7. **Enhanced Payment Library**: Uses comprehensive `lib/payment.ts` with unified interfaces for all payment gateways 