# Consultant Badges

## Overview

Award achievement badges to consultants based on their performance, engagement, and milestones. Badges serve as trust signals for consultees and motivate consultants to maintain quality.

### Value Proposition

- **Trust Signals**: Help consultees identify quality consultants
- **Motivation**: Gamification encourages better performance
- **Differentiation**: Stand out with visible achievements
- **Quality Control**: Incentivize platform standards

---

## User Stories

### Consultants

- As a consultant, I want to earn badges for my achievements
- As a consultant, I want to display badges on my profile
- As a consultant, I want to understand how to earn each badge
- As a consultant, I want to be notified when I earn a new badge

### Consultees

- As a consultee, I want to see consultant badges before booking
- As a consultee, I want to understand what each badge means
- As a consultee, I want to filter consultants by badges

---

## Technical Architecture

### Database Schema

**Option A: Add field to ConsultantProfile (Recommended)**

```prisma
model ConsultantProfile {
  // Existing fields...

  // NEW: Badges array
  badges String[] @default([])
  // Stores badge IDs like: ["top_rated", "rising_star", "100_consultations"]
}
```

**Option B: Separate Badge model (For complex badge logic)**

```prisma
model Badge {
  id              String @id @default(cuid())
  name            String @unique
  displayName     String
  description     String
  icon            String              // Emoji or icon URL
  category        BadgeCategory
  criteria        Json                // Earning criteria
  tier            BadgeTier @default(STANDARD)

  consultants     ConsultantBadge[]

  createdAt       DateTime @default(now())
}

model ConsultantBadge {
  id                  String @id @default(cuid())
  consultantProfile   ConsultantProfile @relation(...)
  consultantProfileId String
  badge               Badge @relation(...)
  badgeId             String
  earnedAt            DateTime @default(now())
  expiresAt           DateTime?         // For time-limited badges

  @@unique([consultantProfileId, badgeId])
}

enum BadgeCategory {
  PERFORMANCE    // Based on ratings, reviews
  ENGAGEMENT     // Response time, activity
  MILESTONE      // Consultation count, revenue
  VERIFICATION   // Identity, credentials
  SPECIAL        // Platform awarded
}

enum BadgeTier {
  STANDARD
  SILVER
  GOLD
  PLATINUM
}
```

**Recommendation**: Start with Option A for simplicity. Use configuration-driven badge definitions.

### Badge Definitions

```typescript
// lib/badges/definitions.ts

export interface BadgeDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'performance' | 'engagement' | 'milestone' | 'verification' | 'special';
  tier?: 'standard' | 'silver' | 'gold' | 'platinum';
  criteria: BadgeCriteria;
  expirationDays?: number;  // If badge can expire
}

interface BadgeCriteria {
  type: 'threshold' | 'streak' | 'manual';
  metric?: string;
  value?: number;
  period?: 'all_time' | '30_days' | '90_days';
}

export const BADGES: BadgeDefinition[] = [
  // PERFORMANCE BADGES
  {
    id: 'top_rated',
    name: 'Top Rated',
    description: 'Maintains 4.8+ rating with 10+ reviews',
    icon: '⭐',
    category: 'performance',
    tier: 'gold',
    criteria: {
      type: 'threshold',
      metric: 'rating',
      value: 96,  // 4.8 out of 5 = 96%
      period: 'all_time',
    },
  },
  {
    id: 'highly_reviewed',
    name: 'Highly Reviewed',
    description: '50+ positive reviews',
    icon: '💬',
    category: 'performance',
    criteria: {
      type: 'threshold',
      metric: 'review_count',
      value: 50,
    },
  },

  // ENGAGEMENT BADGES
  {
    id: 'quick_responder',
    name: 'Quick Responder',
    description: 'Responds to requests within 2 hours',
    icon: '⚡',
    category: 'engagement',
    criteria: {
      type: 'threshold',
      metric: 'avg_response_time_hours',
      value: 2,
      period: '30_days',
    },
    expirationDays: 30,  // Must maintain
  },
  {
    id: 'super_active',
    name: 'Super Active',
    description: 'Online and available regularly',
    icon: '🟢',
    category: 'engagement',
    criteria: {
      type: 'threshold',
      metric: 'active_days',
      value: 25,
      period: '30_days',
    },
    expirationDays: 30,
  },

  // MILESTONE BADGES
  {
    id: 'first_consultation',
    name: 'First Steps',
    description: 'Completed first consultation',
    icon: '🎯',
    category: 'milestone',
    criteria: { type: 'threshold', metric: 'consultation_count', value: 1 },
  },
  {
    id: '50_consultations',
    name: 'Experienced',
    description: 'Completed 50 consultations',
    icon: '📚',
    category: 'milestone',
    tier: 'silver',
    criteria: { type: 'threshold', metric: 'consultation_count', value: 50 },
  },
  {
    id: '100_consultations',
    name: 'Expert Advisor',
    description: 'Completed 100 consultations',
    icon: '🏆',
    category: 'milestone',
    tier: 'gold',
    criteria: { type: 'threshold', metric: 'consultation_count', value: 100 },
  },
  {
    id: '500_consultations',
    name: 'Master Consultant',
    description: 'Completed 500 consultations',
    icon: '👑',
    category: 'milestone',
    tier: 'platinum',
    criteria: { type: 'threshold', metric: 'consultation_count', value: 500 },
  },

  // VERIFICATION BADGES
  {
    id: 'verified_identity',
    name: 'Verified Identity',
    description: 'Identity verified by platform',
    icon: '✓',
    category: 'verification',
    criteria: { type: 'manual' },
  },
  {
    id: 'verified_credentials',
    name: 'Verified Credentials',
    description: 'Professional credentials verified',
    icon: '🎓',
    category: 'verification',
    criteria: { type: 'manual' },
  },

  // SPECIAL BADGES
  {
    id: 'rising_star',
    name: 'Rising Star',
    description: 'New consultant with exceptional early performance',
    icon: '🌟',
    category: 'special',
    criteria: {
      type: 'threshold',
      metric: 'rating_in_first_90_days',
      value: 96,
    },
    expirationDays: 180,  // Valid for 6 months
  },
  {
    id: 'platform_pick',
    name: 'Platform Pick',
    description: 'Handpicked by Familiarise team',
    icon: '💎',
    category: 'special',
    tier: 'platinum',
    criteria: { type: 'manual' },
  },
];

export function getBadgeById(id: string): BadgeDefinition | undefined {
  return BADGES.find(b => b.id === id);
}
```

### Badge Evaluation Engine

```typescript
// lib/badges/evaluator.ts

export async function evaluateBadges(consultantProfileId: string): Promise<string[]> {
  const profile = await prisma.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    include: {
      _count: {
        select: {
          consultationPlans: true,
        },
      },
    },
  });

  if (!profile) return [];

  const metrics = await gatherMetrics(consultantProfileId);
  const earnedBadges: string[] = [];

  for (const badge of BADGES) {
    if (badge.criteria.type === 'manual') continue;

    const meetsThreshold = evaluateCriteria(badge.criteria, metrics);
    if (meetsThreshold) {
      earnedBadges.push(badge.id);
    }
  }

  return earnedBadges;
}

async function gatherMetrics(consultantProfileId: string): Promise<Record<string, number>> {
  const [
    consultationCount,
    avgRating,
    reviewCount,
    avgResponseTime,
    activeDays,
  ] = await Promise.all([
    getConsultationCount(consultantProfileId),
    getAverageRating(consultantProfileId),
    getReviewCount(consultantProfileId),
    getAverageResponseTime(consultantProfileId),
    getActiveDays(consultantProfileId, 30),
  ]);

  return {
    consultation_count: consultationCount,
    rating: avgRating,
    review_count: reviewCount,
    avg_response_time_hours: avgResponseTime,
    active_days: activeDays,
  };
}

function evaluateCriteria(
  criteria: BadgeCriteria,
  metrics: Record<string, number>
): boolean {
  if (criteria.type !== 'threshold' || !criteria.metric || criteria.value === undefined) {
    return false;
  }

  const metricValue = metrics[criteria.metric];
  if (metricValue === undefined) return false;

  // For response time, lower is better
  if (criteria.metric.includes('response_time')) {
    return metricValue <= criteria.value;
  }

  return metricValue >= criteria.value;
}

// Scheduled job to update badges
export async function updateAllBadges(): Promise<void> {
  const consultants = await prisma.consultantProfile.findMany({
    where: { isActive: true },
    select: { id: true, badges: true },
  });

  for (const consultant of consultants) {
    const earnedBadges = await evaluateBadges(consultant.id);

    // Check for expired badges
    const validBadges = earnedBadges.filter(badgeId => {
      const badge = getBadgeById(badgeId);
      if (!badge?.expirationDays) return true;
      // Check if still meets criteria (already done in evaluateBadges)
      return true;
    });

    // Update if changed
    if (JSON.stringify(validBadges.sort()) !== JSON.stringify([...consultant.badges].sort())) {
      const newBadges = validBadges.filter(b => !consultant.badges.includes(b));

      await prisma.consultantProfile.update({
        where: { id: consultant.id },
        data: { badges: validBadges },
      });

      // Notify about new badges
      for (const badgeId of newBadges) {
        await notifyNewBadge(consultant.id, badgeId);
      }
    }
  }
}
```

### API Endpoints

```
GET /api/badges
  Returns: All badge definitions

GET /api/consultants/[id]/badges
  Returns: Consultant's earned badges with details

POST /api/admin/badges/award
  Body: { consultantProfileId, badgeId }
  Action: Manually award badge (admin only)

POST /api/admin/badges/revoke
  Body: { consultantProfileId, badgeId }
  Action: Remove badge (admin only)

GET /api/explore/consultants?badges=top_rated,verified
  Action: Filter consultants by badges
```

---

## UI/UX Design

### Badge Display on Profile

```
┌─────────────────────────────────────────────────────────┐
│  Priya Sharma                                           │
│  Marketing Strategist                                   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Badges                                                 │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐              │
│  │ ⭐  │ │ ⚡  │ │ 🏆  │ │ ✓   │ │ 💎  │              │
│  │Top  │ │Quick│ │100+ │ │Veri-│ │Pick │              │
│  │Rated│ │Resp │ │Cons │ │fied │ │     │              │
│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘              │
│                                                         │
│  ⭐ 4.9 (47 reviews) | 156 consultations               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Badge Tooltip/Modal

```
┌─────────────────────────────────────────────────────────┐
│  ⭐ Top Rated                                           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  This consultant maintains an exceptional rating        │
│  of 4.8 or higher with at least 10 reviews.            │
│                                                         │
│  Category: Performance                                  │
│  Tier: Gold                                            │
│                                                         │
│  Earned: November 15, 2024                             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Badge Progress (Consultant Dashboard)

```
┌─────────────────────────────────────────────────────────┐
│  Your Badges                                            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Earned (5)                                             │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ⭐ Top Rated         🏆 Expert Advisor   ✓ Verified   │
│  ⚡ Quick Responder   💎 Platform Pick                 │
│                                                         │
│  In Progress (2)                                        │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 👑 Master Consultant                                ││
│  │ Complete 500 consultations                          ││
│  │                                                     ││
│  │ ████████████████░░░░  156/500 (31%)                ││
│  │                                                     ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 💬 Highly Reviewed                                  ││
│  │ Get 50+ positive reviews                            ││
│  │                                                     ││
│  │ ██████████████████░░  47/50 (94%)                  ││
│  │                                                     ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Available Badges                                       │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  🌟 Rising Star - New consultant with great ratings    │
│  🎓 Verified Credentials - Get credentials verified    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Filter by Badges (Explore Page)

```
┌─────────────────────────────────────────────────────────┐
│  Filter Consultants                                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Badges                                                 │
│  ─────                                                  │
│  ☑ ⭐ Top Rated                                        │
│  ☐ ⚡ Quick Responder                                  │
│  ☑ ✓ Verified Identity                                │
│  ☐ 🏆 Expert Advisor (100+ sessions)                  │
│  ☐ 💎 Platform Pick                                   │
│                                                         │
│  [Apply Filters]                                        │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: Basic Badges

1. Add `badges` field to ConsultantProfile
2. Define initial badge set (5-7 badges)
3. Build badge evaluation logic
4. Display badges on profile

### Phase 2: Badge Management

1. Admin interface for manual badges
2. Badge progress tracking UI
3. New badge notifications
4. Badge tooltips with explanations

### Phase 3: Advanced Features

1. Badge filtering on explore page
2. Badge leaderboards
3. Time-limited badges (expiration)
4. Tiered badges (bronze/silver/gold)

### Phase 4: Gamification

1. Badge achievement announcements
2. Progress milestones notifications
3. Badge showcase on public profile
4. Social sharing of achievements

---

## Dependencies

### Depends On

- ConsultantProfile model
- Review/Rating system
- Analytics data for metrics

### Features That Depend On This

- **Smart Matching** - Badge weight in matching algorithm
- **Analytics Dashboard** - Badge acquisition metrics

---

## Badge Ideas by Category

### Performance
- Top Rated (4.8+ rating)
- Highly Reviewed (50+ reviews)
- Perfect Score (5.0 rating, 10+ reviews)
- Consistent Quality (4.5+ for 6 months)

### Engagement
- Quick Responder (< 2hr response)
- Super Active (25+ active days/month)
- Always Available (never missed a session)
- Early Bird (available mornings)

### Milestones
- First Steps (1 consultation)
- Growing (10 consultations)
- Experienced (50 consultations)
- Expert (100 consultations)
- Master (500 consultations)
- Legend (1000 consultations)

### Revenue
- Rising Revenue (growing month-over-month)
- Top Earner (top 10% by revenue)

### Verification
- Verified Identity
- Verified Credentials
- Background Checked
- LinkedIn Verified

### Special
- Rising Star (new + high rated)
- Platform Pick (staff selected)
- Community Champion (helps others)
- Content Creator (webinars/classes)
