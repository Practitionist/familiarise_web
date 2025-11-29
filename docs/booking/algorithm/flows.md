📋 ALL BOOKING FLOWS BY TYPE

!!! Pending Tasks:

1. We need to extend the flows and subscription model to include the new bookingSource field
2. We need to make split the pricing toggle to have ConsultationPricingToggle and SubscriptionPricingToggle(Need by scheduling period[startDate, endDate] am not sure how to handle this ) components
3. We later to extend the flows to handle refunds,rescheduling,cancellation,rebooking,waitlist,etc. [need to append to this document for this]

---

1. CONSULTATIONS (1-on-1)

Flow A: Direct Checkout ✅ bookingSource: DIRECT_CHECKOUT

User Journey:

1. Consultee browses consultant's consultation plans
2. Consultee selects a time slot from consultant's availability
3. Consultee enters payment details and pays
4. Backend creates:
   - Consultation with bookingSource: DIRECT_CHECKOUT + requestStatus: PENDING
   - Appointment with isTentative: true slot

5. Payment webhook confirms → requestStatus changes to APPROVED + isTentative:
   false

Code Location: utils/payments.ts line 403-456 (handleConsultationCheckout)

Flow B: Request-Based ✅ bookingSource: REQUEST_SUBMITTED

User Journey:

1. Consultee browses consultant's consultation plans
2. Consultee submits a request with preferred time slots (via
   /api/slots/request-for-approval)
3. Backend creates:
   - Consultation with bookingSource: REQUEST_SUBMITTED (needs to be added) +

requestStatus: PENDING - Appointment with isTentative: true slot 4. Consultant reviews request in dashboard 5. Consultant approves/rejects → if approved, requestStatus: APPROVED +
isTentative: false

Code Location: /app/api/slots/request-for-approval/route.ts line 117-163

---

2. SUBSCRIPTIONS (Recurring sessions over months)

Flow A: Direct Checkout ✅ bookingSource: DIRECT_CHECKOUT (needs field)

User Journey:

1. Consultee browses consultant's subscription plans
2. Consultee selects scheduling period and pays
3. Backend creates:
   - Subscription with bookingSource: DIRECT_CHECKOUT + requestStatus: PENDING
   - Appointment with isTentative: true slot for first session

4. Payment webhook confirms → requestStatus: APPROVED + isTentative: false

Code Location: utils/payments.ts line 458-519 (handleSubscriptionCheckout)

Flow B: Request-Based ✅ bookingSource: REQUEST_SUBMITTED (needs field)

User Journey:

1. Consultee submits subscription request with scheduling preferences
2. Backend creates:
   - Subscription with bookingSource: REQUEST_SUBMITTED + requestStatus: PENDING
3. Consultant reviews and approves
4. System auto-generates appointments for all sessions in the subscription
   period

Code Location: /app/api/events/subscriptions/route.ts line 102-234 (PATCH
endpoint shows approval flow)

Note: I don't see a clear API for consultees to submit subscription requests
yet - this might be TODO or done through a different flow.

---

3. WEBINARS (Many-to-many, single event)

Flow A: Direct Enrollment ✅ NO bookingSource FIELD NEEDED

User Journey:

1. Consultant creates webinar with fixed schedule (via
   /app/api/events/webinars/route.ts POST)
2. Consultees enroll by paying (via checkout flow)
3. Backend:
   - Reuses existing Appointment for the webinar
   - Adds consultee to SlotOfAppointment.user array
   - If full → adds to Waitlist

Code Location: utils/payments.ts line 521-591 (handleWebinarCheckout)

Why no request-based flow?

Webinars have consultant-set schedules. Users either:

- Enroll if spots available
- Join waitlist if full
- Cannot request custom times

---

4. CLASSES (Many-to-many, recurring over months)

Flow A: Direct Enrollment ✅ NO bookingSource FIELD NEEDED

User Journey:

1. Consultant creates class with fixed schedule (via
   /app/api/events/classes/crud-with-plan/route.ts)
2. Consultees enroll by paying (via checkout flow)
3. Backend:
   - Creates new Appointment for this consultee
   - Links to existing Class
   - If full → adds to Waitlist

Code Location: utils/payments.ts line 593-659 (handleClassCheckout)

Why no request-based flow?

Classes have fixed curricula and schedules. Users either:

- Enroll if spots available
- Join waitlist if full
- Cannot request custom times

---

🎯 SUMMARY: Which Models Need bookingSource?

| Model        | Needs `bookingSource`? | Reason                                           |
| ------------ | :--------------------: | ------------------------------------------------ |
| Consultation |       ✅ **YES**       | Has both direct checkout and request-based flows |
| Subscription |       ✅ **YES**       | Has both direct checkout and request-based flows |
| Webinar      |       ❌ **NO**        | Only direct enrollment (no request-based flow)   |
| Class        |       ❌ **NO**        | Only direct enrollment (no request-based flow)   |

---

📝 SCHEMA RECOMMENDATIONS

Add bookingSource to Consultation ✅ (You already did this!)

model Consultation {
// ... other fields
bookingSource BookingSource @default(REQUEST_SUBMITTED)
// ... other fields
}

Add bookingSource to Subscription ⚠️ (Recommended)

model Subscription {
// ... other fields
bookingSource BookingSource @default(REQUEST_SUBMITTED)
// ... other fields
}

Don't add to Webinar/Class ✅ (Correct - they don't need it)

---

Would you like me to proceed with:

1. Adding @default(REQUEST_SUBMITTED) to Consultation.bookingSource
2. Adding bookingSource field to Subscription model
3. Running migration
4. Updating all code references to use BookingSource enum instead of
   directlyBooked?
