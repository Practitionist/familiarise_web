# Analytics Dashboard

## Overview

A comprehensive analytics dashboard for consultants, consultees, and platform admins to track performance, engagement, and business metrics. Provides actionable insights through visualizations and reports.

### Value Proposition

- **Consultants**: Understand booking patterns, revenue trends, client retention
- **Consultees**: Track consultation history, spending, learning progress
- **Admins**: Monitor platform health, revenue, user growth, support metrics

---

## User Stories

### Consultant Dashboard

- As a consultant, I want to see my total earnings this month vs last month
- As a consultant, I want to know my busiest days/times to optimize availability
- As a consultant, I want to see which service types generate the most revenue
- As a consultant, I want to track my rating trend over time
- As a consultant, I want to identify clients who haven't rebooked

### Consultee Dashboard

- As a consultee, I want to see my total consultations completed
- As a consultee, I want to track my spending by category/domain
- As a consultee, I want to see my most-consulted experts
- As a consultee, I want to view my upcoming vs completed sessions ratio

### Admin Dashboard

- As an admin, I want to see platform-wide revenue and growth metrics
- As an admin, I want to identify top-performing consultants
- As an admin, I want to track support ticket resolution times
- As an admin, I want to monitor payment success/failure rates

---

## Technical Architecture

### Database Schema

**No new models required.** All analytics are computed from existing models:

```
Existing Models Used:
├── Payment (revenue, transactions)
├── Appointment (bookings, status)
├── Consultation/Subscription/Webinar/Class (service types)
├── ConsultantReview (ratings, feedback)
├── User (growth, signups)
├── SupportTicket (support metrics)
└── Refund/Dispute (financial health)
```

### Key Aggregation Queries

```typescript
// Consultant Revenue Summary
const revenueStats = await prisma.payment.aggregate({
  where: {
    paymentStatus: "SUCCEEDED",
    appointment: {
      OR: [
        { consultation: { consultationPlan: { consultantProfileId } } },
        { subscription: { subscriptionPlan: { consultantProfileId } } },
        // ... webinar, class
      ],
    },
    createdAt: { gte: startDate, lte: endDate },
  },
  _sum: { amount: true },
  _count: true,
});

// Booking by Day of Week
const bookingsByDay = await prisma.$queryRaw`
  SELECT
    EXTRACT(DOW FROM "createdAt") as day_of_week,
    COUNT(*) as booking_count
  FROM "Appointment"
  WHERE "consultantProfileId" = ${consultantProfileId}
  GROUP BY day_of_week
  ORDER BY day_of_week
`;

// Client Retention (returning clients)
const returningClients = await prisma.consultation.groupBy({
  by: ["consulteeProfileId"],
  where: { consultationPlan: { consultantProfileId } },
  _count: true,
  having: { consulteeProfileId: { _count: { gt: 1 } } },
});
```

### API Endpoints

```
GET /api/dashboard/consultant/[id]/analytics
  Query: ?period=7d|30d|90d|1y&metrics=revenue,bookings,ratings

GET /api/dashboard/consultee/[id]/analytics
  Query: ?period=30d&metrics=spending,sessions,domains

GET /api/admin/analytics
  Query: ?period=30d&metrics=revenue,users,support,payments
  Auth: ADMIN role required

GET /api/admin/analytics/export
  Query: ?format=csv|json&period=30d
  Returns: Downloadable report
```

### Response Schema

```typescript
interface ConsultantAnalytics {
  period: { start: string; end: string };

  revenue: {
    total: number;
    currency: string;
    byServiceType: {
      consultation: number;
      subscription: number;
      webinar: number;
      class: number;
    };
    trend: number; // % change from previous period
  };

  bookings: {
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
    byDayOfWeek: Record<string, number>;
    byTimeOfDay: Record<string, number>;
  };

  clients: {
    total: number;
    new: number;
    returning: number;
    retentionRate: number;
  };

  ratings: {
    average: number;
    count: number;
    distribution: Record<1 | 2 | 3 | 4 | 5, number>;
    trend: number;
  };
}
```

### External Integrations

None required - all data comes from internal database.

Optional enhancements:

- **Chart.js / Recharts** - Frontend visualization
- **Redis** - Cache computed metrics (TTL: 5-15 minutes)
- **Cron Jobs** - Pre-compute daily/weekly aggregates

---

## UI/UX Design

### Consultant Dashboard (`/dashboard/consultant/analytics`)

```
┌─────────────────────────────────────────────────────────┐
│  Period Selector: [7 Days] [30 Days] [90 Days] [1 Year] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐│
│  │ Revenue  │  │ Bookings │  │ Clients  │  │ Rating   ││
│  │ $12,450  │  │    47    │  │    32    │  │   4.8    ││
│  │ +12% ▲   │  │ +5% ▲    │  │ +8% ▲    │  │ +0.2 ▲   ││
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │              Revenue Over Time (Line Chart)         ││
│  │  $                                                  ││
│  │  │    ╱╲      ╱╲                                    ││
│  │  │   ╱  ╲    ╱  ╲   ╱╲                             ││
│  │  │  ╱    ╲  ╱    ╲ ╱  ╲                            ││
│  │  └─────────────────────────────────────────────────││
│  │    Mon  Tue  Wed  Thu  Fri  Sat  Sun               ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────┐  ┌─────────────────────────────┐│
│  │ Revenue by Service  │  │ Bookings by Day of Week    ││
│  │   (Pie Chart)       │  │   (Bar Chart)              ││
│  │  ┌───┐              │  │  █                         ││
│  │  │ C │ Consultation │  │  █ █     █                 ││
│  │  │ S │ Subscription │  │  █ █ █   █ █               ││
│  │  │ W │ Webinar      │  │  █ █ █ █ █ █ █             ││
│  │  └───┘              │  │  M T W T F S S             ││
│  └─────────────────────┘  └─────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  Top Clients                    Sessions  Revenue   ││
│  │  ─────────────────────────────────────────────────  ││
│  │  1. John Doe                       8      $1,200    ││
│  │  2. Jane Smith                     6      $900      ││
│  │  3. Bob Johnson                    5      $750      ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### Admin Dashboard (`/admin/analytics`)

```
┌─────────────────────────────────────────────────────────┐
│  Platform Overview - Last 30 Days                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐│
│  │ Revenue  │  │  Users   │  │ Bookings │  │ Support  ││
│  │ $125,000 │  │  2,450   │  │   890    │  │ 95% SLA  ││
│  │ +18% ▲   │  │ +220 new │  │ +12% ▲   │  │ 24hr avg ││
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  Revenue & User Growth (Dual Axis Chart)            ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────┐  ┌─────────────────────────────┐│
│  │ Top Consultants     │  │ Payment Success Rate       ││
│  │ by Revenue          │  │   (Gauge Chart)            ││
│  │  1. Expert A $8,500 │  │      ┌───────┐              ││
│  │  2. Expert B $7,200 │  │      │ 98.5% │              ││
│  │  3. Expert C $6,100 │  │      └───────┘              ││
│  └─────────────────────┘  └─────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  [Export CSV]  [Export JSON]  [Schedule Report]     ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### Components

```
components/
├── analytics/
│   ├── MetricCard.tsx          # Single KPI with trend
│   ├── PeriodSelector.tsx      # Time range picker
│   ├── RevenueChart.tsx        # Line/area chart
│   ├── BookingHeatmap.tsx      # Day/time heatmap
│   ├── ServicePieChart.tsx     # Revenue by service type
│   ├── TopClientsTable.tsx     # Leaderboard table
│   ├── RatingDistribution.tsx  # Star rating breakdown
│   └── ExportButton.tsx        # CSV/JSON export
```

---

## Implementation Approach

### Phase 1: Core Metrics (Backend)

1. Create analytics service with aggregation functions
2. Implement caching layer (Redis or in-memory)
3. Build API endpoints for consultant/admin dashboards
4. Add scheduled job for daily metric snapshots

```typescript
// lib/analytics/consultant.ts
export async function getConsultantAnalytics(
  consultantProfileId: string,
  period: "7d" | "30d" | "90d" | "1y",
): Promise<ConsultantAnalytics> {
  const cacheKey = `analytics:consultant:${consultantProfileId}:${period}`;

  // Check cache first
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Compute metrics
  const [revenue, bookings, clients, ratings] = await Promise.all([
    computeRevenue(consultantProfileId, period),
    computeBookings(consultantProfileId, period),
    computeClients(consultantProfileId, period),
    computeRatings(consultantProfileId, period),
  ]);

  const result = { period, revenue, bookings, clients, ratings };

  // Cache for 15 minutes
  await redis.setex(cacheKey, 900, JSON.stringify(result));

  return result;
}
```

### Phase 2: Dashboard UI (Frontend)

1. Build reusable chart components
2. Create consultant analytics page
3. Create admin analytics page
4. Add responsive design for mobile

### Phase 3: Advanced Features

1. Custom date range picker
2. Export functionality (CSV, PDF)
3. Scheduled email reports
4. Comparison views (this period vs last period)
5. Goal setting and tracking

---

## Dependencies

### Depends On

- Existing Payment, Appointment, Review models
- Authentication system (role-based access)
- Redis (optional, for caching)

### Features That Depend On This

- **Consultant Badges** - Uses analytics to award badges
- **Smart Matching** - Uses consultant performance data
- **Admin Reports** - Extends analytics export

---

## Performance Considerations

1. **Caching**: Cache computed metrics for 5-15 minutes
2. **Pagination**: Limit "Top Clients" lists to 10-20 items
3. **Indexed Queries**: Ensure indexes on `createdAt`, `consultantProfileId`
4. **Materialized Views**: Consider for complex aggregations on large datasets
5. **Background Jobs**: Pre-compute daily/weekly snapshots overnight

---

## Security

- Consultants can only view their own analytics
- Consultees can only view their own usage
- Admin endpoints require `ADMIN` role
- Export endpoints rate-limited to prevent abuse
