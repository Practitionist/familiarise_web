# Package Bundles

## Overview

Allow consultants to create and sell consultation packages (bundles) at discounted rates. Consultees can purchase multiple sessions upfront, receiving a discount while consultants secure recurring revenue.

### Value Proposition

- **Higher LTV**: Upfront commitment increases customer lifetime value
- **Predictable Revenue**: Consultants can forecast income better
- **Better Outcomes**: Multi-session engagement leads to better results
- **Cost Savings**: Consultees save 10-20% with packages

---

## User Stories

### Consultants

- As a consultant, I want to create packages (e.g., "5 sessions for price of 4")
- As a consultant, I want to set expiration periods for packages
- As a consultant, I want to track package usage and remaining sessions
- As a consultant, I want to offer different package tiers

### Consultees

- As a consultee, I want to see available packages on consultant profiles
- As a consultee, I want to understand the savings compared to individual bookings
- As a consultee, I want to easily book sessions from my purchased package
- As a consultee, I want to see my remaining sessions and expiry date

---

## Technical Architecture

### Database Schema

**Option A: Use existing DiscountCode + custom logic (No schema change)**

```typescript
// Create a "bundle" discount code that tracks usage
// Store bundle metadata in Payment.metadata

interface BundleMetadata {
  type: "PACKAGE_BUNDLE";
  bundleId: string; // Unique bundle identifier
  totalSessions: number; // e.g., 5
  usedSessions: number; // e.g., 2
  remainingSessions: number; // e.g., 3
  originalPaymentId: string; // Payment that purchased the bundle
  consultantProfileId: string;
  consultationPlanId: string;
  expiresAt: string; // ISO date
  sessionHistory: {
    appointmentId: string;
    usedAt: string;
  }[];
}
```

**Option B: New Package model (Recommended for scale)**

```prisma
model ConsultationPackage {
  id                String   @id @default(cuid())

  // Package definition
  name              String           // "5-Session Growth Package"
  description       String?
  sessionsIncluded  Int              // 5
  pricePerSession   Int              // Discounted price per session
  totalPrice        Int              // Total package price
  regularPrice      Int              // Regular price for comparison
  savingsPercent    Float            // 20% savings
  validityDays      Int @default(90) // Package expires after 90 days

  consultationPlan  ConsultationPlan @relation(fields: [consultationPlanId], references: [id])
  consultationPlanId String

  isActive          Boolean @default(true)

  purchases         PackagePurchase[]

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([consultationPlanId])
}

model PackagePurchase {
  id                String   @id @default(cuid())

  package           ConsultationPackage @relation(fields: [packageId], references: [id])
  packageId         String

  user              User @relation(fields: [userId], references: [id])
  userId            String

  payment           Payment @relation(fields: [paymentId], references: [id])
  paymentId         String @unique

  // Usage tracking
  sessionsUsed      Int @default(0)
  sessionsRemaining Int              // Computed: package.sessionsIncluded - sessionsUsed

  status            PackageStatus @default(ACTIVE)
  purchasedAt       DateTime @default(now())
  expiresAt         DateTime
  completedAt       DateTime?        // When all sessions used

  // Session usage log
  usageLog          PackageUsage[]

  @@index([userId])
  @@index([status])
  @@index([expiresAt])
}

model PackageUsage {
  id                String   @id @default(cuid())

  purchase          PackagePurchase @relation(fields: [purchaseId], references: [id])
  purchaseId        String

  appointment       Appointment @relation(fields: [appointmentId], references: [id])
  appointmentId     String @unique

  usedAt            DateTime @default(now())
}

enum PackageStatus {
  ACTIVE            // Can book sessions
  COMPLETED         // All sessions used
  EXPIRED           // Validity period ended
  CANCELLED         // Refunded
}
```

**Recommendation**: For MVP, use Option A (no schema change). Migrate to Option B when package sales grow.

### Package Creation & Pricing

```typescript
// lib/packages/pricing.ts

interface PackageConfig {
  sessionsIncluded: number;
  discountPercent: number; // e.g., 20 for 20% off
  validityDays: number;
}

const PACKAGE_TEMPLATES: Record<string, PackageConfig> = {
  starter: { sessionsIncluded: 3, discountPercent: 10, validityDays: 60 },
  growth: { sessionsIncluded: 5, discountPercent: 15, validityDays: 90 },
  premium: { sessionsIncluded: 10, discountPercent: 20, validityDays: 180 },
};

export function calculatePackagePrice(
  regularSessionPrice: number,
  config: PackageConfig,
): {
  totalPrice: number;
  pricePerSession: number;
  savings: number;
  savingsPercent: number;
} {
  const regularTotal = regularSessionPrice * config.sessionsIncluded;
  const discount = regularTotal * (config.discountPercent / 100);
  const totalPrice = regularTotal - discount;
  const pricePerSession = Math.round(totalPrice / config.sessionsIncluded);

  return {
    totalPrice,
    pricePerSession,
    savings: discount,
    savingsPercent: config.discountPercent,
  };
}
```

### Package Purchase Flow

```
┌─────────────────────────────────────────────────────────┐
│                 PACKAGE PURCHASE FLOW                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. CONSULTEE SELECTS PACKAGE                           │
│     ─────────────────────────                           │
│     - View packages on consultant profile               │
│     - See savings, sessions, validity                   │
│     - Click "Buy Package"                               │
│                                                         │
│  2. CHECKOUT                                            │
│     ────────                                            │
│     - Standard payment flow                             │
│     - Full package price charged upfront                │
│     - Payment.metadata stores package info              │
│                                                         │
│  3. PACKAGE ACTIVATED                                   │
│     ─────────────────                                   │
│     - PackagePurchase record created                    │
│     - expiresAt calculated from validityDays            │
│     - User notified of purchase                         │
│                                                         │
│  4. BOOK SESSIONS FROM PACKAGE                          │
│     ───────────────────────────                         │
│     - User goes to consultant profile                   │
│     - Sees "Book from Package" option                   │
│     - No payment required at checkout                   │
│     - PackageUsage record created                       │
│     - sessionsRemaining decremented                     │
│                                                         │
│  5. PACKAGE COMPLETION / EXPIRY                         │
│     ───────────────────────────                         │
│     A) All sessions used → status: COMPLETED           │
│     B) Validity expires → status: EXPIRED              │
│        (Optionally: offer extension or partial refund)  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### API Endpoints

```
// Package Management (Consultant)
POST /api/consultants/[id]/packages
  Body: { consultationPlanId, template, customConfig? }
  Creates: New package offering

GET /api/consultants/[id]/packages
  Returns: All packages for consultant

PATCH /api/packages/[id]
  Body: { isActive, name, description }
  Updates: Package details

DELETE /api/packages/[id]
  Action: Deactivate package (soft delete)

// Package Purchase (Consultee)
GET /api/packages/[id]
  Returns: Package details with pricing

POST /api/packages/[id]/purchase
  Action: Initiate package purchase
  Returns: Payment intent / checkout URL

GET /api/users/[id]/packages
  Returns: User's purchased packages with remaining sessions

// Session Booking from Package
POST /api/packages/purchases/[purchaseId]/book
  Body: { slotId }
  Action: Book session using package credit
  Returns: Appointment details

GET /api/packages/purchases/[purchaseId]/usage
  Returns: Usage history for package
```

### Session Booking Integration

```typescript
// lib/packages/booking.ts

export async function bookFromPackage(
  purchaseId: string,
  slotId: string,
  userId: string,
): Promise<Appointment> {
  const purchase = await prisma.packagePurchase.findUnique({
    where: { id: purchaseId },
    include: { package: { include: { consultationPlan: true } } },
  });

  // Validations
  if (!purchase) throw new Error("Package purchase not found");
  if (purchase.userId !== userId) throw new Error("Unauthorized");
  if (purchase.status !== "ACTIVE") throw new Error("Package is not active");
  if (purchase.sessionsRemaining <= 0) throw new Error("No sessions remaining");
  if (new Date() > purchase.expiresAt) throw new Error("Package has expired");

  // Create appointment (no payment required)
  const appointment = await prisma.$transaction(async (tx) => {
    // Create consultation request
    const consultation = await tx.consultation.create({
      data: {
        consultationPlanId: purchase.package.consultationPlanId,
        consulteeProfileId: await getConsulteeProfileId(userId),
        status: "APPROVED_PENDING_PAYMENT", // Skip to approved
        bookingSource: "PACKAGE_BOOKING",
      },
    });

    // Create appointment
    const appointment = await tx.appointment.create({
      data: {
        appointmentType: "CONSULTATION",
        status: "SCHEDULED",
        consultationId: consultation.id,
      },
    });

    // Link slot
    await tx.slotOfAppointment.update({
      where: { id: slotId },
      data: { appointmentId: appointment.id },
    });

    // Record package usage
    await tx.packageUsage.create({
      data: {
        purchaseId,
        appointmentId: appointment.id,
      },
    });

    // Update remaining sessions
    const newRemaining = purchase.sessionsRemaining - 1;
    await tx.packagePurchase.update({
      where: { id: purchaseId },
      data: {
        sessionsUsed: { increment: 1 },
        sessionsRemaining: newRemaining,
        status: newRemaining === 0 ? "COMPLETED" : "ACTIVE",
        completedAt: newRemaining === 0 ? new Date() : null,
      },
    });

    return appointment;
  });

  return appointment;
}
```

---

## UI/UX Design

### Package Display on Consultant Profile

```
┌─────────────────────────────────────────────────────────┐
│  Book with Priya Sharma                                 │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Single Session                                         │
│  ─────────────────                                      │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 1-on-1 Strategy Consultation                        ││
│  │ 60 minutes | ₹2,000                                 ││
│  │ [Book Single Session]                               ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  📦 Save with Packages                                  │
│  ─────────────────────                                  │
│                                                         │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │  STARTER    │ │   GROWTH    │ │  PREMIUM    │       │
│  │             │ │  ⭐ POPULAR │ │             │       │
│  │  3 Sessions │ │  5 Sessions │ │ 10 Sessions │       │
│  │             │ │             │ │             │       │
│  │  ₹5,400     │ │  ₹8,500     │ │  ₹16,000    │       │
│  │  ₹1,800/ea  │ │  ₹1,700/ea  │ │  ₹1,600/ea  │       │
│  │             │ │             │ │             │       │
│  │  Save 10%   │ │  Save 15%   │ │  Save 20%   │       │
│  │  (₹600)     │ │  (₹1,500)   │ │  (₹4,000)   │       │
│  │             │ │             │ │             │       │
│  │  Valid 60d  │ │  Valid 90d  │ │  Valid 180d │       │
│  │             │ │             │ │             │       │
│  │ [Buy Now]   │ │ [Buy Now]   │ │ [Buy Now]   │       │
│  └─────────────┘ └─────────────┘ └─────────────┘       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Package Purchase Confirmation

```
┌─────────────────────────────────────────────────────────┐
│  ✓ Package Purchased!                                   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Growth Package - 5 Sessions                           │
│  with Priya Sharma                                      │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Sessions remaining: 5 of 5                          ││
│  │ Valid until: March 9, 2025                          ││
│  │ You saved: ₹1,500                                   ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  [Book Your First Session]                             │
│                                                         │
│  Or book later from your dashboard                     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### My Packages Page (`/dashboard/packages`)

```
┌─────────────────────────────────────────────────────────┐
│  My Packages                                            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Active Packages (2)                                    │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Priya Sharma - Growth Package                       ││
│  │                                                     ││
│  │ ████████░░░░░░░░░░░░  3 of 5 sessions used         ││
│  │                                                     ││
│  │ Remaining: 2 sessions                               ││
│  │ Expires: March 9, 2025 (89 days left)              ││
│  │                                                     ││
│  │ [Book Next Session]  [View History]                ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Rahul Verma - Starter Package                       ││
│  │                                                     ││
│  │ ██████████░░░░░░░░░░  1 of 3 sessions used         ││
│  │                                                     ││
│  │ Remaining: 2 sessions                               ││
│  │ Expires: January 15, 2025 (36 days left)           ││
│  │                                                     ││
│  │ [Book Next Session]  [View History]                ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Completed (1)                                          │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Neha Gupta - Premium Package                        ││
│  │ ✓ Completed | 10 sessions | Oct-Dec 2024           ││
│  │ [Repurchase Package]                                ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Book from Package Flow

```
┌─────────────────────────────────────────────────────────┐
│  Book Session - Growth Package                          │
│  2 sessions remaining                                   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Select a time with Priya Sharma                       │
│                                                         │
│  December 2024              [< Prev]  [Next >]         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Mon 9    │ Tue 10   │ Wed 11   │ Thu 12   │ Fri 13 ││
│  │──────────│──────────│──────────│──────────│────────││
│  │ [10:00]  │ [09:00]  │          │ [10:00]  │        ││
│  │ [14:00]  │ [11:00]  │          │ [15:00]  │        ││
│  │          │ [14:00]  │          │          │        ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Selected: Thursday, Dec 12 at 3:00 PM                 │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Payment Summary                                     ││
│  │                                                     ││
│  │ Session from package          ₹0                   ││
│  │ (Package: Growth - 5 Sessions)                     ││
│  │                                                     ││
│  │ After this booking: 1 session remaining            ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  [Confirm Booking]                                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: Package Display (No Schema Change)

1. Add package configuration to ConsultationPlan (JSON field)
2. Display packages on consultant profile
3. Calculate pricing with discount logic

### Phase 2: Package Purchase

1. Create checkout flow for packages
2. Store package details in Payment.metadata
3. Track purchase in user's package list
4. Send purchase confirmation

### Phase 3: Session Booking from Package

1. Show "Book from Package" when user has active package
2. Implement booking flow without payment
3. Track usage in metadata
4. Update remaining sessions

### Phase 4: Package Management

1. Consultant dashboard for creating packages
2. Analytics on package sales and usage
3. Expiry notifications (7 days, 1 day before)
4. Optional: Expired session refund/extension policies

---

## Dependencies

### Depends On

- ConsultationPlan model
- Payment system
- Booking flow

### Features That Depend On This

- **Gift Consultations** - Can gift packages
- **Analytics Dashboard** - Package revenue metrics

---

## Edge Cases

1. **Session cancellation**: Return credit to package, not refund
2. **Consultant deactivates**: Option to use with other consultant or refund
3. **Package expires with sessions left**: Configurable policy (forfeit/extend/refund)
4. **Price change**: Existing packages honor original price
5. **Partial refund request**: Pro-rate based on sessions used
