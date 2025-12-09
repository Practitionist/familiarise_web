# Gift Consultations

## Overview

Allow users to purchase consultations as gifts for others. The gift recipient receives a voucher code or direct booking link to redeem their session with the specified consultant.

### Value Proposition

- **New Revenue Stream**: Tap into gift-giving occasions
- **User Acquisition**: Gift recipients become new users
- **Premium Positioning**: Consultation as a thoughtful gift
- **Viral Growth**: Recipients may become paying customers

---

## User Stories

### Gift Givers

- As a user, I want to buy a consultation as a gift for someone
- As a user, I want to add a personal message to the gift
- As a user, I want to choose when the gift is delivered
- As a user, I want to receive confirmation when the gift is redeemed

### Gift Recipients

- As a recipient, I want to receive a beautifully presented gift notification
- As a recipient, I want to easily redeem my gift session
- As a recipient, I want to book at a time that works for me
- As a recipient, I want to see who sent the gift

### Consultants

- As a consultant, I want to know when a session is a gift
- As a consultant, I want to provide a great experience for gift recipients

---

## Technical Architecture

### Database Schema

**Option A: Extend Payment model (Minimal change)**

```prisma
model Payment {
  // Existing fields...

  // NEW: Gift fields
  isGift            Boolean @default(false)
  giftRecipientEmail String?
  giftRecipientName  String?
  giftMessage        String? @db.Text
  giftDeliveryDate   DateTime?
  giftCode           String? @unique
  giftRedeemedAt     DateTime?
  giftRedeemedBy     String?  // User ID who redeemed
}
```

**Option B: Separate GiftVoucher model (More flexibility)**

```prisma
model GiftVoucher {
  id                String @id @default(cuid())

  // Purchase info
  purchasedBy       User @relation("GiftPurchaser", fields: [purchasedById], references: [id])
  purchasedById     String
  payment           Payment @relation(fields: [paymentId], references: [id])
  paymentId         String @unique

  // Gift details
  code              String @unique
  recipientEmail    String
  recipientName     String?
  message           String? @db.Text
  deliveryDate      DateTime?

  // What's being gifted
  consultantProfile ConsultantProfile @relation(fields: [consultantProfileId], references: [id])
  consultantProfileId String
  consultationPlan  ConsultationPlan @relation(fields: [consultationPlanId], references: [id])
  consultationPlanId String

  // Redemption
  status            GiftStatus @default(PENDING)
  redeemedAt        DateTime?
  redeemedBy        User? @relation("GiftRedeemer", fields: [redeemedById], references: [id])
  redeemedById      String?
  appointmentId     String?   // Created appointment

  // Expiry
  expiresAt         DateTime  // Default: 1 year from purchase
  reminderSentAt    DateTime? // When we reminded about expiring gift

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([code])
  @@index([recipientEmail])
  @@index([status])
}

enum GiftStatus {
  PENDING           // Purchased, not yet delivered
  DELIVERED         // Email sent to recipient
  REDEEMED          // Successfully booked
  EXPIRED           // Past expiry date
  REFUNDED          // Gift was refunded
}
```

**Recommendation**: Option B provides better tracking and flexibility.

### Gift Purchase & Redemption Flow

```
┌─────────────────────────────────────────────────────────┐
│              GIFT PURCHASE FLOW                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. GIVER PURCHASES                                     │
│     ─────────────────                                   │
│     - Select "Gift This" on consultant profile          │
│     - Enter recipient email and name                    │
│     - Add personal message                              │
│     - Choose delivery date (now or scheduled)           │
│     - Complete payment                                  │
│                                                         │
│  2. GIFT CREATED                                        │
│     ────────────                                        │
│     - Generate unique gift code (e.g., GIFT-ABCD-1234) │
│     - Create GiftVoucher record                        │
│     - Schedule delivery email                          │
│                                                         │
│  3. GIFT DELIVERED                                      │
│     ──────────────                                      │
│     - Send beautiful email to recipient                │
│     - Include: gift code, consultant info, message     │
│     - Status → DELIVERED                               │
│                                                         │
│  4. RECIPIENT REDEEMS                                   │
│     ─────────────────                                   │
│     - Click redemption link or enter code              │
│     - Create account (if new user)                     │
│     - Select available time slot                       │
│     - No payment required (already paid)               │
│                                                         │
│  5. SESSION BOOKED                                      │
│     ──────────────                                      │
│     - Create appointment (linked to gift)              │
│     - Notify consultant about gift session             │
│     - Notify giver that gift was redeemed              │
│     - Status → REDEEMED                                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
// lib/gifts/service.ts

export async function createGiftVoucher(
  purchaserId: string,
  paymentId: string,
  giftData: {
    recipientEmail: string;
    recipientName?: string;
    message?: string;
    deliveryDate?: Date;
    consultantProfileId: string;
    consultationPlanId: string;
  },
): Promise<GiftVoucher> {
  const code = generateGiftCode();
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 year validity

  const voucher = await prisma.giftVoucher.create({
    data: {
      purchasedById: purchaserId,
      paymentId,
      code,
      recipientEmail: giftData.recipientEmail,
      recipientName: giftData.recipientName,
      message: giftData.message,
      deliveryDate: giftData.deliveryDate || new Date(),
      consultantProfileId: giftData.consultantProfileId,
      consultationPlanId: giftData.consultationPlanId,
      status:
        giftData.deliveryDate && giftData.deliveryDate > new Date()
          ? "PENDING"
          : "PENDING", // Will be DELIVERED after email sent
      expiresAt,
    },
  });

  // Schedule or send delivery
  if (!giftData.deliveryDate || giftData.deliveryDate <= new Date()) {
    await deliverGiftEmail(voucher.id);
  } else {
    await scheduleGiftDelivery(voucher.id, giftData.deliveryDate);
  }

  return voucher;
}

function generateGiftCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Exclude ambiguous chars
  const segments = [4, 4].map(() =>
    Array.from(
      { length: 4 },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join(""),
  );
  return `GIFT-${segments.join("-")}`;
}

export async function deliverGiftEmail(voucherId: string): Promise<void> {
  const voucher = await prisma.giftVoucher.findUnique({
    where: { id: voucherId },
    include: {
      purchasedBy: { select: { name: true } },
      consultantProfile: {
        include: { user: { select: { name: true, image: true } } },
      },
      consultationPlan: true,
    },
  });

  if (!voucher || voucher.status !== "PENDING") return;

  // Send beautiful gift email
  await sendEmail({
    to: voucher.recipientEmail,
    subject: `🎁 You've received a gift from ${voucher.purchasedBy.name}!`,
    template: "gift-received",
    data: {
      recipientName: voucher.recipientName,
      senderName: voucher.purchasedBy.name,
      message: voucher.message,
      consultantName: voucher.consultantProfile.user.name,
      consultantImage: voucher.consultantProfile.user.image,
      planName: voucher.consultationPlan.title,
      planDuration: voucher.consultationPlan.duration,
      giftCode: voucher.code,
      redemptionUrl: `${process.env.NEXT_PUBLIC_URL}/gift/redeem/${voucher.code}`,
      expiresAt: voucher.expiresAt,
    },
  });

  await prisma.giftVoucher.update({
    where: { id: voucherId },
    data: { status: "DELIVERED" },
  });
}

export async function redeemGift(
  code: string,
  redeemerUserId: string,
  slotId: string,
): Promise<{ appointment: Appointment; voucher: GiftVoucher }> {
  const voucher = await prisma.giftVoucher.findUnique({
    where: { code },
    include: {
      consultationPlan: true,
      purchasedBy: { select: { id: true, name: true, email: true } },
    },
  });

  // Validations
  if (!voucher) throw new Error("Gift code not found");
  if (voucher.status === "REDEEMED") throw new Error("Gift already redeemed");
  if (voucher.status === "EXPIRED") throw new Error("Gift has expired");
  if (voucher.status === "REFUNDED") throw new Error("Gift was refunded");
  if (new Date() > voucher.expiresAt) {
    await prisma.giftVoucher.update({
      where: { id: voucher.id },
      data: { status: "EXPIRED" },
    });
    throw new Error("Gift has expired");
  }

  // Create appointment
  const result = await prisma.$transaction(async (tx) => {
    // Create consultation request
    const consulteeProfile = await tx.consulteeProfile.findUnique({
      where: { userId: redeemerUserId },
    });

    const consultation = await tx.consultation.create({
      data: {
        consultationPlanId: voucher.consultationPlanId,
        consulteeProfileId: consulteeProfile!.id,
        requestStatus: "SCHEDULED",
        bookingSource: "GIFT_REDEMPTION",
      },
    });

    const appointment = await tx.appointment.create({
      data: {
        appointmentType: "CONSULTATION",
        status: "SCHEDULED",
        consultationId: consultation.id,
      },
    });

    await tx.slotOfAppointment.update({
      where: { id: slotId },
      data: { appointmentId: appointment.id, userId: redeemerUserId },
    });

    // Update voucher
    await tx.giftVoucher.update({
      where: { id: voucher.id },
      data: {
        status: "REDEEMED",
        redeemedAt: new Date(),
        redeemedById: redeemerUserId,
        appointmentId: appointment.id,
      },
    });

    return appointment;
  });

  // Notify giver
  await sendEmail({
    to: voucher.purchasedBy.email,
    subject: "Your gift has been redeemed! 🎉",
    template: "gift-redeemed",
    data: {
      recipientName: voucher.recipientName,
      consultantName: voucher.consultantProfile?.user?.name,
      appointmentDate: result.slotOfAppointments[0]?.startTime,
    },
  });

  return { appointment: result, voucher };
}
```

### API Endpoints

```
POST /api/gifts/purchase
  Body: {
    consultantProfileId,
    consultationPlanId,
    recipientEmail,
    recipientName?,
    message?,
    deliveryDate?,
    paymentMethod
  }
  Returns: { giftVoucher, paymentUrl }

GET /api/gifts/[code]
  Returns: Gift voucher details (for redemption page)

POST /api/gifts/[code]/redeem
  Body: { slotId }
  Auth: Must be logged in
  Returns: { appointment }

GET /api/gifts/sent
  Returns: Gifts purchased by current user

GET /api/gifts/received
  Returns: Gifts sent to current user's email

POST /api/admin/gifts/refund/[id]
  Action: Refund gift and mark as refunded
```

---

## UI/UX Design

### Gift Purchase Button (Consultant Profile)

```
┌─────────────────────────────────────────────────────────┐
│  Priya Sharma                                           │
│  Marketing Strategist | ⭐ 4.9                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1-on-1 Consultation                                    │
│  60 minutes • ₹2,000                                    │
│                                                         │
│  [Book for Yourself]    [🎁 Gift This]                 │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Gift Purchase Flow

```
┌─────────────────────────────────────────────────────────┐
│  🎁 Gift a Consultation                                 │
│  with Priya Sharma                                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Step 1: Recipient Details                              │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Recipient's Email *                                    │
│  ┌─────────────────────────────────────────────────────┐│
│  │ friend@example.com                                  ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Recipient's Name                                       │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Sarah                                               ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Step 2: Personal Message                               │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Hey Sarah! 🎉                                       ││
│  │                                                     ││
│  │ I know you've been looking for marketing advice    ││
│  │ for your startup. Priya is amazing - I've had      ││
│  │ several sessions with her. Enjoy!                  ││
│  │                                                     ││
│  │ Happy Birthday! 🎂                                 ││
│  │                                                     ││
│  │ - John                                             ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Step 3: Delivery                                       │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  When should we send the gift?                         │
│  ○ Send immediately                                    │
│  ● Schedule for later: [Dec 15, 2024] [9:00 AM]       │
│                                                         │
│  Step 4: Review                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Gift: 1-on-1 Consultation with Priya Sharma           │
│  Duration: 60 minutes                                   │
│  Valid for: 1 year                                      │
│  Total: ₹2,000                                         │
│                                                         │
│  [Complete Purchase - ₹2,000]                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Gift Received Email

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│               🎁                                        │
│                                                         │
│  You've received a gift!                               │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  John has gifted you a consultation session            │
│  with Priya Sharma                                      │
│                                                         │
│       [Priya's Photo]                                   │
│       Priya Sharma                                      │
│       Marketing Strategist                              │
│       ⭐ 4.9 (47 reviews)                              │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  John's message:                                        │
│                                                         │
│  "Hey Sarah! 🎉                                        │
│                                                         │
│   I know you've been looking for marketing advice      │
│   for your startup. Priya is amazing! Enjoy!           │
│                                                         │
│   Happy Birthday! 🎂 - John"                          │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Session: 60-minute 1-on-1 Consultation               │
│  Gift Code: GIFT-ABCD-1234                            │
│  Valid Until: December 9, 2025                         │
│                                                         │
│         [Redeem Your Gift]                             │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Not Sarah? Please forward this email to the           │
│  intended recipient.                                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Gift Redemption Page

```
┌─────────────────────────────────────────────────────────┐
│  🎁 Redeem Your Gift                                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  You're booking a gifted session with:                 │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │    [Photo]  Priya Sharma                           ││
│  │             Marketing Strategist                    ││
│  │             60-minute Consultation                  ││
│  │                                                     ││
│  │    Gifted by: John                                 ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Select a time:                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  December 2024              [< Prev]  [Next >]         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ [Calendar with available slots]                    ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Selected: Thursday, Dec 12 at 3:00 PM                 │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Payment Summary                                     ││
│  │                                                     ││
│  │ 60-min Consultation        ₹2,000                  ││
│  │ Gift Applied              -₹2,000                  ││
│  │ ───────────────────────────────────                ││
│  │ Total Due                      ₹0                  ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  [Confirm Booking]                                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: Basic Gift Purchase

1. Add "Gift This" button on consultant profile
2. Gift purchase flow with recipient details
3. Store gift in Payment metadata (Option A)
4. Send gift email immediately

### Phase 2: Redemption Flow

1. Build redemption page
2. Create account for new users
3. Book without payment
4. Notify giver on redemption

### Phase 3: Gift Management

1. My Gifts page (sent/received)
2. Scheduled delivery
3. Expiry reminders
4. Gift refunds

### Phase 4: Polish

1. Beautiful gift email design
2. Gift card preview for giver
3. Gift wrapping animation
4. Social sharing

---

## Dependencies

### Depends On

- Payment system
- Booking flow
- Email service

### Features That Depend On This

- **Package Bundles** - Can gift packages too
- **Referral Program** - Gifts could count as referrals

---

## Edge Cases

1. **Recipient already has account**: Link gift to existing account
2. **Email bounce**: Notify giver, allow resend
3. **Consultant deactivates**: Option to transfer or refund
4. **Gift expires**: Send reminder emails (30 days, 7 days before)
5. **Giver requests refund**: Only if unredeemed
