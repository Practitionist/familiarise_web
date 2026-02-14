# Collaborators Implementation Guide

**Last Updated**: 2026-02-10
**Status**: IMPLEMENTED (webinars + classes only)
**Purpose**: Implement multi-creator collaboration for webinars and classes with revenue sharing

> **Implementation Notes** (Feb 2026, branch `feat/referral-collaborator-system`):
> - Podcast collaborators not implemented (PodcastPlan model doesn't exist yet)
> - Scheduling is host-only; collaborators cannot create events
> - Host sets revenue split, collaborator accepts/declines the package
> - Minimum 10% host share (collaborator total capped at 90%)
> - Stream.io chat channels auto-created on collaborator acceptance
> - Stream video call role assignment deferred (calls created client-side)
>
> **📋 Related Documentation**: See `podcast-schema-integration.md` for podcast architecture decisions (ADR-001: Naming Convention using `PodcastPlan` + `PodcastAccess` pattern)

---

## Table of Contents

1. [Overview](#overview)
2. [Analysis of Current collaborators.prisma](#analysis-of-current-collaboratorsprisma)
3. [Improved Collaborator Architecture](#improved-collaborator-architecture)
4. [Revenue Sharing System](#revenue-sharing-system)
5. [Podcast-Specific Collaborators](#podcast-specific-collaborators)
6. [Permission System](#permission-system)
7. [API Design](#api-design)
8. [UI Patterns](#ui-patterns)
9. [Migration Strategy](#migration-strategy)
10. [Complete Schema Reference](#complete-schema-reference)

---

## Overview

### The Problem

Currently, all content (webinars, classes, podcasts) assumes a **single creator**:

```prisma
model WebinarPlan {
  consultantProfile   ConsultantProfile? @relation(...)
  consultantProfileId String?
  // Only ONE consultant owns this webinar
}
```

**Real-world scenarios that aren't supported**:

1. **Co-hosted Webinar**: Two experts co-presenting on a topic
2. **Guest Speaker**: Inviting industry leaders to speak in your class
3. **Podcast Co-hosts**: Multiple hosts on a podcast series
4. **Technical Producer**: Someone managing the technical side of production
5. **Revenue Sharing**: Splitting earnings among multiple contributors

---

### The Solution: Collaborative Content

```
┌─────────────────────────────────────────────────────────────────┐
│                    COLLABORATIVE CONTENT                         │
└─────────────────────────────────────────────────────────────────┘

    WebinarPlan                PodcastPlan               ClassPlan
         │                           │                        │
         ├─── Primary Host ──────────┼────────────────────────┤
         │    (Owner)                │                        │
         │                           │                        │
         └─── Collaborators ─────────┴────────────────────────┘
                    │
      ┌─────────────┼─────────────┐
      │             │             │
   Co-Host      Producer     Guest Speaker
   (50% rev)    (20% rev)     (30% rev)
```

**Key Features**:

- ✅ Multiple contributors per content piece
- ✅ Role-based permissions (who can edit, publish, view analytics)
- ✅ Revenue sharing (automatic payment splits)
- ✅ Invitation system (pending/accepted/declined)
- ✅ Episode-level collaborators for podcasts
- ✅ Historical tracking (who contributed when)

---

## Analysis of Current collaborators.prisma

### Current Proposal (from docs/collaborators.prisma)

```prisma
model Collaborator {
  id          String   @id @default(cuid())
  role        CollaboratorRole
  permissions Json?
  addedAt     DateTime @default(now())

  consultantProfile   ConsultantProfile @relation(...)
  consultantProfileId String

  // Many-to-many with plans
  webinarPlans WebinarPlan[]
  classPlans   ClassPlan[]

  @@index([consultantProfileId])
}

enum CollaboratorRole {
  CO_HOST
  ASSISTANT
  GUEST_SPEAKER
  MODERATOR
}
```

### Issues Identified

#### **Issue 1: Implicit Many-to-Many (No Junction Table)**

**Problem**: Prisma creates an implicit junction table with no custom fields.

```prisma
// This creates a hidden table: _CollaboratorToWebinarPlan
webinarPlans WebinarPlan[]  // In Collaborator
collaborators Collaborator[]  // In WebinarPlan
```

**Why it's problematic**:

- ❌ Can't add custom fields (revenueShare, joinedAt, status)
- ❌ Can't track when a collaborator was added to a specific webinar
- ❌ Can't have different roles per webinar (user might be co-host on one, moderator on another)
- ❌ No invitation status tracking

**Solution**: Use **explicit junction tables**.

---

#### **Issue 2: Missing Revenue Share Fields**

**Problem**: No way to specify how revenue should be split.

```prisma
// Current: No revenue information
model Collaborator {
  role        CollaboratorRole
  permissions Json?
  // ❌ Where's the revenue share percentage?
}
```

**Real-world need**:

- Co-host gets 50% of revenue
- Guest speaker gets 30%
- Technical producer gets 20%

**Solution**: Add revenue share to junction tables.

---

#### **Issue 3: Global Collaborator (Not Content-Specific)**

**Problem**: A consultant is either a collaborator on ALL webinars or NONE.

```prisma
model Collaborator {
  consultantProfile   ConsultantProfile
  webinarPlans WebinarPlan[]  // Many webinars, but same role/permissions?
}
```

**Real scenario**:

- User A is **co-host** on "Marketing Webinar" (50% revenue)
- User A is **guest speaker** on "Sales Webinar" (30% revenue)
- User A is **moderator** on "Tech Webinar" (10% revenue)

**Solution**: Store role and revenue per content piece.

---

#### **Issue 4: No Invitation Status**

**Problem**: How do you invite someone to collaborate?

Current flow would require:

```typescript
// ❌ Immediately creates collaborator (no pending state)
await prisma.collaborator.create({
  data: {
    consultantProfileId: "invitee-id",
    webinarPlans: { connect: { id: "webinar-123" } },
  },
});
// Now they're a collaborator, even if they haven't accepted!
```

**Solution**: Add invitation status (PENDING → ACCEPTED → ACTIVE).

---

#### **Issue 5: Missing Podcast Support**

**Problem**: Only webinars and classes are included.

```prisma
model Collaborator {
  webinarPlans WebinarPlan[]
  classPlans   ClassPlan[]
  // ❌ No podcastPlans
}
```

**Solution**: Add podcast collaborators with episode-level granularity.

---

## Improved Collaborator Architecture

### Design Principles

1. **Explicit Junction Tables**: One for each content type (WebinarCollaborator, PodcastCollaborator)
2. **Content-Specific Data**: Role, revenue share, status stored per collaboration
3. **Invitation System**: Pending → Accepted → Active flow
4. **Historical Tracking**: Know who collaborated when
5. **Flexible Roles**: Different roles for different content types

---

### Recommended Schema

```prisma
// =====================================================
// CORE COLLABORATOR MODELS
// =====================================================

// Junction: Consultant ↔ WebinarPlan
model WebinarCollaborator {
  id          String   @id @default(cuid())

  // Role & Permissions
  role        WebinarCollaboratorRole
  permissions Json?    // Custom permissions object

  // Revenue Sharing
  revenueSharePercentage Float  @default(0) // 0-100

  // Invitation & Status
  status      CollaboratorStatus @default(PENDING)
  invitedAt   DateTime @default(now())
  acceptedAt  DateTime?
  declinedAt  DateTime?
  removedAt   DateTime?

  // Relations
  consultant         ConsultantProfile @relation(fields: [consultantId], references: [id])
  consultantId       String

  webinarPlan        WebinarPlan @relation(fields: [webinarPlanId], references: [id])
  webinarPlanId      String

  invitedBy          ConsultantProfile @relation("InvitedCollaborators", fields: [invitedById], references: [id])
  invitedById        String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([consultantId, webinarPlanId])  // One role per consultant per webinar
  @@index([webinarPlanId])
  @@index([consultantId])
  @@index([status])
}

// Junction: Consultant ↔ ClassPlan
model ClassCollaborator {
  id          String   @id @default(cuid())

  role        ClassCollaboratorRole
  permissions Json?
  revenueSharePercentage Float  @default(0)

  status      CollaboratorStatus @default(PENDING)
  invitedAt   DateTime @default(now())
  acceptedAt  DateTime?

  consultant         ConsultantProfile @relation(fields: [consultantId], references: [id])
  consultantId       String

  classPlan          ClassPlan @relation(fields: [classPlanId], references: [id])
  classPlanId        String

  invitedBy          ConsultantProfile @relation("InvitedClassCollaborators", fields: [invitedById], references: [id])
  invitedById        String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([consultantId, classPlanId])
  @@index([classPlanId])
  @@index([consultantId])
}

// Junction: Consultant ↔ PodcastPlan (Series-level)
model PodcastCollaborator {
  id          String   @id @default(cuid())

  role        PodcastCollaboratorRole
  permissions Json?
  revenueSharePercentage Float  @default(0)

  status      CollaboratorStatus @default(PENDING)
  invitedAt   DateTime @default(now())
  acceptedAt  DateTime?

  consultant         ConsultantProfile @relation(fields: [consultantId], references: [id])
  consultantId       String

  podcastPlan        PodcastPlan @relation(fields: [podcastPlanId], references: [id])
  podcastPlanId      String

  invitedBy          ConsultantProfile @relation("InvitedPodcastCollaborators", fields: [invitedById], references: [id])
  invitedById        String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([consultantId, podcastPlanId])
  @@index([podcastPlanId])
  @@index([consultantId])
}

// Junction: Consultant ↔ PodcastEpisode (Episode-level)
model PodcastEpisodeCollaborator {
  id          String   @id @default(cuid())

  role        PodcastEpisodeRole
  credit      String?  @db.Text  // "Guest: John Doe discusses AI trends"
  revenueSharePercentage Float  @default(0)

  status      CollaboratorStatus @default(PENDING)
  invitedAt   DateTime @default(now())
  acceptedAt  DateTime?

  consultant         ConsultantProfile @relation(fields: [consultantId], references: [id])
  consultantId       String

  episode            PodcastEpisode @relation(fields: [episodeId], references: [id])
  episodeId          String

  invitedBy          ConsultantProfile @relation("InvitedEpisodeCollaborators", fields: [invitedById], references: [id])
  invitedById        String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([consultantId, episodeId])
  @@index([episodeId])
  @@index([consultantId])
}

// =====================================================
// ENUMS
// =====================================================

enum CollaboratorStatus {
  PENDING      // Invitation sent, awaiting response
  ACCEPTED     // Invitation accepted, active collaborator
  DECLINED     // Invitation declined
  REMOVED      // Removed by owner
}

enum WebinarCollaboratorRole {
  CO_HOST           // Equal presenter, can edit content
  MODERATOR         // Manages Q&A, chat, audience
  GUEST_SPEAKER     // Guest appearance, limited access
  TECHNICAL_SUPPORT // Handles tech issues during live session
}

enum ClassCollaboratorRole {
  CO_INSTRUCTOR     // Equal teaching partner
  TEACHING_ASSISTANT // Helps with student questions
  GUEST_LECTURER    // Guest for specific sessions
  CONTENT_CREATOR   // Creates course materials
}

enum PodcastCollaboratorRole {
  CO_HOST           // Regular co-host across episodes
  PRODUCER          // Manages production workflow
  EDITOR            // Audio editing and post-production
  CONTENT_STRATEGIST // Plans topics and guests
}

enum PodcastEpisodeRole {
  GUEST             // One-time or recurring guest
  CO_HOST           // Co-hosts this specific episode
  INTERVIEWER       // Conducts interviews
  NARRATOR          // Narrates/reads content
}
```

---

### Key Improvements

#### ✅ **Content-Specific Collaboration**

```typescript
// User A on different webinars
const collaborations = await prisma.webinarCollaborator.findMany({
  where: { consultantId: "user-a" },
  include: { webinarPlan: true },
});

/*
[
  { role: 'CO_HOST', revenueShare: 50, webinarPlan: { title: 'Marketing 101' } },
  { role: 'GUEST_SPEAKER', revenueShare: 30, webinarPlan: { title: 'Sales Tactics' } },
  { role: 'MODERATOR', revenueShare: 10, webinarPlan: { title: 'Tech Trends' } }
]
*/
```

#### ✅ **Revenue Sharing Built-In**

```prisma
model WebinarCollaborator {
  revenueSharePercentage Float  @default(0) // 0-100
  // Primary host gets remainder: 100 - SUM(collaborator shares)
}
```

#### ✅ **Invitation Workflow**

```typescript
// Step 1: Owner invites collaborator
const invitation = await prisma.webinarCollaborator.create({
  data: {
    consultantId: "invitee-id",
    webinarPlanId: "webinar-123",
    role: "CO_HOST",
    revenueSharePercentage: 40,
    invitedById: "owner-id",
    status: "PENDING",
  },
});

// Step 2: Invitee accepts
await prisma.webinarCollaborator.update({
  where: { id: invitation.id },
  data: {
    status: "ACCEPTED",
    acceptedAt: new Date(),
  },
});

// Step 3: Query active collaborators
const activeCollabs = await prisma.webinarCollaborator.findMany({
  where: {
    webinarPlanId: "webinar-123",
    status: "ACCEPTED",
  },
});
```

---

## Revenue Sharing System

### Revenue Split Logic

#### **Rule 1: Primary Owner Gets Remainder**

```typescript
// Webinar price: $100
// Co-host gets 40%
// Guest gets 30%
// Owner gets: 100% - 40% - 30% = 30%

interface RevenueBreakdown {
  totalAmount: number;
  ownerShare: number;
  collaboratorShares: Array<{
    consultantId: string;
    name: string;
    role: string;
    sharePercentage: number;
    amount: number;
  }>;
}

async function calculateRevenueSplit(
  webinarPlanId: string,
  totalAmount: number,
): Promise<RevenueBreakdown> {
  // Get webinar owner and collaborators
  const webinar = await prisma.webinarPlan.findUnique({
    where: { id: webinarPlanId },
    include: {
      consultantProfile: { include: { user: true } },
      collaborators: {
        where: { status: "ACCEPTED" },
        include: { consultant: { include: { user: true } } },
      },
    },
  });

  if (!webinar) throw new Error("Webinar not found");

  // Calculate collaborator shares
  const collaboratorShares = webinar.collaborators.map((collab) => ({
    consultantId: collab.consultantId,
    name: collab.consultant.user.name || "Unknown",
    role: collab.role,
    sharePercentage: collab.revenueSharePercentage,
    amount: Math.round(totalAmount * (collab.revenueSharePercentage / 100)),
  }));

  // Owner gets remainder
  const totalCollabPercentage = collaboratorShares.reduce(
    (sum, share) => sum + share.sharePercentage,
    0,
  );
  const ownerPercentage = 100 - totalCollabPercentage;
  const ownerShare =
    totalAmount -
    collaboratorShares.reduce((sum, share) => sum + share.amount, 0);

  return {
    totalAmount,
    ownerShare,
    collaboratorShares,
  };
}

// Example usage
const split = await calculateRevenueSplit("webinar-123", 10000); // $100.00
/*
{
  totalAmount: 10000,
  ownerShare: 3000,  // $30.00
  collaboratorShares: [
    { consultantId: 'user-a', role: 'CO_HOST', sharePercentage: 40, amount: 4000 },
    { consultantId: 'user-b', role: 'GUEST_SPEAKER', sharePercentage: 30, amount: 3000 }
  ]
}
*/
```

---

#### **Rule 2: Validation (Total ≤ 100%)**

```typescript
// Prevent over-allocation
async function validateRevenueShares(webinarPlanId: string): Promise<boolean> {
  const collaborators = await prisma.webinarCollaborator.findMany({
    where: { webinarPlanId, status: "ACCEPTED" },
  });

  const totalShares = collaborators.reduce(
    (sum, c) => sum + c.revenueSharePercentage,
    0,
  );

  if (totalShares > 100) {
    throw new Error(
      `Total revenue shares (${totalShares}%) exceed 100%. Adjust allocations.`,
    );
  }

  return true;
}

// Call before accepting new collaborator
await validateRevenueShares(webinarPlanId);
```

---

### Payout Model

#### **Option A: Revenue Share Tracking Table**

```prisma
// Track each collaborator's earnings
model CollaboratorEarnings {
  id          String   @id @default(cuid())

  // What earned it
  contentType ContentType  // WEBINAR, CLASS, PODCAST
  contentId   String       // ID of webinar/class/podcast

  // Financial details
  grossRevenue       Int   // Total payment amount
  sharePercentage    Float // Their percentage
  earnedAmount       Int   // Their share in cents
  platformFee        Int   // Platform commission
  netAmount          Int   // After platform fee

  // Payout status
  payoutStatus       PayoutStatus @default(PENDING)
  payoutDate         DateTime?
  payoutReference    String?  // Stripe Transfer ID, bank reference, etc.

  // Relations
  consultant         ConsultantProfile @relation(...)
  consultantId       String

  payment            Payment @relation(...)  // Original payment
  paymentId          String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([consultantId, payoutStatus])
  @@index([payoutStatus])
}

enum PayoutStatus {
  PENDING       // Earnings tracked, payout not yet processed
  PROCESSING    // Payout initiated
  COMPLETED     // Paid out successfully
  FAILED        // Payout failed, needs retry
}

enum ContentType {
  WEBINAR
  CLASS
  PODCAST_SERIES    // PodcastAccess (full series)
  PODCAST_EPISODE   // EpisodePurchase (individual episode)
  CONSULTATION
  SUBSCRIPTION
}
```

#### **Automatic Earnings Creation on Payment**

```typescript
// When user purchases webinar with collaborators
async function processWebinarPayment(paymentData: {
  webinarId: string;
  userId: string;
  amount: number;
}) {
  // 1. Create payment record
  const payment = await prisma.payment.create({
    data: {
      amount: paymentData.amount,
      userId: paymentData.userId,
      paymentStatus: "SUCCEEDED",
      // ... other fields
    },
  });

  // 2. Calculate revenue split
  const split = await calculateRevenueSplit(
    paymentData.webinarId,
    paymentData.amount,
  );

  // 3. Create earnings for owner
  const webinar = await prisma.webinarPlan.findUnique({
    where: { id: paymentData.webinarId },
    select: { consultantProfileId: true },
  });

  await prisma.collaboratorEarnings.create({
    data: {
      consultantId: webinar!.consultantProfileId,
      contentType: "WEBINAR",
      contentId: paymentData.webinarId,
      grossRevenue: paymentData.amount,
      sharePercentage:
        100 -
        split.collaboratorShares.reduce((s, c) => s + c.sharePercentage, 0),
      earnedAmount: split.ownerShare,
      platformFee: Math.round(split.ownerShare * 0.05), // 5% platform fee
      netAmount: Math.round(split.ownerShare * 0.95),
      payoutStatus: "PENDING",
      paymentId: payment.id,
    },
  });

  // 4. Create earnings for each collaborator
  for (const collab of split.collaboratorShares) {
    await prisma.collaboratorEarnings.create({
      data: {
        consultantId: collab.consultantId,
        contentType: "WEBINAR",
        contentId: paymentData.webinarId,
        grossRevenue: paymentData.amount,
        sharePercentage: collab.sharePercentage,
        earnedAmount: collab.amount,
        platformFee: Math.round(collab.amount * 0.05),
        netAmount: Math.round(collab.amount * 0.95),
        payoutStatus: "PENDING",
        paymentId: payment.id,
      },
    });
  }

  return payment;
}

// When user purchases podcast series access (creates PodcastAccess)
async function processPodcastSeriesPayment(paymentData: {
  podcastPlanId: string;
  userId: string;
  amount: number;
}) {
  // 1. Create payment record
  const payment = await prisma.payment.create({
    data: {
      amount: paymentData.amount,
      userId: paymentData.userId,
      paymentStatus: "SUCCEEDED",
      // ... other fields
    },
  });

  // 2. Calculate revenue split for podcast series
  const split = await calculatePodcastRevenueSplit(
    paymentData.podcastPlanId,
    paymentData.amount,
  );

  // 3. Create earnings for owner
  const podcastPlan = await prisma.podcastPlan.findUnique({
    where: { id: paymentData.podcastPlanId },
    select: { consultantProfileId: true },
  });

  await prisma.collaboratorEarnings.create({
    data: {
      consultantId: podcastPlan!.consultantProfileId,
      contentType: "PODCAST_SERIES",
      contentId: paymentData.podcastPlanId,
      grossRevenue: paymentData.amount,
      sharePercentage:
        100 - split.collaborators.reduce((s, c) => s + c.sharePercentage, 0),
      earnedAmount: split.owner,
      platformFee: Math.round(split.owner * 0.05),
      netAmount: Math.round(split.owner * 0.95),
      payoutStatus: "PENDING",
      paymentId: payment.id,
    },
  });

  // 4. Create earnings for each series-level collaborator
  for (const collab of split.collaborators) {
    await prisma.collaboratorEarnings.create({
      data: {
        consultantId: collab.consultantId,
        contentType: "PODCAST_SERIES",
        contentId: paymentData.podcastPlanId,
        grossRevenue: paymentData.amount,
        sharePercentage: collab.sharePercentage,
        earnedAmount: collab.amount,
        platformFee: Math.round(collab.amount * 0.05),
        netAmount: Math.round(collab.amount * 0.95),
        payoutStatus: "PENDING",
        paymentId: payment.id,
      },
    });
  }

  return payment;
}

// When user purchases individual episode (creates EpisodePurchase)
async function processEpisodePurchasePayment(paymentData: {
  episodeId: string;
  userId: string;
  amount: number;
}) {
  // 1. Create payment record
  const payment = await prisma.payment.create({
    data: {
      amount: paymentData.amount,
      userId: paymentData.userId,
      paymentStatus: "SUCCEEDED",
      // ... other fields
    },
  });

  // 2. Calculate revenue split (includes both series and episode collaborators)
  const split = await calculateEpisodeRevenueSplit(
    paymentData.episodeId,
    paymentData.amount,
  );

  // 3. Create earnings for owner
  const episode = await prisma.podcastEpisode.findUnique({
    where: { id: paymentData.episodeId },
    select: { consultantProfileId: true },
  });

  await prisma.collaboratorEarnings.create({
    data: {
      consultantId: episode!.consultantProfileId,
      contentType: "PODCAST_EPISODE",
      contentId: paymentData.episodeId,
      grossRevenue: paymentData.amount,
      sharePercentage:
        100 -
        [...split.seriesCollaborators, ...split.episodeCollaborators].reduce(
          (s, c) => s + c.sharePercentage,
          0,
        ),
      earnedAmount: split.owner,
      platformFee: Math.round(split.owner * 0.05),
      netAmount: Math.round(split.owner * 0.95),
      payoutStatus: "PENDING",
      paymentId: payment.id,
    },
  });

  // 4. Create earnings for series-level collaborators
  for (const collab of split.seriesCollaborators) {
    await prisma.collaboratorEarnings.create({
      data: {
        consultantId: collab.consultantId,
        contentType: "PODCAST_EPISODE",
        contentId: paymentData.episodeId,
        grossRevenue: paymentData.amount,
        sharePercentage: collab.sharePercentage,
        earnedAmount: collab.amount,
        platformFee: Math.round(collab.amount * 0.05),
        netAmount: Math.round(collab.amount * 0.95),
        payoutStatus: "PENDING",
        paymentId: payment.id,
      },
    });
  }

  // 5. Create earnings for episode-level collaborators
  for (const collab of split.episodeCollaborators) {
    await prisma.collaboratorEarnings.create({
      data: {
        consultantId: collab.consultantId,
        contentType: "PODCAST_EPISODE",
        contentId: paymentData.episodeId,
        grossRevenue: paymentData.amount,
        sharePercentage: collab.sharePercentage,
        earnedAmount: collab.amount,
        platformFee: Math.round(collab.amount * 0.05),
        netAmount: Math.round(collab.amount * 0.95),
        payoutStatus: "PENDING",
        paymentId: payment.id,
      },
    });
  }

  return payment;
}
```

---

### Consultant Earnings Dashboard

```typescript
// API: GET /api/dashboard/consultant/[id]/earnings

interface EarningsSummary {
  totalEarned: number; // All-time earnings
  pendingPayout: number; // Not yet paid out
  thisMonth: number; // Current month earnings
  byContent: {
    webinars: number;
    classes: number;
    podcastSeries: number; // PodcastAccess earnings
    podcastEpisodes: number; // EpisodePurchase earnings
    consultations: number;
  };
  byRole: {
    owner: number; // As primary creator
    collaborator: number; // As collaborator on others' content
  };
  recentEarnings: Array<{
    contentTitle: string;
    contentType: string;
    role: string;
    earnedAmount: number;
    date: Date;
  }>;
}

async function getConsultantEarnings(
  consultantId: string,
): Promise<EarningsSummary> {
  const earnings = await prisma.collaboratorEarnings.findMany({
    where: { consultantId },
    include: {
      payment: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const totalEarned = earnings.reduce((sum, e) => sum + e.netAmount, 0);
  const pendingPayout = earnings
    .filter((e) => e.payoutStatus === "PENDING")
    .reduce((sum, e) => sum + e.netAmount, 0);

  // Group by content type
  const byContent = {
    webinars: earnings
      .filter((e) => e.contentType === "WEBINAR")
      .reduce((s, e) => s + e.netAmount, 0),
    classes: earnings
      .filter((e) => e.contentType === "CLASS")
      .reduce((s, e) => s + e.netAmount, 0),
    podcastSeries: earnings
      .filter((e) => e.contentType === "PODCAST_SERIES")
      .reduce((s, e) => s + e.netAmount, 0),
    podcastEpisodes: earnings
      .filter((e) => e.contentType === "PODCAST_EPISODE")
      .reduce((s, e) => s + e.netAmount, 0),
    consultations: earnings
      .filter((e) => e.contentType === "CONSULTATION")
      .reduce((s, e) => s + e.netAmount, 0),
  };

  // Determine if owner or collaborator by checking sharePercentage
  const byRole = {
    owner: earnings
      .filter((e) => e.sharePercentage >= 50)
      .reduce((s, e) => s + e.netAmount, 0),
    collaborator: earnings
      .filter((e) => e.sharePercentage < 50)
      .reduce((s, e) => s + e.netAmount, 0),
  };

  return {
    totalEarned,
    pendingPayout,
    thisMonth: earnings
      .filter((e) => isThisMonth(e.createdAt))
      .reduce((sum, e) => sum + e.netAmount, 0),
    byContent,
    byRole,
    recentEarnings: earnings.slice(0, 10).map((e) => ({
      contentTitle: "Loaded from content relation",
      contentType: e.contentType,
      role: e.sharePercentage >= 50 ? "Owner" : "Collaborator",
      earnedAmount: e.netAmount,
      date: e.createdAt,
    })),
  };
}
```

---

## Podcast-Specific Collaborators

### Two-Level Collaboration

Podcasts have unique collaboration needs:

1. **Series-Level Collaborators** (across all episodes)
   - Co-hosts who appear regularly
   - Producers managing the show
   - Editors handling post-production

2. **Episode-Level Collaborators** (specific episodes)
   - Guest speakers for individual episodes
   - Special interviewers
   - Guest narrators

---

### Schema Implementation

Already covered in the Improved Collaborator Architecture section:

```prisma
// Series-level (all episodes)
model PodcastCollaborator {
  podcastPlan   PodcastPlan
  consultant    ConsultantProfile
  role          PodcastCollaboratorRole  // CO_HOST, PRODUCER, EDITOR
  revenueSharePercentage Float
}

// Episode-level (specific episodes)
model PodcastEpisodeCollaborator {
  episode       PodcastEpisode
  consultant    ConsultantProfile
  role          PodcastEpisodeRole  // GUEST, CO_HOST, INTERVIEWER, NARRATOR
  credit        String?  // "Guest: John Doe discusses AI"
  revenueSharePercentage Float
}
```

---

### Use Cases

#### **Use Case 1: Regular Co-host**

```typescript
// Add permanent co-host to podcast series
const cohost = await prisma.podcastCollaborator.create({
  data: {
    consultantId: "user-b",
    podcastPlanId: "podcast-123",
    role: "CO_HOST",
    revenueSharePercentage: 50, // Equal partners
    invitedById: "owner-id",
    status: "ACCEPTED",
  },
});

// Now all future episodes automatically have co-host revenue split
```

---

#### **Use Case 2: Guest on Specific Episode**

```typescript
// Invite guest for Episode 5
const guest = await prisma.podcastEpisodeCollaborator.create({
  data: {
    consultantId: "guest-id",
    episodeId: "episode-5",
    role: "GUEST",
    credit: "Guest: Jane Smith, AI Researcher at Stanford",
    revenueSharePercentage: 20, // One-time guest fee
    invitedById: "owner-id",
    status: "ACCEPTED",
  },
});
```

---

#### **Use Case 3: Producer with No Revenue Share**

```typescript
// Technical producer (flat fee, no percentage)
const producer = await prisma.podcastCollaborator.create({
  data: {
    consultantId: "producer-id",
    podcastPlanId: "podcast-123",
    role: "PRODUCER",
    revenueSharePercentage: 0, // Paid separately, not from revenue
    invitedById: "owner-id",
    status: "ACCEPTED",
  },
});

// Producer gets access to edit episodes but no revenue share
// Could be paid via separate invoice/contract
```

---

### Revenue Calculation for Episodes

```typescript
// When someone purchases access to a podcast series (creates PodcastAccess)
async function calculatePodcastRevenueSplit(
  podcastPlanId: string,
  amount: number,
) {
  // Get series-level collaborators
  const seriesCollabs = await prisma.podcastCollaborator.findMany({
    where: { podcastPlanId, status: "ACCEPTED" },
  });

  // Note: This is called when creating PodcastAccess (series access)
  // Episode-level collaborators don't get paid on series purchases
  // They only earn from individual episode sales (EpisodePurchase)

  const totalCollabShare = seriesCollabs.reduce(
    (sum, c) => sum + c.revenueSharePercentage,
    0,
  );

  return {
    owner: amount * ((100 - totalCollabShare) / 100),
    collaborators: seriesCollabs.map((c) => ({
      consultantId: c.consultantId,
      role: c.role,
      amount: amount * (c.revenueSharePercentage / 100),
    })),
  };
}

// If individual episodes can be purchased (à la carte - creates EpisodePurchase)
async function calculateEpisodeRevenueSplit(episodeId: string, amount: number) {
  const episode = await prisma.podcastEpisode.findUnique({
    where: { id: episodeId },
    include: {
      podcastPlan: {
        include: {
          collaborators: { where: { status: "ACCEPTED" } },
        },
      },
      episodeCollaborators: { where: { status: "ACCEPTED" } },
    },
  });

  // Note: This is called when creating EpisodePurchase (individual episode purchase)
  // Both series-level AND episode-level collaborators get paid
  const seriesShare =
    episode.podcastPlan?.collaborators.reduce(
      (sum, c) => sum + c.revenueSharePercentage,
      0,
    ) || 0;
  const episodeShare = episode.episodeCollaborators.reduce(
    (sum, c) => sum + c.revenueSharePercentage,
    0,
  );

  const ownerShare = 100 - seriesShare - episodeShare;

  return {
    owner: amount * (ownerShare / 100),
    seriesCollaborators: (episode.podcastPlan?.collaborators || []).map(
      (c) => ({
        consultantId: c.consultantId,
        amount: amount * (c.revenueSharePercentage / 100),
      }),
    ),
    episodeCollaborators: episode.episodeCollaborators.map((c) => ({
      consultantId: c.consultantId,
      amount: amount * (c.revenueSharePercentage / 100),
    })),
  };
}
```

---

## Permission System

### Permission Matrix

| Role          | Edit Content | Publish | Delete | Invite Collaborators | View Analytics | Manage Revenue |
| ------------- | ------------ | ------- | ------ | -------------------- | -------------- | -------------- |
| **Owner**     | ✅           | ✅      | ✅     | ✅                   | ✅             | ✅             |
| **CO_HOST**   | ✅           | ✅      | ❌     | ✅                   | ✅             | ❌             |
| **PRODUCER**  | ✅           | ❌      | ❌     | ❌                   | ✅             | ❌             |
| **GUEST**     | ❌           | ❌      | ❌     | ❌                   | ❌             | ❌             |
| **MODERATOR** | ❌           | ❌      | ❌     | ❌                   | ⚠️ Limited     | ❌             |

### Permission Schema

```prisma
// Stored in the `permissions` Json field
interface CollaboratorPermissions {
  canEdit: boolean;
  canPublish: boolean;
  canDelete: boolean;
  canInvite: boolean;
  canViewAnalytics: boolean;
  canManageRevenue: boolean;
  customNotes?: string;
}

// Default permissions by role
const DEFAULT_PERMISSIONS: Record<string, CollaboratorPermissions> = {
  CO_HOST: {
    canEdit: true,
    canPublish: true,
    canDelete: false,
    canInvite: true,
    canViewAnalytics: true,
    canManageRevenue: false
  },
  PRODUCER: {
    canEdit: true,
    canPublish: false,
    canDelete: false,
    canInvite: false,
    canViewAnalytics: true,
    canManageRevenue: false
  },
  GUEST: {
    canEdit: false,
    canPublish: false,
    canDelete: false,
    canInvite: false,
    canViewAnalytics: false,
    canManageRevenue: false
  }
};
```

### Permission Checking Middleware

```typescript
// middleware/checkCollaboratorPermission.ts

type Permission =
  | "canEdit"
  | "canPublish"
  | "canDelete"
  | "canInvite"
  | "canViewAnalytics"
  | "canManageRevenue";

async function checkWebinarPermission(
  consultantId: string,
  webinarPlanId: string,
  requiredPermission: Permission,
): Promise<boolean> {
  // Check if owner
  const webinar = await prisma.webinarPlan.findFirst({
    where: {
      id: webinarPlanId,
      consultantProfileId: consultantId,
    },
  });

  if (webinar) {
    return true; // Owner has all permissions
  }

  // Check if collaborator with permission
  const collaboration = await prisma.webinarCollaborator.findFirst({
    where: {
      consultantId,
      webinarPlanId,
      status: "ACCEPTED",
    },
  });

  if (!collaboration) {
    return false; // Not owner or collaborator
  }

  const permissions =
    collaboration.permissions as CollaboratorPermissions | null;

  // If custom permissions set, use those; otherwise use role defaults
  if (permissions) {
    return permissions[requiredPermission] === true;
  } else {
    const defaults = DEFAULT_PERMISSIONS[collaboration.role];
    return defaults[requiredPermission] === true;
  }
}

// Usage in API route
export async function PATCH(
  request: Request,
  { params }: { params: { webinarId: string } },
) {
  const session = await getServerSession();
  const consultantId = session.user.consultantProfileId;

  const canEdit = await checkWebinarPermission(
    consultantId,
    params.webinarId,
    "canEdit",
  );

  if (!canEdit) {
    return NextResponse.json(
      { error: "You do not have permission to edit this webinar" },
      { status: 403 },
    );
  }

  // Proceed with edit...
}
```

---

## API Design

### Collaborator Management Endpoints

```typescript
// ====================================================
// CREATE INVITATION
// ====================================================

// POST /api/webinars/[webinarId]/collaborators
interface InviteCollaboratorRequest {
  consultantId: string;
  role: WebinarCollaboratorRole;
  revenueSharePercentage: number;
  permissions?: CollaboratorPermissions;
}

export async function POST(request: Request, { params }) {
  const body: InviteCollaboratorRequest = await request.json();
  const session = await getServerSession();

  // Verify requester is owner
  const webinar = await prisma.webinarPlan.findFirst({
    where: {
      id: params.webinarId,
      consultantProfileId: session.user.consultantProfileId,
    },
  });

  if (!webinar) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Validate revenue share doesn't exceed 100%
  await validateRevenueShares(params.webinarId, body.revenueSharePercentage);

  // Create invitation
  const invitation = await prisma.webinarCollaborator.create({
    data: {
      consultantId: body.consultantId,
      webinarPlanId: params.webinarId,
      role: body.role,
      revenueSharePercentage: body.revenueSharePercentage,
      permissions: body.permissions || DEFAULT_PERMISSIONS[body.role],
      invitedById: session.user.consultantProfileId,
      status: "PENDING",
    },
    include: {
      consultant: {
        include: { user: { select: { name: true, email: true } } },
      },
    },
  });

  // Send notification/email to invitee
  await sendCollaborationInviteEmail(invitation);

  return NextResponse.json({ data: invitation });
}

// ====================================================
// ACCEPT/DECLINE INVITATION
// ====================================================

// PATCH /api/collaborations/[collaborationId]/respond
interface RespondToInvitationRequest {
  action: "accept" | "decline";
}

export async function PATCH(request: Request, { params }) {
  const body: RespondToInvitationRequest = await request.json();
  const session = await getServerSession();

  const collaboration = await prisma.webinarCollaborator.findFirst({
    where: {
      id: params.collaborationId,
      consultantId: session.user.consultantProfileId,
      status: "PENDING",
    },
  });

  if (!collaboration) {
    return NextResponse.json(
      { error: "Invitation not found" },
      { status: 404 },
    );
  }

  const updated = await prisma.webinarCollaborator.update({
    where: { id: params.collaborationId },
    data: {
      status: body.action === "accept" ? "ACCEPTED" : "DECLINED",
      ...(body.action === "accept" && { acceptedAt: new Date() }),
      ...(body.action === "decline" && { declinedAt: new Date() }),
    },
  });

  return NextResponse.json({ data: updated });
}

// ====================================================
// LIST COLLABORATORS
// ====================================================

// GET /api/webinars/[webinarId]/collaborators
export async function GET(request: Request, { params }) {
  const collaborators = await prisma.webinarCollaborator.findMany({
    where: {
      webinarPlanId: params.webinarId,
      status: { in: ["PENDING", "ACCEPTED"] },
    },
    include: {
      consultant: {
        include: {
          user: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ data: collaborators });
}

// ====================================================
// UPDATE REVENUE SHARE
// ====================================================

// PATCH /api/webinars/[webinarId]/collaborators/[collaboratorId]
interface UpdateCollaboratorRequest {
  revenueSharePercentage?: number;
  permissions?: CollaboratorPermissions;
}

export async function PATCH(request: Request, { params }) {
  const body: UpdateCollaboratorRequest = await request.json();
  const session = await getServerSession();

  // Verify requester is owner
  const canManage = await checkWebinarPermission(
    session.user.consultantProfileId,
    params.webinarId,
    "canManageRevenue",
  );

  if (!canManage) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  if (body.revenueSharePercentage !== undefined) {
    await validateRevenueShares(
      params.webinarId,
      body.revenueSharePercentage,
      params.collaboratorId,
    );
  }

  const updated = await prisma.webinarCollaborator.update({
    where: { id: params.collaboratorId },
    data: body,
  });

  return NextResponse.json({ data: updated });
}

// ====================================================
// REMOVE COLLABORATOR
// ====================================================

// DELETE /api/webinars/[webinarId]/collaborators/[collaboratorId]
export async function DELETE(request: Request, { params }) {
  const session = await getServerSession();

  // Only owner can remove collaborators
  const webinar = await prisma.webinarPlan.findFirst({
    where: {
      id: params.webinarId,
      consultantProfileId: session.user.consultantProfileId,
    },
  });

  if (!webinar) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Soft delete by updating status
  await prisma.webinarCollaborator.update({
    where: { id: params.collaboratorId },
    data: {
      status: "REMOVED",
      removedAt: new Date(),
    },
  });

  return NextResponse.json({ success: true });
}
```

---

## UI Patterns

### Invitation Flow

```typescript
// Component: InviteCollaboratorModal.tsx

interface InviteModalProps {
  webinarId: string;
  onInviteSent: () => void;
}

export function InviteCollaboratorModal({ webinarId, onInviteSent }: InviteModalProps) {
  const [selectedConsultant, setSelectedConsultant] = useState<string>('');
  const [role, setRole] = useState<WebinarCollaboratorRole>('CO_HOST');
  const [revenueShare, setRevenueShare] = useState(30);

  const handleInvite = async () => {
    const response = await fetch(`/api/webinars/${webinarId}/collaborators`, {
      method: 'POST',
      body: JSON.stringify({
        consultantId: selectedConsultant,
        role,
        revenueSharePercentage: revenueShare
      })
    });

    if (response.ok) {
      toast.success('Invitation sent!');
      onInviteSent();
    }
  };

  return (
    <Modal>
      <h2>Invite Collaborator</h2>

      {/* Search for consultant */}
      <ConsultantSearch
        onSelect={setSelectedConsultant}
        placeholder="Search consultants..."
      />

      {/* Select role */}
      <Select value={role} onChange={setRole}>
        <option value="CO_HOST">Co-Host (Full collaboration)</option>
        <option value="MODERATOR">Moderator (Manage audience)</option>
        <option value="GUEST_SPEAKER">Guest Speaker (Limited access)</option>
      </Select>

      {/* Revenue share */}
      <div>
        <label>Revenue Share: {revenueShare}%</label>
        <Slider
          min={0}
          max={50}
          value={revenueShare}
          onChange={setRevenueShare}
        />
        <p className="text-sm text-gray-500">
          You'll receive {100 - revenueShare - currentCollabsTotal}% after all collaborators
        </p>
      </div>

      <Button onClick={handleInvite}>Send Invitation</Button>
    </Modal>
  );
}
```

### Collaborator Dashboard View

```typescript
// Component: CollaboratorsTab.tsx

export function CollaboratorsTab({ webinarId }: { webinarId: string }) {
  const { data: collaborators } = useQuery({
    queryKey: ['collaborators', webinarId],
    queryFn: () => fetch(`/api/webinars/${webinarId}/collaborators`).then(r => r.json())
  });

  return (
    <div>
      <div className="flex justify-between">
        <h2>Collaborators</h2>
        <Button onClick={() => setShowInviteModal(true)}>
          <Plus /> Invite Collaborator
        </Button>
      </div>

      <Table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Revenue Share</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {collaborators?.data.map((collab) => (
            <tr key={collab.id}>
              <td>
                <div className="flex items-center gap-2">
                  <Avatar src={collab.consultant.user.image} />
                  {collab.consultant.user.name}
                </div>
              </td>
              <td>
                <Badge>{collab.role}</Badge>
              </td>
              <td>{collab.revenueSharePercentage}%</td>
              <td>
                <StatusBadge status={collab.status} />
              </td>
              <td>
                <DropdownMenu>
                  <DropdownItem onClick={() => editCollaborator(collab)}>
                    Edit
                  </DropdownItem>
                  <DropdownItem onClick={() => removeCollaborator(collab.id)}>
                    Remove
                  </DropdownItem>
                </DropdownMenu>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
```

---

## Migration Strategy

### Phase 1: Add Collaborator Junction Tables (Non-Breaking)

```bash
# Add WebinarCollaborator, ClassCollaborator, PodcastCollaborator models
npx prisma migrate dev --name add_collaborator_models

# No existing data affected
```

---

### Phase 2: Update Related Models

```prisma
// Update ConsultantProfile
model ConsultantProfile {
  // ... existing fields ...

  // NEW: Collaborations
  webinarCollaborations WebinarCollaborator[]
  classCollaborations   ClassCollaborator[]
  podcastCollaborations PodcastCollaborator[]
  episodeCollaborations PodcastEpisodeCollaborator[]

  // NEW: Invitations sent
  invitedWebinarCollabs  WebinarCollaborator[]  @relation("InvitedCollaborators")
  invitedClassCollabs    ClassCollaborator[]    @relation("InvitedClassCollaborators")
  invitedPodcastCollabs  PodcastCollaborator[]  @relation("InvitedPodcastCollaborators")
  invitedEpisodeCollabs  PodcastEpisodeCollaborator[] @relation("InvitedEpisodeCollaborators")
}

// Update WebinarPlan
model WebinarPlan {
  // ... existing fields ...
  collaborators WebinarCollaborator[]  // NEW
}

// Update PodcastPlan
model PodcastPlan {
  // ... existing fields ...
  collaborators PodcastCollaborator[]  // NEW
}

// Update PodcastEpisode
model PodcastEpisode {
  // ... existing fields ...
  episodeCollaborators PodcastEpisodeCollaborator[]  // NEW
}
```

```bash
npx prisma migrate dev --name add_collaborator_relations
```

---

### Phase 3: Add Earnings Tracking

```prisma
model CollaboratorEarnings {
  // ... full schema from Revenue Sharing section ...
}
```

```bash
npx prisma migrate dev --name add_earnings_tracking
```

---

### Phase 4: Create APIs & UI

1. Create collaborator management API routes
2. Build invitation UI components
3. Add collaborators tab to content management dashboards
4. Implement permission checks in existing APIs

---

### Phase 5: Test & Deploy

```typescript
// Integration tests
describe("Collaborator System", () => {
  it("should allow owner to invite collaborator", async () => {
    // ...
  });

  it("should prevent over-allocation of revenue shares", async () => {
    // ...
  });

  it("should split revenue correctly", async () => {
    // ...
  });

  it("should respect permission matrix", async () => {
    // ...
  });
});
```

---

## Complete Schema Reference

### Full Collaborator Schema

```prisma
// =====================================================
// COLLABORATOR MODELS
// =====================================================

// Webinar Collaborators
model WebinarCollaborator {
  id                     String                     @id @default(cuid())
  role                   WebinarCollaboratorRole
  permissions            Json?
  revenueSharePercentage Float                      @default(0)
  status                 CollaboratorStatus         @default(PENDING)
  invitedAt              DateTime                   @default(now())
  acceptedAt             DateTime?
  declinedAt             DateTime?
  removedAt              DateTime?

  consultant   ConsultantProfile @relation(fields: [consultantId], references: [id], onUpdate: Cascade, onDelete: Cascade)
  consultantId String

  webinarPlan   WebinarPlan @relation(fields: [webinarPlanId], references: [id], onUpdate: Cascade, onDelete: Cascade)
  webinarPlanId String

  invitedBy   ConsultantProfile @relation("InvitedWebinarCollaborators", fields: [invitedById], references: [id])
  invitedById String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([consultantId, webinarPlanId])
  @@index([webinarPlanId])
  @@index([consultantId])
  @@index([status])
}

// Class Collaborators
model ClassCollaborator {
  id                     String                  @id @default(cuid())
  role                   ClassCollaboratorRole
  permissions            Json?
  revenueSharePercentage Float                   @default(0)
  status                 CollaboratorStatus      @default(PENDING)
  invitedAt              DateTime                @default(now())
  acceptedAt             DateTime?

  consultant  ConsultantProfile @relation(fields: [consultantId], references: [id], onUpdate: Cascade, onDelete: Cascade)
  consultantId String

  classPlan   ClassPlan @relation(fields: [classPlanId], references: [id], onUpdate: Cascade, onDelete: Cascade)
  classPlanId String

  invitedBy   ConsultantProfile @relation("InvitedClassCollaborators", fields: [invitedById], references: [id])
  invitedById String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([consultantId, classPlanId])
  @@index([classPlanId])
  @@index([consultantId])
}

// Podcast Series Collaborators
model PodcastCollaborator {
  id                     String                   @id @default(cuid())
  role                   PodcastCollaboratorRole
  permissions            Json?
  revenueSharePercentage Float                    @default(0)
  status                 CollaboratorStatus       @default(PENDING)
  invitedAt              DateTime                 @default(now())
  acceptedAt             DateTime?

  consultant    ConsultantProfile @relation(fields: [consultantId], references: [id], onUpdate: Cascade, onDelete: Cascade)
  consultantId  String

  podcastPlan   PodcastPlan @relation(fields: [podcastPlanId], references: [id], onUpdate: Cascade, onDelete: Cascade)
  podcastPlanId String

  invitedBy   ConsultantProfile @relation("InvitedPodcastCollaborators", fields: [invitedById], references: [id])
  invitedById String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([consultantId, podcastPlanId])
  @@index([podcastPlanId])
  @@index([consultantId])
}

// Podcast Episode Collaborators
model PodcastEpisodeCollaborator {
  id                     String              @id @default(cuid())
  role                   PodcastEpisodeRole
  credit                 String?             @db.Text
  revenueSharePercentage Float               @default(0)
  status                 CollaboratorStatus  @default(PENDING)
  invitedAt              DateTime            @default(now())
  acceptedAt             DateTime?

  consultant   ConsultantProfile @relation(fields: [consultantId], references: [id], onUpdate: Cascade, onDelete: Cascade)
  consultantId String

  episode   PodcastEpisode @relation(fields: [episodeId], references: [id], onUpdate: Cascade, onDelete: Cascade)
  episodeId String

  invitedBy   ConsultantProfile @relation("InvitedEpisodeCollaborators", fields: [invitedById], references: [id])
  invitedById String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([consultantId, episodeId])
  @@index([episodeId])
  @@index([consultantId])
}

// Earnings Tracking
model CollaboratorEarnings {
  id             String      @id @default(cuid())
  contentType    ContentType
  contentId      String
  grossRevenue   Int
  sharePercentage Float
  earnedAmount   Int
  platformFee    Int
  netAmount      Int
  payoutStatus   PayoutStatus @default(PENDING)
  payoutDate     DateTime?
  payoutReference String?

  consultant   ConsultantProfile @relation(fields: [consultantId], references: [id])
  consultantId String

  payment   Payment @relation(fields: [paymentId], references: [id])
  paymentId String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([consultantId, payoutStatus])
  @@index([payoutStatus])
  @@index([contentType, contentId])
}

// =====================================================
// ENUMS
// =====================================================

enum CollaboratorStatus {
  PENDING
  ACCEPTED
  DECLINED
  REMOVED
}

enum WebinarCollaboratorRole {
  CO_HOST
  MODERATOR
  GUEST_SPEAKER
  TECHNICAL_SUPPORT
}

enum ClassCollaboratorRole {
  CO_INSTRUCTOR
  TEACHING_ASSISTANT
  GUEST_LECTURER
  CONTENT_CREATOR
}

enum PodcastCollaboratorRole {
  CO_HOST
  PRODUCER
  EDITOR
  CONTENT_STRATEGIST
}

enum PodcastEpisodeRole {
  GUEST
  CO_HOST
  INTERVIEWER
  NARRATOR
}

enum ContentType {
  WEBINAR
  CLASS
  PODCAST_SERIES    // PodcastAccess (full series)
  PODCAST_EPISODE   // EpisodePurchase (individual episode)
  CONSULTATION
  SUBSCRIPTION
}

enum PayoutStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}

// =====================================================
// UPDATED EXISTING MODELS
// =====================================================

model ConsultantProfile {
  // ... existing fields ...

  // Collaborations (as collaborator)
  webinarCollaborations WebinarCollaborator[]
  classCollaborations   ClassCollaborator[]
  podcastCollaborations PodcastCollaborator[]
  episodeCollaborations PodcastEpisodeCollaborator[]

  // Invitations sent (as inviter)
  invitedWebinarCollabs  WebinarCollaborator[]          @relation("InvitedWebinarCollaborators")
  invitedClassCollabs    ClassCollaborator[]            @relation("InvitedClassCollaborators")
  invitedPodcastCollabs  PodcastCollaborator[]          @relation("InvitedPodcastCollaborators")
  invitedEpisodeCollabs  PodcastEpisodeCollaborator[]   @relation("InvitedEpisodeCollaborators")

  // Earnings
  earnings CollaboratorEarnings[]
}

model WebinarPlan {
  // ... existing fields ...
  collaborators WebinarCollaborator[]
}

model ClassPlan {
  // ... existing fields ...
  collaborators ClassCollaborator[]
}

model PodcastPlan {
  // ... existing fields ...
  collaborators PodcastCollaborator[]
}

model PodcastEpisode {
  // ... existing fields ...
  episodeCollaborators PodcastEpisodeCollaborator[]
}

model Payment {
  // ... existing fields ...
  earnings CollaboratorEarnings[]
}
```

---

## Summary

### Key Features Implemented

1. ✅ **Multi-creator Collaboration**: Multiple consultants can work together on content
2. ✅ **Role-based Permissions**: Different roles with different access levels
3. ✅ **Revenue Sharing**: Automatic payment splits based on percentages
4. ✅ **Invitation System**: Pending → Accepted → Active workflow
5. ✅ **Podcast-Specific**: Both series-level and episode-level collaborators
6. ✅ **Earnings Tracking**: Detailed financial records for each collaborator
7. ✅ **Flexible Architecture**: Easy to extend to new content types

### Implementation Checklist

- [ ] Add collaborator junction table models to schema
- [ ] Run migrations to create tables
- [ ] Create collaborator management API routes
- [ ] Implement permission checking middleware
- [ ] Build earnings calculation system
- [ ] Add CollaboratorEarnings model and automatic creation
- [ ] Create invitation UI components
- [ ] Add collaborators tab to content dashboards
- [ ] Build earnings dashboard for consultants
- [ ] Implement payout system
- [ ] Test revenue split calculations
- [ ] Test permission matrix
- [ ] Deploy to production

---

**Next Steps**: Refer to `podcast-schema-integration.md` for how to integrate the overall podcast architecture with payments and analytics.
