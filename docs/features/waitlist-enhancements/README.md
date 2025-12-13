# Waitlist Enhancements

## Overview

Enhanced waitlist functionality that allows consultees to join waitlists for fully-booked consultants, webinars, and classes. Automatically notifies users when slots become available and enables priority booking.

### Value Proposition

- **Capture Demand**: Don't lose potential bookings due to full schedules
- **Reduce Abandonment**: Give users hope instead of "fully booked" dead ends
- **Smart Allocation**: Fair and efficient slot distribution when availability opens
- **Data Insights**: Understand true demand vs available supply

---

## User Stories

### Consultees

- As a consultee, I want to join a waitlist when my preferred consultant is fully booked
- As a consultee, I want to be notified immediately when a slot opens
- As a consultee, I want priority based on how long I've been waiting
- As a consultee, I want to see my position in the waitlist
- As a consultee, I want to leave the waitlist easily

### Consultants

- As a consultant, I want to see how many people are waiting for my slots
- As a consultant, I want to open additional slots and auto-notify waitlisted users
- As a consultant, I want to understand demand patterns to optimize my schedule

### Admins

- As an admin, I want to see overall waitlist metrics
- As an admin, I want to identify consultants with high waitlist demand

---

## Technical Architecture

### Database Schema

**Uses existing Waitlist model with minor enhancements:**

```prisma
// Existing model
model Waitlist {
  id              String   @id @default(cuid())
  userId          String
  webinarId       String?
  classId         String?

  // ENHANCEMENT: Add support for consultants and preferences
  consultantProfileId String?  // NEW: Waitlist for a specific consultant
  consultationPlanId  String?  // NEW: Specific plan they want

  // Waitlist metadata
  priority        Int      @default(0)     // Higher = higher priority
  position        Int?                     // Queue position (computed)
  preferences     Json?                    // { preferredTimes, priceRange, notes }

  // Status tracking
  status          WaitlistStatus @default(WAITING)
  notifiedAt      DateTime?      // When user was notified of opening
  expiresAt       DateTime?      // Notification expiry (24-48h to book)
  bookedAt        DateTime?      // If they successfully booked

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  user            User     @relation(fields: [userId], references: [id])
  webinar         Webinar? @relation(fields: [webinarId], references: [id])
  class           Class?   @relation(fields: [classId], references: [id])
  consultantProfile ConsultantProfile? @relation(fields: [consultantProfileId], references: [id])
  consultationPlan  ConsultationPlan?  @relation(fields: [consultationPlanId], references: [id])

  @@unique([userId, webinarId])
  @@unique([userId, classId])
  @@unique([userId, consultantProfileId, consultationPlanId]) // NEW
  @@index([consultantProfileId])
  @@index([status])
}

enum WaitlistStatus {
  WAITING       // In queue
  NOTIFIED      // Slot available, waiting for user to book
  BOOKED        // Successfully converted
  EXPIRED       // Notification expired, back to queue or removed
  CANCELLED     // User left waitlist
}
```

### Waitlist Flow

```
┌─────────────────────────────────────────────────────────┐
│                   WAITLIST LIFECYCLE                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. USER JOINS WAITLIST                                 │
│     ─────────────────────                               │
│     - Consultant/Webinar/Class is fully booked          │
│     - User clicks "Join Waitlist"                       │
│     - Record created with status: WAITING               │
│     - User sees position in queue                       │
│                                                         │
│  2. SLOT BECOMES AVAILABLE                              │
│     ─────────────────────────                           │
│     Triggers:                                           │
│     - Cancellation by another user                      │
│     - Consultant adds new slots                         │
│     - Webinar/Class capacity increased                  │
│                                                         │
│  3. NOTIFY NEXT IN QUEUE                                │
│     ────────────────────────                            │
│     - Find highest priority WAITING user                │
│     - Send notification (email + SMS + push)            │
│     - Update status: NOTIFIED                           │
│     - Set expiresAt (24-48 hours)                       │
│     - Hold slot temporarily                             │
│                                                         │
│  4. USER RESPONSE                                       │
│     ────────────────                                    │
│     A) User books → status: BOOKED ✓                   │
│     B) User declines → Notify next person              │
│     C) Timeout (48h) → status: EXPIRED → Notify next   │
│                                                         │
│  5. REPEAT until slot filled or waitlist empty          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Priority Calculation

```typescript
// lib/waitlist/priority.ts

interface PriorityFactors {
  timeInQueue: number; // Days waiting
  previousBookings: number; // With this consultant
  isPremiumUser: boolean; // If premium tier exists
  urgencyFlag: boolean; // User marked as urgent
}

export function calculatePriority(factors: PriorityFactors): number {
  let priority = 0;

  // Base priority: time in queue (1 point per day, max 30)
  priority += Math.min(factors.timeInQueue, 30);

  // Loyalty bonus: previous bookings with consultant
  priority += factors.previousBookings * 5;

  // Premium user bonus
  if (factors.isPremiumUser) {
    priority += 20;
  }

  // Urgency flag (manual admin/consultant override)
  if (factors.urgencyFlag) {
    priority += 50;
  }

  return priority;
}

export async function getNextInQueue(
  consultantProfileId: string,
  consultationPlanId?: string,
): Promise<Waitlist | null> {
  return prisma.waitlist.findFirst({
    where: {
      consultantProfileId,
      consultationPlanId,
      status: "WAITING",
    },
    orderBy: [
      { priority: "desc" },
      { createdAt: "asc" }, // FIFO for same priority
    ],
  });
}
```

### Slot Opening Handler

```typescript
// lib/waitlist/handlers.ts

export async function handleSlotOpening(
  type: "consultant" | "webinar" | "class",
  entityId: string,
  slotsAvailable: number = 1,
): Promise<void> {
  const whereClause = {
    consultant: { consultantProfileId: entityId },
    webinar: { webinarId: entityId },
    class: { classId: entityId },
  }[type];

  // Get waitlisted users in priority order
  const waitlistedUsers = await prisma.waitlist.findMany({
    where: {
      ...whereClause,
      status: "WAITING",
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: slotsAvailable,
    include: { user: true },
  });

  // Notify each user
  for (const entry of waitlistedUsers) {
    await notifyWaitlistUser(entry);
  }
}

async function notifyWaitlistUser(
  entry: Waitlist & { user: User },
): Promise<void> {
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

  // Update status
  await prisma.waitlist.update({
    where: { id: entry.id },
    data: {
      status: "NOTIFIED",
      notifiedAt: new Date(),
      expiresAt,
    },
  });

  // Send notifications via all channels
  await sendNotification(entry.userId, "WAITLIST_SLOT_AVAILABLE", {
    consultantName: entry.consultantProfile?.user?.name,
    bookingUrl: generateBookingUrl(entry),
    expiresAt,
  });
}

// Cron job to handle expired notifications
export async function processExpiredNotifications(): Promise<void> {
  const expiredEntries = await prisma.waitlist.findMany({
    where: {
      status: "NOTIFIED",
      expiresAt: { lt: new Date() },
    },
  });

  for (const entry of expiredEntries) {
    // Mark as expired
    await prisma.waitlist.update({
      where: { id: entry.id },
      data: { status: "EXPIRED" },
    });

    // Notify next in queue
    await handleSlotOpening(
      entry.webinarId ? "webinar" : entry.classId ? "class" : "consultant",
      entry.webinarId || entry.classId || entry.consultantProfileId!,
      1,
    );
  }
}
```

### API Endpoints

```
POST /api/waitlist
  Body: {
    type: 'consultant' | 'webinar' | 'class',
    entityId: string,
    planId?: string,
    preferences?: { preferredTimes, notes }
  }
  Returns: { waitlistId, position }

GET /api/waitlist
  Query: ?userId=xxx
  Returns: User's waitlist entries with positions

GET /api/waitlist/[id]
  Returns: Specific waitlist entry details

DELETE /api/waitlist/[id]
  Action: Leave waitlist (status: CANCELLED)

GET /api/waitlist/stats/[consultantId]
  Auth: Consultant only
  Returns: { total, byPlan, averageWaitTime }

POST /api/waitlist/[id]/respond
  Body: { action: 'book' | 'decline' | 'extend' }
  Action: User response to notification

// Internal/Webhook triggers
POST /api/internal/waitlist/slot-opened
  Body: { type, entityId, slots }
  Trigger: Called when slot becomes available
```

---

## UI/UX Design

### Join Waitlist (Consultant Profile Page)

```
┌─────────────────────────────────────────────────────────┐
│  Book a Consultation with Priya Sharma                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ⚠️ Fully Booked                                        │
│  Priya's schedule is currently full for the next       │
│  2 weeks.                                               │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  🔔 Join Waitlist                                   ││
│  │                                                     ││
│  │  Get notified when a slot opens up.                 ││
│  │  Current waitlist: 3 people                         ││
│  │                                                     ││
│  │  Preferred times (optional):                        ││
│  │  ☑ Weekday mornings   ☐ Weekday evenings          ││
│  │  ☐ Weekends           ☐ Any time                  ││
│  │                                                     ││
│  │  Notes for consultant (optional):                   ││
│  │  ┌─────────────────────────────────────────────┐   ││
│  │  │ I'm launching next month, urgent...          │   ││
│  │  └─────────────────────────────────────────────┘   ││
│  │                                                     ││
│  │  [Join Waitlist - Free]                            ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ─ OR ─                                                 │
│                                                         │
│  [Browse Similar Experts]                               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Waitlist Confirmation

```
┌─────────────────────────────────────────────────────────┐
│  ✓ You're on the Waitlist!                             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Waiting for: Priya Sharma - 1-on-1 Consultation       │
│                                                         │
│  Your position: #4 in queue                            │
│  Estimated wait: 3-5 days                              │
│                                                         │
│  We'll notify you via:                                 │
│  ✓ Email (john@example.com)                           │
│  ✓ SMS (+91 98765 43210)                              │
│                                                         │
│  When a slot opens, you'll have 48 hours to book.     │
│                                                         │
│  [View My Waitlists]  [Leave Waitlist]                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Slot Available Notification

```
┌─────────────────────────────────────────────────────────┐
│  🎉 A Slot Just Opened!                                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Great news! Priya Sharma has availability.            │
│                                                         │
│  Available slot:                                        │
│  📅 Thursday, Dec 12 at 3:00 PM IST                    │
│  ⏱️ 60 minutes                                         │
│  💰 ₹1,500                                             │
│                                                         │
│  ⚠️ This slot is reserved for you for 48 hours        │
│     Expires: Dec 11, 2024 at 5:30 PM                   │
│                                                         │
│  [Book Now - ₹1,500]                                   │
│                                                         │
│  Can't make this time?                                  │
│  [Pass to Next Person]  [Stay on Waitlist]            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### My Waitlists Page (`/dashboard/waitlists`)

```
┌─────────────────────────────────────────────────────────┐
│  My Waitlists                                           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Active (2)                                             │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 🔔 ACTION REQUIRED                                  ││
│  │ Priya Sharma - Consultation                         ││
│  │ Slot available! Expires in 36 hours                 ││
│  │ [Book Now]  [Pass]                                  ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Rahul Verma - Subscription Plan                     ││
│  │ Position: #2 | Joined: 3 days ago                   ││
│  │ Est. wait: 1-2 weeks                                ││
│  │ [Leave Waitlist]                                    ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Past (1)                                               │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ ✓ Neha Gupta - Webinar                             ││
│  │ Booked on Dec 5 | Session: Dec 15                   ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Consultant Waitlist Dashboard

```
┌─────────────────────────────────────────────────────────┐
│  Waitlist Overview                                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Total Waiting: 12 people                               │
│  Avg. Wait Time: 4.5 days                              │
│  Conversion Rate: 78%                                   │
│                                                         │
│  By Plan:                                               │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Plan                    │ Waiting │ Avg Wait       ││
│  │─────────────────────────│─────────│────────────────││
│  │ 1-on-1 Consultation     │    8    │ 3 days         ││
│  │ Strategy Session        │    3    │ 7 days         ││
│  │ Monthly Subscription    │    1    │ 2 days         ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  💡 High demand! Consider adding more slots on         │
│     weekday mornings.                                   │
│                                                         │
│  [Add Availability]  [View Waitlist Details]           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: Core Waitlist for Consultants

1. Add `consultantProfileId` and `consultationPlanId` to Waitlist model
2. Implement join/leave waitlist APIs
3. Build waitlist position calculation
4. Create basic UI for joining waitlist

### Phase 2: Notification System

1. Integrate with notification-channels feature
2. Implement slot-opening trigger (on cancellation)
3. Build notification flow with expiration
4. Create "Slot Available" notification UI

### Phase 3: Priority & Queue Management

1. Implement priority scoring algorithm
2. Add preferences capture (preferred times)
3. Build consultant waitlist dashboard
4. Add queue position visibility

### Phase 4: Advanced Features

1. Estimated wait time calculation
2. Demand insights for consultants
3. Auto-suggest adding slots when waitlist is long
4. Waitlist analytics in admin dashboard

---

## Dependencies

### Depends On

- Existing Waitlist model
- Notification Channels feature (SMS/WhatsApp)
- Booking/Cancellation flows

### Features That Depend On This

- **Analytics Dashboard** - Waitlist metrics
- **Smart Matching** - Show "Join Waitlist" for popular consultants

---

## Edge Cases

1. **Multiple slots open at once**: Notify multiple users simultaneously
2. **User already has booking**: Don't notify if they have upcoming session
3. **Consultant deactivates**: Clear or pause waitlist entries
4. **User notification failure**: Retry 3x before moving to next person
5. **Slot booked directly**: Check if waitlisted user booked it themselves
