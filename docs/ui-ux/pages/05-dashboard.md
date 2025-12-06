# Dashboard Pages Modernization Guide

> **Routes**: `/dashboard/consultant/[id]/*`, `/dashboard/consultee/[id]/*`
> **Priority**: P1 - Important
> **Current Issues**: Slow redirect, basic UI, lack of quick actions

---

## Current State Analysis

### What's Working
- Role-based routing (Consultant, Consultee, Admin, Staff)
- React Query for data fetching
- Error boundaries
- Loading skeletons

### Critical Issues
1. **Slow loading redirect** - Shows progress bar while determining role
2. **Basic dashboard UI** - Doesn't feel premium
3. **No quick actions** - Users have to navigate deeply
4. **Missing notifications** - No real-time updates
5. **No analytics overview** - Missing business insights
6. **Calendar not prominent** - Buried in navigation

---

## Dashboard Loading Experience

### Current Problem
```
User clicks "Dashboard"
    ↓
Shows loading card with progress bar (1-2 seconds)
    ↓
Determines user role
    ↓
Redirects to role-specific dashboard
    ↓
Shows another skeleton (1-2 seconds)
    ↓
Finally shows content
```

### Improved Flow
```
User clicks "Dashboard"
    ↓
Instant redirect (role cached in session)
    ↓
Show skeleton with content outline
    ↓
Stream in data progressively
```

### Implementation
```tsx
// middleware.ts - Redirect based on cached role
export async function middleware(request: NextRequest) {
  const session = await getSession(request);

  if (request.nextUrl.pathname === '/dashboard') {
    // Use cached role from session token
    const role = session?.user?.role;
    const profileId = session?.user?.profileId;

    if (role === 'CONSULTANT' && profileId) {
      return NextResponse.redirect(
        new URL(`/dashboard/consultant/${profileId}/home`, request.url)
      );
    }
    // ... other roles
  }
}
```

---

## Consultant Dashboard Redesign

### Desktop Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  SIDEBAR                    │  MAIN CONTENT                         │
│  (240px, collapsible)       │                                       │
├─────────────────────────────┼───────────────────────────────────────┤
│                             │                                        │
│  ┌─────────────────────┐   │  HEADER                                │
│  │  👤 Sarah Chen       │   │  ┌────────────────────────────────────┐│
│  │  Product Lead        │   │  │ Good morning, Sarah!              ││
│  │  🟢 Online          │   │  │ You have 3 sessions today         ││
│  └─────────────────────┘   │  │                                    ││
│                             │  │ [+ New Availability] [Settings]   ││
│  ───────────────────────   │  └────────────────────────────────────┘│
│                             │                                        │
│  📊 Overview              │  STATS ROW                              │
│  📅 Appointments   (3)    │  ┌─────────┐┌─────────┐┌─────────┐┌────┐│
│  💬 Messages       (5)    │  │Earnings ││Sessions ││ Rating  ││Resp││
│  📝 Requests       (2)    │  │ $4,250  ││   23    ││  4.9    ││ 2h ││
│  📄 Documents            │  │ +12% ▲  ││  +5 ▲   ││  +0.1   ││    ││
│  📆 Planner              │  └─────────┘└─────────┘└─────────┘└────┘│
│  ⚙️ Settings             │                                        │
│  ❓ Help                  │  ┌─────────────────────────────────────┐│
│                             │  │                                    ││
│  ───────────────────────   │  │  TODAY'S SCHEDULE                  ││
│                             │  │                                    ││
│  QUICK ACTIONS              │  │  ┌────────────────────────────────┐││
│  ┌─────────────────────┐   │  │  │ 9:00 AM                        │││
│  │ ▢ Block time        │   │  │  │ Alex M. • 1:1 Consultation    │││
│  │ ▢ Set away         │   │  │  │ Topic: Career transition       │││
│  │ ▢ Share profile    │   │  │  │ [Join Call] [View Details]     │││
│  └─────────────────────┘   │  │  └────────────────────────────────┘││
│                             │  │                                    ││
│                             │  │  ┌────────────────────────────────┐││
│                             │  │  │ 11:00 AM                       │││
│                             │  │  │ Jennifer W. • PM Masterclass   │││
│                             │  │  │ Class Session 4/8              │││
│                             │  │  │ [Join Class] [Materials]       │││
│                             │  │  └────────────────────────────────┘││
│                             │  │                                    ││
│                             │  │  ┌────────────────────────────────┐││
│                             │  │  │ 3:00 PM                        │││
│                             │  │  │ Product Strategy Webinar       │││
│                             │  │  │ 156 registered attendees       │││
│                             │  │  │ [Start Webinar] [View List]    │││
│                             │  │  └────────────────────────────────┘││
│                             │  │                                    ││
│                             │  └─────────────────────────────────────┘│
│                             │                                        │
│                             │  ┌──────────────────┐┌─────────────────┐│
│                             │  │                  ││                 ││
│                             │  │ PENDING REQUESTS ││ RECENT REVIEWS  ││
│                             │  │                  ││                 ││
│                             │  │ • Alex M. (new)  ││ ★★★★★ "Great..." ││
│                             │  │ • Sarah K.       ││ ★★★★★ "Sarah..." ││
│                             │  │ [View All →]     ││ [View All →]    ││
│                             │  │                  ││                 ││
│                             │  └──────────────────┘└─────────────────┘│
│                             │                                        │
└─────────────────────────────┴───────────────────────────────────────┘
```

---

## Today's Schedule Component

### Timeline View

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  TODAY'S SCHEDULE                          ◀ Jan 8 ▶  [Week] [Day]  │
│                                                                      │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                      │
│  NOW ─────────────────── 9:15 AM ─────────────────────────────────  │
│                                                                      │
│  ┌─ 9:00 AM ─────────────────────────────────────────────────────┐  │
│  │  🔵 1:1 Consultation                        ⏱️ In Progress    │  │
│  │                                                                │  │
│  │  👤 Alex Martinez                                              │  │
│  │  📋 Career transition to Product Management                    │  │
│  │  💬 "Looking for advice on breaking into PM at FAANG..."      │  │
│  │                                                                │  │
│  │  ┌──────────────────┐  ┌──────────────────┐                   │  │
│  │  │   Join Call 🎥   │  │  View Profile    │                   │  │
│  │  └──────────────────┘  └──────────────────┘                   │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─ 11:00 AM ────────────────────────────────────────────────────┐  │
│  │  🟣 PM Masterclass • Session 4 of 8       ⏱️ Starts in 1h 45m │  │
│  │                                                                │  │
│  │  👥 18 students enrolled                                       │  │
│  │  📚 Today: User Research Methods                               │  │
│  │  📎 Materials uploaded ✓                                       │  │
│  │                                                                │  │
│  │  ┌──────────────────┐  ┌──────────────────┐                   │  │
│  │  │   Join Class     │  │  View Roster     │                   │  │
│  │  └──────────────────┘  └──────────────────┘                   │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─ 3:00 PM ─────────────────────────────────────────────────────┐  │
│  │  🟠 Product Strategy Webinar              ⏱️ Starts in 5h 45m │  │
│  │                                                                │  │
│  │  👁️ 156 registered • 12 new today                             │  │
│  │  📋 Topic: Building Products in AI Era                        │  │
│  │                                                                │  │
│  │  ┌──────────────────┐  ┌──────────────────┐                   │  │
│  │  │  Test Stream     │  │  View Attendees  │                   │  │
│  │  └──────────────────┘  └──────────────────┘                   │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                      │
│  Tomorrow (Jan 9)                                                    │
│  • 10:00 AM - Jennifer Wu (1:1)                                      │
│  • 2:00 PM - Team Mentoring (Subscription)                          │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Consultee Dashboard Redesign

### Desktop Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  SIDEBAR (collapsible)      │  MAIN CONTENT                         │
├─────────────────────────────┼───────────────────────────────────────┤
│                             │                                        │
│  ┌─────────────────────┐   │  HEADER                                │
│  │  👤 Alex Martinez    │   │  ┌────────────────────────────────────┐│
│  │  Product Manager     │   │  │ Welcome back, Alex!               ││
│  │  ⭐ 5 sessions       │   │  │ Your next session is in 2 hours   ││
│  └─────────────────────┘   │  │                                    ││
│                             │  │ [Browse Experts] [My Bookings]    ││
│  ───────────────────────   │  └────────────────────────────────────┘│
│                             │                                        │
│  🏠 Home                   │  ┌─────────────────────────────────────┐│
│  📅 My Sessions      (1)   │  │                                    ││
│  💬 Messages               │  │  UPCOMING SESSION                  ││
│  📜 History                │  │                                    ││
│  ⚙️ Settings              │  │  ┌────────────────────────────────┐ ││
│                             │  │  │ Today, 11:00 AM                │ ││
│  ───────────────────────   │  │  │                                │ ││
│  │                             │  │  │ 1:1 with Sarah Chen          │ ││
│  QUICK LINKS                │  │  │ Product Lead @ Google          │ ││
│  ┌─────────────────────┐   │  │  │                                │ ││
│  │ [Browse Experts]    │   │  │  │ Topic: PM Career Transition    │ ││
│  │ [View Programs]     │   │  │  │                                │ ││
│  │ [Get Help]          │   │  │  │ [Join Call]  [Reschedule]      │ ││
│  └─────────────────────┘   │  │  │                                │ ││
│                             │  │  └────────────────────────────────┘ ││
│                             │  │                                    ││
│                             │  └─────────────────────────────────────┘│
│                             │                                        │
│                             │  ┌─────────────────────────────────────┐│
│                             │  │                                    ││
│                             │  │  YOUR LEARNING JOURNEY             ││
│                             │  │                                    ││
│                             │  │  PM Masterclass with Sarah Chen   ││
│                             │  │  ████████████░░░░░░░░░░ 50%       ││
│                             │  │  Session 4 of 8 • Next: Jan 10    ││
│                             │  │                                    ││
│                             │  │  [Continue Learning]               ││
│                             │  │                                    ││
│                             │  └─────────────────────────────────────┘│
│                             │                                        │
│                             │  ┌─────────────────────────────────────┐│
│                             │  │                                    ││
│                             │  │  RECOMMENDED FOR YOU               ││
│                             │  │                                    ││
│                             │  │  ┌─────────┐ ┌─────────┐ ┌───────┐ ││
│                             │  │  │Expert 1 │ │Program 1│ │Expert2│ ││
│                             │  │  └─────────┘ └─────────┘ └───────┘ ││
│                             │  │                                    ││
│                             │  └─────────────────────────────────────┘│
│                             │                                        │
└─────────────────────────────┴───────────────────────────────────────┘
```

---

## Stats Cards Design

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐
│                  │  │                  │  │                  │  │                 │
│  EARNINGS        │  │  SESSIONS        │  │  RATING          │  │  RESPONSE       │
│                  │  │                  │  │                  │  │                 │
│  $4,250          │  │  23              │  │  ★ 4.9          │  │  2 hours        │
│  ▲ +12%          │  │  ▲ +5            │  │  ▲ +0.1         │  │  avg time       │
│  vs last month   │  │  this month      │  │  from 4.8       │  │                 │
│                  │  │                  │  │                  │  │                 │
│  ────────────    │  │  ────────────    │  │  ────────────    │  │  ────────────   │
│  [View Details]  │  │  [View All]      │  │  [View Reviews]  │  │  [Improve →]    │
│                  │  │                  │  │                  │  │                 │
└──────────────────┘  └──────────────────┘  └──────────────────┘  └─────────────────┘

Hover State:
┌──────────────────┐
│  ░░░░░░░░░░░░░░  │  Subtle scale(1.02)
│  ░░░░░░░░░░░░░░  │  Shadow increase
│  ░░░░░░░░░░░░░░  │
└──────────────────┘
```

---

## Notification System

### In-App Notifications

```
┌─────────────────────────────────────────┐
│  🔔 Notifications            Mark All  │
│  ─────────────────────────────────────  │
│                                         │
│  NEW                                    │
│  ┌─────────────────────────────────────┐│
│  │ 🔵 New booking request              ││
│  │    Alex M. wants to book 1:1        ││
│  │    2 minutes ago                    ││
│  │    [Accept] [Decline]               ││
│  └─────────────────────────────────────┘│
│                                         │
│  ┌─────────────────────────────────────┐│
│  │ ⭐ New review received              ││
│  │    Jennifer W. left 5 stars         ││
│  │    15 minutes ago                   ││
│  │    [View Review]                    ││
│  └─────────────────────────────────────┘│
│                                         │
│  EARLIER                                │
│  ┌─────────────────────────────────────┐│
│  │ 💬 New message                      ││
│  │    David K. sent you a message      ││
│  │    1 hour ago                       ││
│  └─────────────────────────────────────┘│
│                                         │
│  [View All Notifications]               │
│                                         │
└─────────────────────────────────────────┘
```

### Toast Notifications

```tsx
// Real-time toast for urgent updates
<Toast variant="info">
  <div className="flex items-center gap-3">
    <Avatar className="h-8 w-8">
      <AvatarImage src={user.image} />
    </Avatar>
    <div>
      <p className="font-medium">Session starting in 5 minutes</p>
      <p className="text-sm text-muted-foreground">
        1:1 with Alex Martinez
      </p>
    </div>
    <Button size="sm">Join Now</Button>
  </div>
</Toast>
```

---

## Mobile Dashboard

```
┌─────────────────────────────┐
│ ≡  Dashboard        🔔 (3) │
├─────────────────────────────┤
│                             │
│  Good morning, Sarah!       │
│  You have 3 sessions today  │
│                             │
│  ┌─────────────────────────┐│
│  │ NEXT UP                 ││
│  │ ─────────────────────── ││
│  │                         ││
│  │ 9:00 AM (in 45 min)     ││
│  │ Alex M. • 1:1           ││
│  │ Career transition       ││
│  │                         ││
│  │ [Join Call]             ││
│  │                         ││
│  └─────────────────────────┘│
│                             │
│  ┌───────┐ ┌───────┐       │
│  │$4,250 │ │  23   │       │
│  │earned │ │session│       │
│  └───────┘ └───────┘       │
│  ┌───────┐ ┌───────┐       │
│  │ ★ 4.9│ │  2    │       │
│  │rating │ │pending│       │
│  └───────┘ └───────┘       │
│                             │
│  ─────────────────────────  │
│                             │
│  TODAY'S SCHEDULE           │
│                             │
│  ┌─────────────────────────┐│
│  │ 9:00 AM - Alex M.       ││
│  │ 11:00 AM - PM Class     ││
│  │ 3:00 PM - Webinar       ││
│  └─────────────────────────┘│
│                             │
├─────────────────────────────┤
│  🏠   📅   💬   👤   ⚙️   │
│ Home Appts Chat Profile Set │
└─────────────────────────────┘
```

---

## Quick Actions Implementation

### Command Palette (Cmd+K)

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  🔍 Search or run a command...                                      │
│                                                                      │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                      │
│  QUICK ACTIONS                                                       │
│                                                                      │
│  📅  Block time on calendar                              ⌘ + B      │
│  ✉️  Send message to participant                         ⌘ + M      │
│  👁️  View today's schedule                               ⌘ + T      │
│  ⚙️  Open settings                                       ⌘ + ,      │
│                                                                      │
│  RECENT                                                              │
│                                                                      │
│  👤  Alex Martinez's profile                                        │
│  📊  Monthly earnings report                                        │
│  💬  Message with Jennifer W.                                       │
│                                                                      │
│  NAVIGATE                                                            │
│                                                                      │
│  🏠  Go to Home                                                      │
│  📅  Go to Appointments                                              │
│  💬  Go to Messages                                                  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Checklist

### Phase 1: Performance
- [ ] Cache user role in session token
- [ ] Implement instant redirect
- [ ] Add progressive data streaming
- [ ] Optimize skeleton components

### Phase 2: Layout
- [ ] Redesign sidebar navigation
- [ ] Create stats card components
- [ ] Implement today's schedule timeline
- [ ] Add mobile bottom navigation

### Phase 3: Features
- [ ] Build notification system
- [ ] Add command palette (Cmd+K)
- [ ] Implement quick actions
- [ ] Add real-time updates

### Phase 4: Polish
- [ ] Add micro-interactions
- [ ] Implement keyboard shortcuts
- [ ] Mobile-optimize all views
- [ ] Add empty states
