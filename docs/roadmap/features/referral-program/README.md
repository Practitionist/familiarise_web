# Referral Program

> **Status: IMPLEMENTED** (Feb 2026) on branch `feat/referral-collaborator-system`
>
> **Deviations from spec**: Affiliate system skipped for MVP. Anti-fraud/gaming prevention deferred. Credits use FIFO expiry (6 months). Qualifying action = first paid booking only.

## Overview

A referral system that rewards users for bringing new consultees and consultants to the platform. Both referrer and referee receive benefits, creating a viral growth loop.

### Value Proposition

- **Viral Growth**: Users become ambassadors
- **Lower CAC**: Cheaper than paid acquisition
- **Quality Users**: Referred users have higher LTV
- **Network Effects**: Consultants bring their existing clients

---

## User Stories

### Referrers (Existing Users)

- As a user, I want a unique referral link to share
- As a user, I want to track who I've referred
- As a user, I want to earn rewards when referrals convert
- As a user, I want easy sharing to social media/email

### Referees (New Users)

- As a new user, I want a signup bonus when using a referral link
- As a new user, I want to see who referred me
- As a new user, I want to understand the referral benefit

### Consultants (Special Referrer)

- As a consultant, I want to refer my existing clients to the platform
- As a consultant, I want to refer other consultants
- As a consultant, I want higher rewards for quality referrals

---

## Technical Architecture

### Database Schema

**New models required:**

```prisma
model ReferralCode {
  id              String @id @default(cuid())

  user            User @relation(fields: [userId], references: [id])
  userId          String @unique

  code            String @unique   // e.g., "PRIYA20" or auto-generated
  customCode      String? @unique  // User's custom vanity code

  // Rewards configuration (can override defaults)
  referrerReward  Int?             // Reward for referrer (in currency smallest unit)
  refereeReward   Int?             // Reward for new user

  // Stats
  totalReferrals  Int @default(0)
  successfulReferrals Int @default(0)
  totalEarned     Int @default(0)

  isActive        Boolean @default(true)

  referrals       Referral[]

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([code])
  @@index([customCode])
}

model Referral {
  id              String @id @default(cuid())

  referralCode    ReferralCode @relation(fields: [referralCodeId], references: [id])
  referralCodeId  String

  // Who was referred
  referredUser    User @relation(fields: [referredUserId], references: [id])
  referredUserId  String @unique

  // Status
  status          ReferralStatus @default(SIGNED_UP)

  // Rewards
  referrerRewardAmount  Int?
  refereeRewardAmount   Int?
  referrerRewardPaidAt  DateTime?
  refereeRewardPaidAt   DateTime?

  // Tracking
  signedUpAt      DateTime @default(now())
  qualifiedAt     DateTime?         // When qualifying action completed
  qualifyingAction String?          // What action qualified them

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([referralCodeId])
  @@index([status])
}

model ReferralCredit {
  id              String @id @default(cuid())

  user            User @relation(fields: [userId], references: [id])
  userId          String

  amount          Int               // Credit amount (smallest unit)
  currency        String @default("INR")

  source          CreditSource
  referralId      String?           // If from referral

  // Usage
  usedAmount      Int @default(0)
  remainingAmount Int               // amount - usedAmount

  expiresAt       DateTime?         // Credits can expire
  usedAt          DateTime?
  usedOnPaymentId String?

  createdAt       DateTime @default(now())

  @@index([userId])
  @@index([expiresAt])
}

enum ReferralStatus {
  SIGNED_UP       // User created account
  QUALIFIED       // Completed qualifying action (first booking, etc.)
  REWARDED        // Rewards distributed
  EXPIRED         // Didn't qualify in time
  FRAUDULENT      // Flagged as fraud
}

enum CreditSource {
  REFERRAL_BONUS    // From referring someone
  REFEREE_BONUS     // From being referred
  PROMOTION         // Marketing promotion
  COMPENSATION      // Customer service
  MANUAL            // Admin added
}
```

### Referral Flow

```
┌─────────────────────────────────────────────────────────┐
│                  REFERRAL FLOW                           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. REFERRER SHARES                                     │
│     ───────────────────                                 │
│     - Gets unique referral link: familiarise.com/r/ABC │
│     - Shares via social, email, or direct message      │
│                                                         │
│  2. REFEREE SIGNS UP                                    │
│     ──────────────────                                  │
│     - Clicks referral link                             │
│     - Cookie/param stored with referral code           │
│     - Creates account                                  │
│     - Referral record created (status: SIGNED_UP)      │
│     - Referee bonus credited immediately (optional)    │
│                                                         │
│  3. QUALIFYING ACTION                                   │
│     ──────────────────                                  │
│     - Referee completes first booking/payment          │
│     - Referral status → QUALIFIED                      │
│     - Trigger reward distribution                      │
│                                                         │
│  4. REWARDS DISTRIBUTED                                 │
│     ────────────────────                                │
│     - Referrer gets credit (e.g., ₹500)               │
│     - Referee bonus confirmed (e.g., ₹200 off first)  │
│     - Both notified via email                         │
│     - Referral status → REWARDED                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
// lib/referrals/service.ts

const DEFAULT_REFERRER_REWARD = 50000; // ₹500 in paise
const DEFAULT_REFEREE_REWARD = 20000; // ₹200 in paise
const QUALIFICATION_WINDOW_DAYS = 30; // Must qualify within 30 days

export async function createReferralCode(
  userId: string,
): Promise<ReferralCode> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  // Check if already has code
  const existing = await prisma.referralCode.findUnique({
    where: { userId },
  });

  if (existing) return existing;

  // Generate unique code
  const code = await generateUniqueCode(user?.name);

  return prisma.referralCode.create({
    data: {
      userId,
      code,
      referrerReward: DEFAULT_REFERRER_REWARD,
      refereeReward: DEFAULT_REFEREE_REWARD,
    },
  });
}

async function generateUniqueCode(name?: string | null): Promise<string> {
  // Try name-based code first
  if (name) {
    const baseCode = name
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 6);
    for (let i = 0; i < 100; i++) {
      const code = i === 0 ? baseCode : `${baseCode}${i}`;
      const exists = await prisma.referralCode.findUnique({ where: { code } });
      if (!exists) return code;
    }
  }

  // Fall back to random code
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code: string;
  do {
    code = Array.from(
      { length: 8 },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join("");
  } while (await prisma.referralCode.findUnique({ where: { code } }));

  return code;
}

export async function applyReferralCode(
  newUserId: string,
  code: string,
): Promise<Referral | null> {
  const referralCode = await prisma.referralCode.findFirst({
    where: {
      OR: [{ code: code.toUpperCase() }, { customCode: code.toUpperCase() }],
      isActive: true,
    },
  });

  if (!referralCode) return null;

  // Can't refer yourself
  if (referralCode.userId === newUserId) return null;

  // Check if already referred
  const existingReferral = await prisma.referral.findUnique({
    where: { referredUserId: newUserId },
  });

  if (existingReferral) return null;

  // Create referral
  const referral = await prisma.referral.create({
    data: {
      referralCodeId: referralCode.id,
      referredUserId: newUserId,
      status: "SIGNED_UP",
      referrerRewardAmount:
        referralCode.referrerReward || DEFAULT_REFERRER_REWARD,
      refereeRewardAmount: referralCode.refereeReward || DEFAULT_REFEREE_REWARD,
    },
  });

  // Update referral code stats
  await prisma.referralCode.update({
    where: { id: referralCode.id },
    data: { totalReferrals: { increment: 1 } },
  });

  // Give referee immediate bonus (optional - can wait for qualification)
  if (referral.refereeRewardAmount) {
    await createReferralCredit(
      newUserId,
      referral.refereeRewardAmount,
      "REFEREE_BONUS",
      referral.id,
    );

    await sendEmail({
      to: await getUserEmail(newUserId),
      subject: "Welcome! You've got a signup bonus 🎁",
      template: "referee-welcome",
      data: { amount: referral.refereeRewardAmount / 100 },
    });
  }

  return referral;
}

export async function processQualifyingAction(
  userId: string,
  action: string, // e.g., 'first_booking', 'first_payment'
): Promise<void> {
  const referral = await prisma.referral.findUnique({
    where: { referredUserId: userId },
    include: { referralCode: { include: { user: true } } },
  });

  if (!referral || referral.status !== "SIGNED_UP") return;

  // Check if within qualification window
  const daysSinceSignup = Math.floor(
    (Date.now() - referral.signedUpAt.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (daysSinceSignup > QUALIFICATION_WINDOW_DAYS) {
    await prisma.referral.update({
      where: { id: referral.id },
      data: { status: "EXPIRED" },
    });
    return;
  }

  // Mark as qualified
  await prisma.referral.update({
    where: { id: referral.id },
    data: {
      status: "QUALIFIED",
      qualifiedAt: new Date(),
      qualifyingAction: action,
    },
  });

  // Reward referrer
  if (referral.referrerRewardAmount) {
    await createReferralCredit(
      referral.referralCode.userId,
      referral.referrerRewardAmount,
      "REFERRAL_BONUS",
      referral.id,
    );

    await prisma.referral.update({
      where: { id: referral.id },
      data: {
        status: "REWARDED",
        referrerRewardPaidAt: new Date(),
      },
    });

    // Update referral code stats
    await prisma.referralCode.update({
      where: { id: referral.referralCodeId },
      data: {
        successfulReferrals: { increment: 1 },
        totalEarned: { increment: referral.referrerRewardAmount },
      },
    });

    // Notify referrer
    await sendEmail({
      to: referral.referralCode.user.email,
      subject: "You earned a referral bonus! 🎉",
      template: "referrer-bonus",
      data: {
        amount: referral.referrerRewardAmount / 100,
        refereeName: await getUserName(userId),
      },
    });
  }
}

async function createReferralCredit(
  userId: string,
  amount: number,
  source: CreditSource,
  referralId?: string,
): Promise<ReferralCredit> {
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 6); // 6 month expiry

  return prisma.referralCredit.create({
    data: {
      userId,
      amount,
      currency: "INR",
      source,
      referralId,
      remainingAmount: amount,
      expiresAt,
    },
  });
}

// Apply credits at checkout
export async function applyCreditsToPayment(
  userId: string,
  paymentAmount: number,
): Promise<{ creditsUsed: number; remainingToPay: number }> {
  const availableCredits = await prisma.referralCredit.findMany({
    where: {
      userId,
      remainingAmount: { gt: 0 },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { expiresAt: "asc" }, // Use expiring first
  });

  let creditsUsed = 0;
  let remainingToPay = paymentAmount;

  for (const credit of availableCredits) {
    if (remainingToPay <= 0) break;

    const useAmount = Math.min(credit.remainingAmount, remainingToPay);

    await prisma.referralCredit.update({
      where: { id: credit.id },
      data: {
        usedAmount: { increment: useAmount },
        remainingAmount: { decrement: useAmount },
      },
    });

    creditsUsed += useAmount;
    remainingToPay -= useAmount;
  }

  return { creditsUsed, remainingToPay };
}
```

### API Endpoints

```
// Referral Code
GET /api/referrals/code
  Returns: User's referral code and stats

POST /api/referrals/code/customize
  Body: { customCode: "PRIYA" }
  Updates: Custom vanity code

GET /api/referrals/code/check/[code]
  Returns: Validity of referral code (for signup page)

// Referrals
GET /api/referrals
  Returns: User's referrals (people they referred)

POST /api/referrals/apply
  Body: { code }
  Action: Apply referral code to current user

// Credits
GET /api/credits
  Returns: User's credit balance and history

GET /api/credits/available
  Returns: Available credits for checkout
```

---

## UI/UX Design

### Referral Dashboard (`/dashboard/referrals`)

```
┌─────────────────────────────────────────────────────────┐
│  Refer & Earn                                           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  🎁 Share the love, earn rewards!                      │
│                                                         │
│  Give friends ₹200 off their first booking.            │
│  You'll get ₹500 when they complete a session.         │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Your Referral Link                                     │
│  ┌─────────────────────────────────────────────────────┐│
│  │ familiarise.com/r/PRIYA                  [Copy 📋] ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  [Share on WhatsApp] [Share on Twitter] [Share Email]  │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Your Stats                                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │  Referred   │ │  Qualified  │ │   Earned    │       │
│  │     12      │ │      8      │ │   ₹4,000    │       │
│  └─────────────┘ └─────────────┘ └─────────────┘       │
│                                                         │
│  Recent Referrals                                       │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  │ Name          │ Status     │ Reward     │ Date     ││
│  │───────────────│────────────│────────────│──────────││
│  │ Sarah K.      │ ✓ Rewarded │ +₹500      │ Dec 8    ││
│  │ Mike J.       │ ⏳ Pending │ -          │ Dec 5    ││
│  │ Lisa M.       │ ✓ Rewarded │ +₹500      │ Nov 28   ││
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Signup with Referral

```
┌─────────────────────────────────────────────────────────┐
│  Create Your Account                                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 🎁 You've been referred by Priya!                  ││
│  │                                                     ││
│  │ Sign up now and get ₹200 credit towards your      ││
│  │ first consultation.                                 ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Name                                                   │
│  ┌─────────────────────────────────────────────────────┐│
│  │                                                     ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Email                                                  │
│  ┌─────────────────────────────────────────────────────┐│
│  │                                                     ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Password                                               │
│  ┌─────────────────────────────────────────────────────┐│
│  │                                                     ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Referral Code (optional)                              │
│  ┌─────────────────────────────────────────────────────┐│
│  │ PRIYA                              ✓ Valid!        ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  [Create Account]                                       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Credits at Checkout

```
┌─────────────────────────────────────────────────────────┐
│  Payment Summary                                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1-on-1 Consultation with Priya Sharma                 │
│  60 minutes                              ₹2,000        │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 💰 You have ₹200 in credits!                       ││
│  │                                                     ││
│  │ ☑ Apply ₹200 credit              -₹200            ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Subtotal                                ₹2,000        │
│  Credits Applied                          -₹200        │
│  ───────────────────────────────────────────────────── │
│  Total                                   ₹1,800        │
│                                                         │
│  [Pay ₹1,800]                                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: Basic Referrals

1. Create referral code on user signup
2. Referral link with tracking
3. Apply code during signup
4. Basic referral tracking

### Phase 2: Rewards

1. Implement credit system
2. Qualification triggers (first booking)
3. Credit distribution
4. Apply credits at checkout

### Phase 3: Dashboard & Analytics

1. Referral dashboard for users
2. Stats and leaderboard
3. Social sharing buttons
4. Admin fraud detection

### Phase 4: Advanced

1. Custom vanity codes
2. Tiered rewards (more referrals = higher rewards)
3. Consultant-specific referral programs
4. Time-limited promotions

---

## Dependencies

### Depends On

- User authentication
- Payment system
- Email notifications

### Features That Depend On This

- **Gift Consultations** - Gifts could trigger referral rewards

---

## Fraud Prevention

1. **Email verification**: Require verified email for rewards
2. **IP tracking**: Flag multiple signups from same IP
3. **Device fingerprinting**: Detect repeated devices
4. **Payment requirement**: Require real payment for qualification
5. **Manual review**: Flag suspicious patterns for admin review
6. **Velocity limits**: Max referrals per day/week
