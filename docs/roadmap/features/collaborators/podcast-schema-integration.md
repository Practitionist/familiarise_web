# Podcast Schema Integration Guide

**Last Updated**: 2025-10-12
**Status**: Architecture Design - Comprehensive Decision Record
**Purpose**: Holistic integration of podcast models with existing schema (Payment, Appointment, Analytics)

---

## Table of Contents

1. [Architectural Decision Records](#architectural-decision-records)
2. [Overview](#overview)
3. [Schema Integration Architecture](#schema-integration-architecture)
4. [Payment Model Integration](#payment-model-integration)
5. [Unified Content Model](#unified-content-model)
6. [Revenue Analytics](#revenue-analytics)
7. [Database Indexes](#database-indexes)
8. [API Patterns](#api-patterns)
9. [Migration Strategy](#migration-strategy)
10. [Complete Schema Reference](#complete-schema-reference)

---

## Architectural Decision Records

This section documents ALL possible architectural choices, with clear recommendations and reasoning for decisions.

### ADR-001: Model Naming Convention

**Context**: We need to name the model that grants access to a podcast series. The existing platform uses `Subscription` for recurring consultations, creating potential naming confusion.

#### ❌ OPTION A: PodcastSubscription (DO NOT USE)

```prisma
model PodcastSubscription {
  // Access to a podcast series
}

model Subscription {
  // Recurring consultation sessions (EXISTING)
}
```

**Why NOT to use**:

- ❌ Naming collision with existing `Subscription` model
- ❌ Confusing: "subscription" has two different meanings
- ❌ TypeScript import conflicts: `import { Subscription } from '@prisma/client'` - which one?
- ❌ API routes would be ambiguous: `/subscriptions` vs `/podcast-subscriptions`

---

#### ⚠️ OPTION B: PodcastMembership (ALTERNATIVE)

```prisma
model PodcastMembership {
  // Access to a podcast series
}
```

**Why it could work**:

- ✅ No naming collision
- ✅ Semantically accurate for "member of a podcast"

**Why NOT recommended**:

- ⚠️ Breaks naming convention (doesn't follow `*Plan` pattern)
- ⚠️ Existing platform uses: ConsultationPlan, SubscriptionPlan, WebinarPlan, ClassPlan
- ⚠️ Would create inconsistency

---

#### ✅ OPTION C: PodcastPlan + PodcastAccess (RECOMMENDED)

```prisma
model PodcastPlan {
  // Series metadata (like ConsultationPlan, SubscriptionPlan)
  id    String @id
  title String
  price Int
  // ...

  access PodcastAccess[]  // Users who have access
}

model PodcastAccess {
  // Grants a user access to a PodcastPlan
  consulteeProfile PodcastPlan
  podcastPlan      PodcastPlan
  payment          Payment?
}
```

**Why RECOMMENDED**:

- ✅ Consistent with existing `*Plan` naming pattern
- ✅ `PodcastAccess` clearly different from `Subscription`
- ✅ Semantic clarity: "access" to a podcast series
- ✅ Future-proof for other access models (trials, gifted access, etc.)
- ✅ Clean TypeScript imports: `import { PodcastPlan, PodcastAccess } from '@prisma/client'`

**DECISION**: Use `PodcastPlan` + `PodcastAccess` throughout the platform.

---

### ADR-002: Episode Model Architecture

**Context**: Should episodes always belong to a series, or can they exist standalone?

#### ❌ OPTION A: Series-Only Model (DO NOT IMPLEMENT)

```prisma
model PodcastPlan {
  id       String @id
  episodes PodcastEpisode[]  // Episodes MUST belong to series
}

model PodcastEpisode {
  id            String      @id
  podcastPlan   PodcastPlan @relation(...)
  podcastPlanId String      // REQUIRED (not nullable)
}
```

**Why NOT to implement**:

- ❌ Cannot publish standalone episodes
- ❌ Guest appearances on someone else's podcast require creating fake series
- ❌ One-off special episodes have no home
- ❌ Too rigid for real-world podcasting

**Use Cases NOT Supported**:

- Single episode as product trial
- Guest speaker one-off episodes
- Special holiday episodes not part of regular series

---

#### ❌ OPTION B: Standalone-Only Model (DO NOT IMPLEMENT)

```prisma
model PodcastEpisode {
  id            String  @id
  podcastPlanId String? // Always null - no series concept

  // Each episode is independent
  price         Int     // Must set price per episode
  consultantId  String  // Each episode has owner
}
```

**Why NOT to implement**:

- ❌ Cannot bundle episodes into a series
- ❌ No concept of "buy once, get all episodes"
- ❌ Users must purchase each episode individually (poor UX)
- ❌ Cannot track series-level analytics
- ❌ Difficult to organize content

**Use Cases NOT Supported**:

- Season passes
- "Subscribe to series" model
- Binge-listening experiences
- Series-level branding

---

#### ✅ OPTION C: Flexible Model - Series + Standalone (RECOMMENDED)

```prisma
model PodcastPlan {
  id       String @id
  title    String
  price    Int    // Series price

  episodes PodcastEpisode[]
  access   PodcastAccess[]  // Users who bought the series
}

model PodcastEpisode {
  id                  String       @id
  title               String

  // NULLABLE - Episode can exist without series
  podcastPlan         PodcastPlan? @relation(...)
  podcastPlanId       String?

  // Individual pricing (for à la carte purchases)
  individualPrice     Int?         // null = not sold individually

  // Ownership (for standalone episodes)
  consultantProfile   ConsultantProfile @relation(...)
  consultantProfileId String

  // Individual purchases
  purchases           EpisodePurchase[]
}

model EpisodePurchase {
  id         String         @id
  episode    PodcastEpisode @relation(...)
  consultee  ConsulteeProfile @relation(...)
  payment    Payment?
}

model PodcastAccess {
  // Access to entire series
}
```

**Why RECOMMENDED**:

- ✅ Maximum flexibility
- ✅ Episodes can belong to series OR be standalone
- ✅ Support both business models:
  - Buy series → get all episodes
  - Buy individual episodes à la carte
- ✅ Support series + individual pricing (like iTunes)
- ✅ Future-proof for new monetization strategies

**Supported Use Cases**:

1. **Series Subscription**: User buys "Tech Talk Series" for $50, gets Episodes 1-20
2. **À La Carte**: User buys "Episode 5: AI Deep Dive" for $5 individually
3. **Standalone Episode**: User publishes one-off episode not part of any series
4. **Hybrid Pricing**: User can buy series OR individual episodes (series is cheaper per episode)

**DECISION**: Implement flexible model with nullable `podcastPlanId` and individual episode purchases.

---

### ADR-003: Scheduling Model

**Context**: Should podcasts be pre-recorded only, live-only, or support both?

#### ❌ OPTION A: On-Demand Only (DO NOT IMPLEMENT)

```prisma
model PodcastEpisode {
  id               String @id
  audioFileUrl     String   // Pre-uploaded file
  publishedAt      DateTime

  // NO appointment relation
  // NO live recording support
}
```

**Why NOT to implement**:

- ❌ Misses live podcast recording opportunity
- ❌ Cannot schedule live recordings with audience
- ❌ No integration with existing MeetingSession/Recording system
- ❌ Cannot monetize live access (early access, Q&A sessions)

**Use Cases NOT Supported**:

- Live podcast recording sessions
- Exclusive live Q&A with hosts
- Premium "watch recording live" access
- Live call-in shows

---

#### ❌ OPTION B: Live-Only (DO NOT IMPLEMENT)

```prisma
model PodcastEpisode {
  id         String      @id

  // REQUIRED appointment - every episode is a live event
  appointment   Appointment @relation(...)
  appointmentId String      @unique  // NOT nullable
}
```

**Why NOT to implement**:

- ❌ Too rigid - forces all episodes to be scheduled events
- ❌ Cannot upload pre-recorded content
- ❌ Consultants who prefer to record offline are excluded
- ❌ Requires managing slots for every episode

**Use Cases NOT Supported**:

- Pre-recorded interview podcasts
- Edited/produced content
- Repurposed content from other platforms
- Asynchronous recording with guests in different timezones

---

#### ✅ OPTION C: Hybrid Model - Live + On-Demand (RECOMMENDED)

```prisma
model PodcastEpisode {
  id                  String   @id
  title               String

  // Media (for pre-recorded OR post-live-recording)
  audioFileUrl        String?  // Uploaded OR converted from live recording
  audioStoragePath    String?

  // OPTIONAL live recording
  appointment         Appointment? @relation(...)
  appointmentId       String?      @unique  // Nullable - not all episodes are live

  // Episode status
  status              PodcastEpisodeStatus
  publishedAt         DateTime?

  consultantProfile   ConsultantProfile @relation(...)
  consultantProfileId String
}

model Appointment {
  id                 String              @id
  appointmentType    AppointmentsType
  slotsOfAppointment SlotOfAppointment[]

  // Existing relations
  consultation   Consultation? @relation(...)
  subscription   Subscription? @relation(...)
  webinar        Webinar?      @relation(...)
  class          Class?        @relation(...)

  // NEW: Podcast episode (for live recordings)
  podcastEpisode   PodcastEpisode? @relation(...)
  podcastEpisodeId String?         @unique
}

enum AppointmentsType {
  CONSULTATION
  SUBSCRIPTION
  WEBINAR
  CLASS
  PODCAST_LIVE  // NEW
}
```

**Why RECOMMENDED**:

- ✅ Maximum flexibility for creators
- ✅ Supports both pre-recorded AND live workflows
- ✅ Integrates with existing Appointment/MeetingSession infrastructure
- ✅ Monetization options for both models
- ✅ Future-proof for new recording formats

**Workflow 1: Pre-Recorded Episode**

```typescript
// Consultant uploads audio file directly
const episode = await prisma.podcastEpisode.create({
  data: {
    title: "How to Build Startups",
    audioFileUrl: "https://storage.../episode-1.mp3",
    podcastPlanId: "series-123",
    consultantProfileId: "consultant-abc",
    status: "PUBLISHED",
    publishedAt: new Date(),
    // appointmentId: null (no live recording)
  },
});
```

**Workflow 2: Live Recording Episode**

```typescript
// Step 1: Schedule live recording
const appointment = await prisma.appointment.create({
  data: {
    appointmentType: "PODCAST_LIVE",
    slotsOfAppointment: {
      create: {
        slotStartTimeInUTC: new Date("2025-10-15T18:00:00Z"),
        slotEndTimeInUTC: new Date("2025-10-15T19:00:00Z"),
      },
    },
  },
});

// Step 2: Create episode linked to appointment
const episode = await prisma.podcastEpisode.create({
  data: {
    title: "Live Q&A: Startup Funding",
    appointmentId: appointment.id,
    podcastPlanId: "series-123",
    consultantProfileId: "consultant-abc",
    status: "SCHEDULED",
  },
});

// Step 3: After live recording, attach recording URL
await prisma.podcastEpisode.update({
  where: { id: episode.id },
  data: {
    audioFileUrl: meetingSession.recordings[0].recordingUrl,
    status: "PUBLISHED",
    publishedAt: new Date(),
  },
});
```

**Supported Use Cases**:

1. **Pre-recorded**: Record offline, upload to platform
2. **Live with audience**: Schedule live session, record, publish afterward
3. **Hybrid series**: Some episodes live, some pre-recorded
4. **Premium live access**: Charge extra for live attendance, free on-demand later

**DECISION**: Implement hybrid model with optional `appointmentId` on `PodcastEpisode`.

---

### Summary of Architectural Decisions

| Decision       | Choice                          | Rationale                                                              |
| -------------- | ------------------------------- | ---------------------------------------------------------------------- |
| **Naming**     | `PodcastPlan` + `PodcastAccess` | Consistency with `*Plan` pattern, avoids confusion with `Subscription` |
| **Episodes**   | Flexible (Series + Standalone)  | Support all business models, maximum flexibility                       |
| **Scheduling** | Hybrid (Live + On-Demand)       | Leverage existing infrastructure, support all recording workflows      |

---

## Overview

### The Challenge

Your platform currently has four content types:

- **Consultations** (1-on-1 scheduled sessions)
- **Subscriptions** (recurring scheduled sessions)
- **Webinars** (live group events)
- **Classes** (multi-session group courses)

All use the **Appointment → SlotOfAppointment → Payment** pattern because they're **time-based and scheduled**.

**Podcasts are different**:

- ⚠️ Can be on-demand (pre-recorded) OR scheduled (live recordings)
- ✅ Evergreen content (consumed many times after creation)
- ✅ Series-based OR standalone episodes
- ✅ Flexible monetization (series access, individual episodes, free)

### The Goal

Create a **holistic schema** where:

1. Podcasts integrate cleanly with existing Payment/Revenue systems
2. Unified "booking history" works across all content types
3. Dashboard aggregators show all content in one query
4. Analytics track revenue across scheduled + on-demand content
5. Support both live and pre-recorded podcast workflows
6. Minimal disruption to existing schema

---

## Schema Integration Architecture

### Current Architecture (Scheduled Content)

```text
┌─────────────────────────────────────────────────────────────────┐
│                    SCHEDULED CONTENT FLOW                        │
└─────────────────────────────────────────────────────────────────┘

ConsulteeProfile                                      Payment
       │                                                 │
       ├──> Consultation ──> Appointment ──> Slot ──────┤
       ├──> Subscription ──> Appointment ──> Slot ──────┤
       │                                                 │
       └──> [Webinar/Class via SlotOfAppointment] ──────┘

Key: Appointment is the "booking" - links payment to scheduled event
```

### New Architecture (Adding Podcasts)

```text
┌─────────────────────────────────────────────────────────────────┐
│                  UNIFIED CONTENT ARCHITECTURE                    │
└─────────────────────────────────────────────────────────────────┘

                         ConsulteeProfile
                               │
              ┌────────────────┼───────────────────┐
              │                │                   │
         SCHEDULED          SCHEDULED      PODCAST CONTENT
              │                │                   │
              ▼                ▼                   ▼
        Consultation      Subscription      PodcastAccess (series)
              │                │                   │
              ▼                ▼                   │
        Appointment      Appointment               │
              │                │                   │
              ▼                ▼                   │
      SlotOfAppointment  SlotOfAppointment         │
              │                │                   │
              └────────────────┼───────────────────┤
                               │                   │
                               │            EpisodePurchase
                               │            (individual)
                               │                   │
                               ▼                   ▼
                           Payment ────────────────┘
                           (Unified)

PLUS: Podcast episodes can optionally have Appointment (for live recordings)
```

---

## Payment Model Integration

### Recommended Approach: Multi-Target Payment

**Concept**: Payment can link to multiple types of purchases:

1. Appointment (scheduled content)
2. PodcastAccess (series purchase)
3. EpisodePurchase (individual episode)

**Prisma Schema**:

```prisma
model Payment {
  id             String         @id @default(uuid())
  amount         Int
  currency       String
  paymentStatus  PaymentStatus

  user           User          @relation(fields: [userId], references: [id])
  userId         String

  // FLEXIBLE LINKING - ONE of these will be populated
  appointment         Appointment?       @relation(fields: [appointmentId], references: [id])
  appointmentId       String?            @unique  // For scheduled content

  podcastAccess       PodcastAccess?     @relation(fields: [podcastAccessId], references: [id])
  podcastAccessId     String?            @unique  // For series purchases

  episodePurchase     EpisodePurchase?   @relation(fields: [episodePurchaseId], references: [id])
  episodePurchaseId   String?            @unique  // For individual episode purchases

  // ... other fields

  @@index([userId])
  @@index([appointmentId])
  @@index([podcastAccessId])
  @@index([episodePurchaseId])
  @@index([paymentStatus])
}

model PodcastAccess {
  id          String   @id @default(cuid())
  startDate   DateTime @default(now())
  endDate     DateTime? // null = lifetime access
  accessLevel PodcastAccessLevel @default(FULL)

  consulteeProfile   ConsulteeProfile @relation(fields: [consulteeProfileId], references: [id])
  consulteeProfileId String

  podcastPlan        PodcastPlan @relation(fields: [podcastPlanId], references: [id])
  podcastPlanId      String

  payment            Payment?  // Payment that granted series access

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([consulteeProfileId, podcastPlanId])
  @@index([consulteeProfileId])
  @@index([podcastPlanId])
}

model EpisodePurchase {
  id          String   @id @default(cuid())
  purchaseDate DateTime @default(now())

  consulteeProfile   ConsulteeProfile @relation(fields: [consulteeProfileId], references: [id])
  consulteeProfileId String

  episode            PodcastEpisode @relation(fields: [episodeId], references: [id])
  episodeId          String

  payment            Payment?  // Payment for this episode

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([consulteeProfileId, episodeId])
  @@index([consulteeProfileId])
  @@index([episodeId])
}
```

**Pros**:

- ✅ Clean separation: Appointment = scheduled, PodcastAccess = series, EpisodePurchase = individual
- ✅ Supports all monetization models
- ✅ Type-safe relationships (Prisma enforces foreign keys)
- ✅ Clear purchase history queries

**Revenue Calculation**:

```typescript
// Get consultant's total revenue
async function getConsultantRevenue(consultantId: string) {
  const [scheduledRevenue, seriesRevenue, episodeRevenue] = await Promise.all([
    // Scheduled content (consultations, subscriptions, webinars, classes)
    prisma.payment.aggregate({
      where: {
        paymentStatus: "SUCCEEDED",
        appointment: {
          OR: [
            {
              consultation: {
                consultationPlan: { consultantProfileId: consultantId },
              },
            },
            {
              subscription: {
                subscriptionPlan: { consultantProfileId: consultantId },
              },
            },
            // ... webinars, classes
          ],
        },
      },
      _sum: { amount: true },
    }),

    // Podcast series purchases
    prisma.payment.aggregate({
      where: {
        paymentStatus: "SUCCEEDED",
        podcastAccess: {
          podcastPlan: { consultantProfileId: consultantId },
        },
      },
      _sum: { amount: true },
    }),

    // Individual episode purchases
    prisma.payment.aggregate({
      where: {
        paymentStatus: "SUCCEEDED",
        episodePurchase: {
          episode: { consultantProfileId: consultantId },
        },
      },
      _sum: { amount: true },
    }),
  ]);

  return {
    total:
      (scheduledRevenue._sum.amount || 0) +
      (seriesRevenue._sum.amount || 0) +
      (episodeRevenue._sum.amount || 0),
    byType: {
      scheduled: scheduledRevenue._sum.amount || 0,
      podcastSeries: seriesRevenue._sum.amount || 0,
      podcastEpisodes: episodeRevenue._sum.amount || 0,
    },
  };
}
```

---

## Unified Content Model

### TypeScript Abstraction

Create unified types for all purchasable content:

```typescript
// types/content.ts

type PurchasedContent =
  | { type: "CONSULTATION"; data: Consultation & { appointment: Appointment } }
  | {
      type: "SUBSCRIPTION";
      data: Subscription & { appointments: Appointment[] };
    }
  | { type: "WEBINAR"; data: Webinar & { appointment: Appointment } }
  | { type: "CLASS"; data: Class & { appointments: Appointment[] } }
  | { type: "PODCAST_SERIES"; data: PodcastAccess }
  | { type: "PODCAST_EPISODE"; data: EpisodePurchase };

// Unified purchase history query
async function getAllPurchases(
  consulteeId: string,
): Promise<PurchasedContent[]> {
  const [
    consultations,
    subscriptions,
    webinars,
    classes,
    podcastSeries,
    episodes,
  ] = await Promise.all([
    // Scheduled content queries...

    // Podcast series access
    prisma.podcastAccess.findMany({
      where: { consulteeProfileId: consulteeId },
      include: { podcastPlan: true, payment: true },
    }),

    // Individual episode purchases
    prisma.episodePurchase.findMany({
      where: { consulteeProfileId: consulteeId },
      include: { episode: { include: { podcastPlan: true } }, payment: true },
    }),
  ]);

  const allContent: PurchasedContent[] = [
    ...consultations.map((c) => ({ type: "CONSULTATION" as const, data: c })),
    ...subscriptions.map((s) => ({ type: "SUBSCRIPTION" as const, data: s })),
    ...webinars.map((w) => ({ type: "WEBINAR" as const, data: w })),
    ...classes.map((c) => ({ type: "CLASS" as const, data: c })),
    ...podcastSeries.map((p) => ({ type: "PODCAST_SERIES" as const, data: p })),
    ...episodes.map((e) => ({ type: "PODCAST_EPISODE" as const, data: e })),
  ];

  return allContent.sort(
    (a, b) => getContentDate(b).getTime() - getContentDate(a).getTime(),
  );
}
```

---

## Revenue Analytics

### Consultant Dashboard

```typescript
interface RevenueBreakdown {
  total: number;
  byContentType: {
    consultations: number;
    subscriptions: number;
    webinars: number;
    classes: number;
    podcastSeries: number;
    podcastEpisodes: number;
  };
  growthMetrics: {
    scheduled: number; // Scheduled content revenue
    onDemand: number; // Podcast revenue
  };
}
```

---

## Database Indexes

### Recommended Indexes

```prisma
model PodcastPlan {
  id                  String   @id @default(cuid())
  consultantProfileId String
  isPublished         Boolean
  category            PodcastCategory

  @@index([consultantProfileId])
  @@index([isPublished])
  @@index([category])
  @@index([consultantProfileId, isPublished])
}

model PodcastEpisode {
  id                  String  @id @default(cuid())
  podcastPlanId       String? // Nullable for standalone
  consultantProfileId String
  status              PodcastEpisodeStatus
  publishedAt         DateTime?

  @@index([podcastPlanId])
  @@index([consultantProfileId])
  @@index([status])
  @@index([publishedAt])
  @@index([consultantProfileId, status])
}

model PodcastAccess {
  id                 String   @id @default(cuid())
  consulteeProfileId String
  podcastPlanId      String

  @@unique([consulteeProfileId, podcastPlanId])
  @@index([consulteeProfileId])
  @@index([podcastPlanId])
}

model EpisodePurchase {
  id                 String @id @default(cuid())
  consulteeProfileId String
  episodeId          String

  @@unique([consulteeProfileId, episodeId])
  @@index([consulteeProfileId])
  @@index([episodeId])
}

model Payment {
  id                String @id
  userId            String
  appointmentId     String?
  podcastAccessId   String?
  episodePurchaseId String?
  paymentStatus     PaymentStatus

  @@index([userId])
  @@index([appointmentId])
  @@index([podcastAccessId])
  @@index([episodePurchaseId])
  @@index([paymentStatus])
  @@index([userId, paymentStatus])
}
```

---

## API Patterns

### Dashboard Aggregator

```typescript
// GET /api/dashboard/consultee/[consulteeId]/content

export async function GET(request: Request, { params }) {
  const { consulteeId } = params;

  const [scheduled, podcastAccess, episodePurchases] = await Promise.all([
    // Existing scheduled content
    fetchScheduledContent(consulteeId),

    // Podcast series access
    prisma.podcastAccess.findMany({
      where: { consulteeProfileId: consulteeId },
      include: {
        podcastPlan: {
          select: {
            id: true,
            title: true,
            coverImageUrl: true,
            _count: { select: { episodes: true } },
          },
        },
        payment: { select: { amount: true, createdAt: true } },
      },
    }),

    // Individual episode purchases
    prisma.episodePurchase.findMany({
      where: { consulteeProfileId: consulteeId },
      include: {
        episode: {
          select: {
            id: true,
            title: true,
            audioFileUrl: true,
            podcastPlan: { select: { id: true, title: true } },
          },
        },
        payment: { select: { amount: true, createdAt: true } },
      },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      scheduled,
      podcasts: {
        series: podcastAccess,
        episodes: episodePurchases,
      },
    },
  });
}
```

---

## Migration Strategy

### Phase 1: Add Core Models

```bash
# Add PodcastPlan, PodcastEpisode, PodcastAccess, EpisodePurchase
npx prisma migrate dev --name add_podcast_models
```

### Phase 2: Update Payment

```sql
ALTER TABLE "Payment" ADD COLUMN "podcastAccessId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "episodePurchaseId" TEXT;

CREATE UNIQUE INDEX "Payment_podcastAccessId_key"
  ON "Payment"("podcastAccessId");

CREATE UNIQUE INDEX "Payment_episodePurchaseId_key"
  ON "Payment"("episodePurchaseId");
```

### Phase 3: Update Appointment (for live recordings)

```prisma
model Appointment {
  // ... existing fields

  podcastEpisode   PodcastEpisode? @relation(...)
  podcastEpisodeId String?         @unique
}

enum AppointmentsType {
  CONSULTATION
  SUBSCRIPTION
  WEBINAR
  CLASS
  PODCAST_LIVE  // NEW
}
```

---

## Complete Schema Reference

```prisma
// =====================================================
// PODCAST MODELS (NEW)
// =====================================================

model PodcastPlan {
  id                  String   @id @default(cuid())
  title               String
  description         String?  @db.Text
  coverImageUrl       String?

  // Pricing
  price               Int      // Series price (0 for free)
  priceCurrency       String   @default("INR")
  accessType          PodcastAccessType @default(PAID)

  // Metadata
  language            String?  @default("English")
  category            PodcastCategory @default(EDUCATION)
  tags                Tag[]    @relation("PodcastPlanToTag")

  // Settings
  isPublished         Boolean  @default(false)
  allowComments       Boolean  @default(true)
  allowDownloads      Boolean  @default(false)

  // Relations
  consultantProfile   ConsultantProfile @relation(fields: [consultantProfileId], references: [id])
  consultantProfileId String

  episodes            PodcastEpisode[]
  access              PodcastAccess[]  // Users with series access

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([consultantProfileId])
  @@index([isPublished])
  @@index([category])
  @@index([consultantProfileId, isPublished])
}

model PodcastEpisode {
  id                  String   @id @default(cuid())
  title               String
  description         String?  @db.Text
  episodeNumber       Int?     // Null for standalone episodes
  seasonNumber        Int?

  // Media
  audioFileUrl        String?  // Null until uploaded/recorded
  audioStoragePath    String?
  coverImageUrl       String?

  // Metadata
  durationInSeconds   Int?
  fileSize            Int?
  mimeType            String?

  // Content
  transcriptUrl       String?
  showNotes           String?  @db.Text

  // Status
  status              PodcastEpisodeStatus @default(DRAFT)
  publishedAt         DateTime?

  // Engagement
  playCount           Int      @default(0)
  likeCount           Int      @default(0)

  // Relations
  podcastPlan         PodcastPlan? @relation(fields: [podcastPlanId], references: [id])
  podcastPlanId       String?      // Nullable for standalone episodes

  consultantProfile   ConsultantProfile @relation(fields: [consultantProfileId], references: [id])
  consultantProfileId String

  // OPTIONAL: For live recordings
  appointment         Appointment? @relation(fields: [appointmentId], references: [id])
  appointmentId       String?      @unique

  // Individual purchases
  purchases           EpisodePurchase[]

  // Pricing (for à la carte sales)
  individualPrice     Int?         // Null = not sold individually

  comments            PodcastComment[]
  listenHistory       PodcastListenHistory[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([podcastPlanId, episodeNumber, seasonNumber])
  @@index([podcastPlanId])
  @@index([consultantProfileId])
  @@index([status])
  @@index([publishedAt])
  @@index([appointmentId])
}

model PodcastAccess {
  id          String   @id @default(cuid())
  startDate   DateTime @default(now())
  endDate     DateTime? // Null = lifetime
  accessLevel PodcastAccessLevel @default(FULL)

  consulteeProfile   ConsulteeProfile @relation(fields: [consulteeProfileId], references: [id])
  consulteeProfileId String

  podcastPlan        PodcastPlan @relation(fields: [podcastPlanId], references: [id])
  podcastPlanId      String

  payment            Payment?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([consulteeProfileId, podcastPlanId])
  @@index([consulteeProfileId])
  @@index([podcastPlanId])
}

model EpisodePurchase {
  id          String   @id @default(cuid())
  purchaseDate DateTime @default(now())

  consulteeProfile   ConsulteeProfile @relation(fields: [consulteeProfileId], references: [id])
  consulteeProfileId String

  episode            PodcastEpisode @relation(fields: [episodeId], references: [id])
  episodeId          String

  payment            Payment?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([consulteeProfileId, episodeId])
  @@index([consulteeProfileId])
  @@index([episodeId])
}

model PodcastListenHistory {
  id                    String   @id @default(cuid())
  lastPositionInSeconds Int      @default(0)
  completedPercentage   Float    @default(0)
  isCompleted           Boolean  @default(false)

  consulteeProfile   ConsulteeProfile @relation(fields: [consulteeProfileId], references: [id])
  consulteeProfileId String

  episode            PodcastEpisode @relation(fields: [episodeId], references: [id])
  episodeId          String

  lastPlayedAt DateTime @default(now())
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([consulteeProfileId, episodeId])
  @@index([consulteeProfileId])
  @@index([episodeId])
  @@index([lastPlayedAt])
}

model PodcastComment {
  id          String   @id @default(cuid())
  content     String   @db.Text
  isApproved  Boolean  @default(false)

  user        User     @relation(fields: [userId], references: [id])
  userId      String

  episode     PodcastEpisode @relation(fields: [episodeId], references: [id])
  episodeId   String

  parentComment   PodcastComment? @relation("CommentReplies", fields: [parentCommentId], references: [id])
  parentCommentId String?
  replies         PodcastComment[] @relation("CommentReplies")

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([episodeId])
  @@index([userId])
}

// =====================================================
// ENUMS
// =====================================================

enum PodcastAccessType {
  FREE
  PAID
  FREEMIUM  // Some episodes free, some paid
}

enum PodcastAccessLevel {
  PREVIEW_ONLY  // First 2 minutes only
  FULL          // Full access
}

enum PodcastEpisodeStatus {
  DRAFT
  SCHEDULED      // For live recordings
  PUBLISHED
  ARCHIVED
}

enum PodcastCategory {
  EDUCATION
  BUSINESS
  TECHNOLOGY
  HEALTH
  LIFESTYLE
  ENTERTAINMENT
  NEWS
  INTERVIEW
  STORYTELLING
  OTHER
}

// =====================================================
// UPDATED EXISTING MODELS
// =====================================================

model Payment {
  id             String         @id @default(uuid())
  amount         Int
  currency       String
  paymentStatus  PaymentStatus

  user           User          @relation(fields: [userId], references: [id])
  userId         String

  // FLEXIBLE LINKING - ONE will be populated
  appointment         Appointment?       @relation(fields: [appointmentId], references: [id])
  appointmentId       String?            @unique

  podcastAccess       PodcastAccess?     @relation(fields: [podcastAccessId], references: [id])
  podcastAccessId     String?            @unique

  episodePurchase     EpisodePurchase?   @relation(fields: [episodePurchaseId], references: [id])
  episodePurchaseId   String?            @unique

  // ... other fields

  @@index([userId])
  @@index([appointmentId])
  @@index([podcastAccessId])
  @@index([episodePurchaseId])
  @@index([paymentStatus])
}

model Appointment {
  id                 String              @id @default(uuid())
  appointmentType    AppointmentsType
  slotsOfAppointment SlotOfAppointment[]

  consultation   Consultation? @relation(...)
  subscription   Subscription? @relation(...)
  webinar        Webinar?      @relation(...)
  class          Class?        @relation(...)

  // NEW: Podcast live recording
  podcastEpisode   PodcastEpisode? @relation(...)
  podcastEpisodeId String?         @unique

  payment   Payment[]
  documents AppointmentDocument[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

enum AppointmentsType {
  CONSULTATION
  SUBSCRIPTION
  WEBINAR
  CLASS
  PODCAST_LIVE  // NEW
}

model ConsultantProfile {
  // ... existing fields

  consultationPlans ConsultationPlan[]
  subscriptionPlans SubscriptionPlan[]
  webinarPlans      WebinarPlan[]
  classPlans        ClassPlan[]
  podcastPlans      PodcastPlan[]       // NEW
  podcastEpisodes   PodcastEpisode[]    // NEW (for standalone episodes)
}

model ConsulteeProfile {
  // ... existing fields

  consultationRequests Consultation[]
  subscriptionRequests Subscription[]
  consultantReviews    ConsultantReview[]

  podcastAccess        PodcastAccess[]        // NEW
  episodePurchases     EpisodePurchase[]      // NEW
  podcastListenHistory PodcastListenHistory[] // NEW
}

model User {
  // ... existing fields

  Payment         Payment[]
  podcastComments PodcastComment[] // NEW
}

model Tag {
  // ... existing fields

  consultantProfiles ConsultantProfile[] @relation("ConsultantProfileToTag")
  podcastPlans       PodcastPlan[]       @relation("PodcastPlanToTag") // NEW
}
```

---

## Summary

### Architectural Decisions

| Aspect         | Decision                        | Alternative Options Rejected                                                          |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| **Naming**     | `PodcastPlan` + `PodcastAccess` | ❌ PodcastSubscription (naming collision)<br>⚠️ PodcastMembership (breaks convention) |
| **Episodes**   | Flexible (Series + Standalone)  | ❌ Series-Only (too restrictive)<br>❌ Standalone-Only (no bundling)                  |
| **Scheduling** | Hybrid (Live + On-Demand)       | ❌ On-Demand Only (misses live opportunity)<br>❌ Live-Only (too rigid)               |

### Key Features

- ✅ Consistent naming with existing `*Plan` pattern
- ✅ Support for podcast series AND standalone episodes
- ✅ Both live and pre-recorded workflows
- ✅ Individual episode purchases (à la carte)
- ✅ Series purchases (buy once, get all)
- ✅ Integration with existing Appointment/MeetingSession for live recordings
- ✅ Unified revenue analytics across all content types

### Migration Checklist

- [ ] Add podcast models to `schema.prisma`
- [ ] Run `prisma migrate dev --name add_podcasts`
- [ ] Update `Payment` model with podcast relations
- [ ] Update `Appointment` for live recordings
- [ ] Create podcast API routes
- [ ] Update dashboard aggregators
- [ ] Create TypeScript union types
- [ ] Add podcast UI components
- [ ] Test all workflows (series, standalone, live, pre-recorded)

---

**Next**: See `collaborators-implementation.md` for multi-creator podcasts and revenue sharing.
