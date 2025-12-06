# Checkout Pages Modernization Guide

> **Routes**: `/checkout/plans/consultation/[planId]`, `/checkout/plans/subscription/[planId]`, etc.
> **Priority**: P0 - Critical (Revenue path)
> **Current Issues**: Complex layout, too many payment options visible, no progress indicator

---

## Current State Analysis

### What's Working
- Multiple payment gateway support (Stripe, Razorpay)
- Discount code functionality
- Consultation details display
- Mock payment for development

### Critical Issues
1. **No visual hierarchy** - Information overload
2. **All gateways shown** - Confusing for users
3. **Missing progress indicator** - User doesn't know where they are
4. **Poor mobile experience** - Two-column layout doesn't stack well
5. **No order summary** - Pricing breakdown unclear
6. **Mock payment visible** - Should be dev-only
7. **Weak trust signals** - Missing security badges

---

## Redesigned Checkout Flow

### Step-by-Step Flow

```
STEP 1: Review Details
    ↓
STEP 2: Select Payment Method
    ↓
STEP 3: Complete Payment
    ↓
STEP 4: Confirmation
```

### Progress Indicator

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ●────────────────●────────────────○────────────────○               │
│  Review          Payment           Pay              Done             │
│  Details         Method                                              │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Desktop Layout (Step 1: Review)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← Back to Expert Profile                                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ●───────────────●───────────────○───────────────○                  │
│  Review         Payment          Pay            Done                 │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌───────────────────────────────────┐  ┌─────────────────────────┐ │
│  │                                    │  │                         │ │
│  │  BOOKING DETAILS                   │  │  ORDER SUMMARY          │ │
│  │                                    │  │                         │ │
│  │  ┌────────────────────────────┐   │  │  ─────────────────────  │ │
│  │  │                            │   │  │                         │ │
│  │  │  1:1 CONSULTATION          │   │  │  1:1 Consultation       │ │
│  │  │  with Sarah Chen           │   │  │  60 minutes      $150   │ │
│  │  │                            │   │  │                         │ │
│  │  │  📅 Wed, Jan 8, 2025      │   │  │  ─────────────────────  │ │
│  │  │  ⏰ 2:00 PM - 3:00 PM PST │   │  │                         │ │
│  │  │  ⏱️ 60 minutes            │   │  │  Subtotal        $150   │ │
│  │  │                            │   │  │  Platform fee     $15   │ │
│  │  │  [Edit Booking]            │   │  │  Tax (10%)        $15   │ │
│  │  │                            │   │  │                         │ │
│  │  └────────────────────────────┘   │  │  ─────────────────────  │ │
│  │                                    │  │                         │ │
│  │  ─────────────────────────────    │  │  Total           $180   │ │
│  │                                    │  │                         │ │
│  │  EXPERT                            │  │  ─────────────────────  │ │
│  │                                    │  │                         │ │
│  │  ┌────────────────────────────┐   │  │  ┌─────────────────────┐│ │
│  │  │ 👤 Sarah Chen              │   │  │  │ Have a promo code? ││ │
│  │  │ Product Lead @ Google      │   │  │  │                     ││ │
│  │  │ ★ 4.9 (127 reviews)       │   │  │  │ [CODE    ] [Apply]  ││ │
│  │  │                            │   │  │  └─────────────────────┘│ │
│  │  │ 450+ sessions completed   │   │  │                         │ │
│  │  └────────────────────────────┘   │  │  ─────────────────────  │ │
│  │                                    │  │                         │ │
│  │  ─────────────────────────────    │  │  ┌─────────────────────┐│ │
│  │                                    │  │  │                     ││ │
│  │  WHAT'S INCLUDED                   │  │  │  Continue to       ││ │
│  │                                    │  │  │  Payment →          ││ │
│  │  ✓ 60-minute video call           │  │  │                     ││ │
│  │  ✓ Screen sharing                  │  │  └─────────────────────┘│ │
│  │  ✓ Session recording               │  │                         │ │
│  │  ✓ Follow-up resources            │  │  🔒 Secure checkout     │ │
│  │  ✓ 24h free cancellation          │  │  💳 Powered by Stripe   │ │
│  │                                    │  │                         │ │
│  └───────────────────────────────────┘  └─────────────────────────┘ │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 2: Payment Method Selection

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← Back                                                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ○───────────────●───────────────○───────────────○                  │
│  Review         Payment          Pay            Done                 │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌───────────────────────────────────┐  ┌─────────────────────────┐ │
│  │                                    │  │                         │ │
│  │  SELECT PAYMENT METHOD             │  │  ORDER SUMMARY          │ │
│  │                                    │  │                         │ │
│  │  ┌────────────────────────────┐   │  │  ─────────────────────  │ │
│  │  │ ○  CREDIT / DEBIT CARD     │   │  │                         │ │
│  │  │    Visa, Mastercard, Amex  │   │  │  1:1 with Sarah Chen    │ │
│  │  │    [VISA] [MC] [AMEX]      │   │  │  Wed, Jan 8, 2:00 PM    │ │
│  │  │                            │   │  │                         │ │
│  │  │    Powered by Stripe       │   │  │  ─────────────────────  │ │
│  │  └────────────────────────────┘   │  │                         │ │
│  │                                    │  │  Subtotal        $150   │ │
│  │  ┌────────────────────────────┐   │  │  Discount       -$15    │ │
│  │  │ ○  UPI / NET BANKING       │   │  │  Platform fee    $15    │ │
│  │  │    India payments          │   │  │  Tax              $0    │ │
│  │  │    [UPI] [Banks]           │   │  │                         │ │
│  │  │                            │   │  │  ─────────────────────  │ │
│  │  │    Powered by Razorpay     │   │  │                         │ │
│  │  └────────────────────────────┘   │  │  Total           $150   │ │
│  │                                    │  │                         │ │
│  │  ─────────────────────────────    │  │  Applied: FIRST10 ✓     │ │
│  │                                    │  │                         │ │
│  │  BILLING DETAILS                   │  │  ─────────────────────  │ │
│  │                                    │  │                         │ │
│  │  Email                             │  │  ┌─────────────────────┐│ │
│  │  ┌────────────────────────────┐   │  │  │                     ││ │
│  │  │ alex.martinez@email.com    │   │  │  │  Pay $150 →         ││ │
│  │  └────────────────────────────┘   │  │  │                     ││ │
│  │                                    │  │  └─────────────────────┘│ │
│  │  ☑ Send receipt to this email    │  │                         │ │
│  │  ☑ Save payment method           │  │  🔒 256-bit encryption  │ │
│  │                                    │  │  💳 PCI DSS compliant   │ │
│  │                                    │  │                         │ │
│  └───────────────────────────────────┘  └─────────────────────────┘ │
│                                                                      │
│  TRUST SIGNALS                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  🔒 Secure Payment  •  💳 PCI Compliant  •  ↩️ Money Back     ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 3: Payment Processing

### Stripe Inline Form

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ○───────────────○───────────────●───────────────○                  │
│  Review         Payment          Pay            Done                 │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                                                                │  │
│  │  COMPLETE YOUR PAYMENT                                         │  │
│  │                                                                │  │
│  │  Card Number                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │ 4242 4242 4242 4242                          [VISA]    │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │                                                                │  │
│  │  ┌─────────────────────┐  ┌─────────────────────────────────┐ │  │
│  │  │ Expiry: MM/YY       │  │ CVC: •••                        │ │  │
│  │  │ 12/26               │  │ 123                             │ │  │
│  │  └─────────────────────┘  └─────────────────────────────────┘ │  │
│  │                                                                │  │
│  │  Name on Card                                                  │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │ Alex Martinez                                           │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │                                                                │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │                                                          │  │  │
│  │  │                   Pay $150.00                            │  │  │
│  │  │                                                          │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │                                                                │  │
│  │  By completing this purchase you agree to our Terms of       │  │
│  │  Service and acknowledge our Privacy Policy.                 │  │
│  │                                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                                                                │  │
│  │  BOOKING SUMMARY                                               │  │
│  │  ─────────────────────────────────────────────────────────    │  │
│  │  1:1 Consultation with Sarah Chen                             │  │
│  │  Wednesday, January 8, 2025 at 2:00 PM PST                    │  │
│  │  60 minutes • Product Strategy                                │  │
│  │                                                                │  │
│  │  Total: $150.00                                               │  │
│  │                                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 4: Confirmation

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ●───────────────●───────────────●───────────────●                  │
│  Review         Payment          Pay            Done                 │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                                                                │  │
│  │                          ✓                                    │  │
│  │                                                                │  │
│  │              Booking Confirmed!                               │  │
│  │                                                                │  │
│  │       Your session with Sarah Chen is scheduled               │  │
│  │                                                                │  │
│  │  ─────────────────────────────────────────────────────────   │  │
│  │                                                                │  │
│  │  📅 Wednesday, January 8, 2025                                │  │
│  │  ⏰ 2:00 PM - 3:00 PM PST                                    │  │
│  │  🎥 Video call link sent to your email                       │  │
│  │                                                                │  │
│  │  ─────────────────────────────────────────────────────────   │  │
│  │                                                                │  │
│  │  📧 Confirmation email sent to                                │  │
│  │     alex.martinez@email.com                                   │  │
│  │                                                                │  │
│  │  📆 Added to your calendar                                    │  │
│  │                                                                │  │
│  │  ─────────────────────────────────────────────────────────   │  │
│  │                                                                │  │
│  │  WHAT'S NEXT                                                   │  │
│  │                                                                │  │
│  │  • Check your email for joining instructions                  │  │
│  │  • Prepare any questions or topics you'd like to discuss     │  │
│  │  • Join 5 minutes early to test your audio/video             │  │
│  │                                                                │  │
│  │  ─────────────────────────────────────────────────────────   │  │
│  │                                                                │  │
│  │  ┌─────────────────────┐  ┌─────────────────────────────────┐ │  │
│  │  │  Add to Calendar    │  │  Go to Dashboard               │ │  │
│  │  └─────────────────────┘  └─────────────────────────────────┘ │  │
│  │                                                                │  │
│  │  ─────────────────────────────────────────────────────────   │  │
│  │                                                                │  │
│  │  Order #: FAM-2025-0108-A3X7                                  │  │
│  │  Receipt sent to your email                                   │  │
│  │                                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Mobile Checkout

```
┌─────────────────────────────┐
│ ← Checkout                  │
├─────────────────────────────┤
│                             │
│  ●─────●─────○─────○        │
│  Review  Pay  ...   Done    │
│                             │
├─────────────────────────────┤
│                             │
│  BOOKING DETAILS            │
│  ─────────────────────────  │
│                             │
│  1:1 Consultation           │
│  with Sarah Chen            │
│                             │
│  📅 Wed, Jan 8, 2025       │
│  ⏰ 2:00 PM - 3:00 PM PST  │
│  ⏱️ 60 minutes             │
│                             │
│  ─────────────────────────  │
│                             │
│  INCLUDED                   │
│  ✓ Video call               │
│  ✓ Screen sharing           │
│  ✓ Recording                │
│  ✓ 24h cancellation         │
│                             │
│  ─────────────────────────  │
│                             │
│  PROMO CODE                 │
│  ┌────────────┐ ┌────────┐  │
│  │ FIRST10    │ │ Apply  │  │
│  └────────────┘ └────────┘  │
│                             │
├─────────────────────────────┤
│                             │
│  Subtotal           $150    │
│  Platform fee        $15    │
│  ─────────────────────────  │
│  Total              $165    │
│                             │
│  ┌─────────────────────────┐│
│  │   Continue to Payment   ││
│  └─────────────────────────┘│
│                             │
│  🔒 Secure • 💳 Stripe     │
│                             │
└─────────────────────────────┘
```

---

## Error States

### Payment Failed

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                                                                │  │
│  │                          ✗                                    │  │
│  │                                                                │  │
│  │              Payment Failed                                   │  │
│  │                                                                │  │
│  │       Your card was declined. Please try again               │  │
│  │       or use a different payment method.                      │  │
│  │                                                                │  │
│  │  ─────────────────────────────────────────────────────────   │  │
│  │                                                                │  │
│  │  Error: Card declined - insufficient funds                    │  │
│  │                                                                │  │
│  │  ┌─────────────────────┐  ┌─────────────────────────────────┐ │  │
│  │  │  Try Another Card   │  │  Use Different Method           │ │  │
│  │  └─────────────────────┘  └─────────────────────────────────┘ │  │
│  │                                                                │  │
│  │  Need help? Contact support@familiarise.com                   │  │
│  │                                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Slot No Longer Available

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                                                                │  │
│  │                          ⚠️                                   │  │
│  │                                                                │  │
│  │           Slot No Longer Available                            │  │
│  │                                                                │  │
│  │   The time slot you selected has been booked by               │  │
│  │   someone else. Please choose a different time.               │  │
│  │                                                                │  │
│  │  ─────────────────────────────────────────────────────────   │  │
│  │                                                                │  │
│  │   NEXT AVAILABLE SLOTS                                        │  │
│  │                                                                │  │
│  │   ┌─────────────────────────────────────────────────────────┐ │  │
│  │   │ Wed, Jan 8 at 4:00 PM PST              [Select]         │ │  │
│  │   │ Thu, Jan 9 at 10:00 AM PST             [Select]         │ │  │
│  │   │ Thu, Jan 9 at 2:00 PM PST              [Select]         │ │  │
│  │   └─────────────────────────────────────────────────────────┘ │  │
│  │                                                                │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │              View Full Calendar                          │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │                                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Trust Signals & Security

### Security Badges Footer

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │ 🔒 SSL  │ │ PCI DSS │ │ GDPR    │ │ 256-bit │ │ Money   │       │
│  │ Secure  │ │ Level 1 │ │ Comply  │ │ Encrypt │ │ Back    │       │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
│                                                                      │
│  Your payment information is encrypted and secure.                   │
│  We never store your full card details.                              │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Checklist

### Phase 1: Flow
- [ ] Implement step-by-step checkout
- [ ] Add progress indicator
- [ ] Create unified order summary
- [ ] Hide irrelevant payment methods

### Phase 2: UI
- [ ] Redesign review step
- [ ] Improve payment method selection
- [ ] Create inline payment forms
- [ ] Design confirmation page

### Phase 3: Error Handling
- [ ] Add payment error states
- [ ] Handle slot unavailability
- [ ] Add retry mechanisms
- [ ] Improve error messages

### Phase 4: Trust & Polish
- [ ] Add security badges
- [ ] Implement trust signals
- [ ] Mobile optimization
- [ ] Add animations/transitions
- [ ] Hide mock payment in production
