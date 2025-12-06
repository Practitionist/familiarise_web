# Wireframes Overview

> ASCII wireframes for quick reference and implementation guidance.

---

## Page Wireframes Index

### Public Pages

| Page | Location | Description |
|------|----------|-------------|
| Home | [pages/01-home.md](../pages/01-home.md#redesigned-structure) | Hero, experts carousel, testimonials, FAQ |
| Explore Experts | [pages/02-explore-experts.md](../pages/02-explore-experts.md#redesigned-layout) | Filter sidebar, expert grid, search |
| Explore Programs | [pages/03-explore-programs.md](../pages/03-explore-programs.md#redesigned-layout) | Tabs, program cards, urgency indicators |
| Expert Details | [pages/04-expert-details.md](../pages/04-expert-details.md#redesigned-layout) | Profile, booking card, reviews |

### Conversion Pages

| Page | Location | Description |
|------|----------|-------------|
| Checkout | [pages/06-checkout.md](../pages/06-checkout.md#desktop-layout-step-1-review) | Step-by-step checkout flow |

### Dashboard Pages

| Page | Location | Description |
|------|----------|-------------|
| Consultant Dashboard | [pages/05-dashboard.md](../pages/05-dashboard.md#consultant-dashboard-redesign) | Stats, schedule, requests |
| Consultee Dashboard | [pages/05-dashboard.md](../pages/05-dashboard.md#consultee-dashboard-redesign) | Sessions, learning progress |

---

## Mobile Wireframes

### Mobile Navigation Pattern

```
┌─────────────────────────────┐
│ ≡  LOGO              🔔 👤 │
├─────────────────────────────┤
│                             │
│                             │
│    [PAGE CONTENT]           │
│                             │
│                             │
├─────────────────────────────┤
│  🏠   🔍   💬   📅   👤   │
│ Home Find Chat Appts  Me    │
└─────────────────────────────┘
```

### Mobile Card Pattern

```
┌─────────────────────────────┐
│  ┌─────────────────────────┐│
│  │                         ││
│  │      IMAGE/AVATAR       ││
│  │                         ││
│  └─────────────────────────┘│
│                             │
│  Title Text                 │
│  Subtitle / metadata        │
│                             │
│  Description text that      │
│  can wrap to multiple       │
│  lines if needed...         │
│                             │
│  ┌─────────────────────────┐│
│  │    PRIMARY ACTION       ││
│  └─────────────────────────┘│
│                             │
└─────────────────────────────┘
```

### Mobile Filter Pattern

```
┌─────────────────────────────┐
│ ━━━━━━                      │  <- Drag handle
│                             │
│ Filters          [Clear]    │
│                             │
│ CATEGORY                    │
│ ┌─────┐ ┌─────┐ ┌─────┐    │
│ │ ✓1  │ │  2  │ │  3  │    │  <- Chip multi-select
│ └─────┘ └─────┘ └─────┘    │
│                             │
│ PRICE RANGE                 │
│ ○─────────●───────○        │  <- Range slider
│ $0       $150     $500      │
│                             │
│ ┌─────────────────────────┐ │
│ │   Show 42 Results       │ │  <- Sticky button
│ └─────────────────────────┘ │
│                             │
└─────────────────────────────┘
```

---

## Component Wireframes

### Expert Card

```
┌───────────────────────────────────────────────┐
│  ┌─────────────┐                              │
│  │             │  Name Here                   │
│  │    Photo    │  Role @ Company              │
│  │             │  ★ 4.9 (127 reviews)         │
│  │  🟢 Online  │                              │
│  └─────────────┘                              │
│                                               │
│  Tag 1 • Tag 2 • Tag 3                        │
│                                               │
│  Short bio text that describes expertise...   │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │ 📅 Next available: Today, 3:00 PM       │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  From $150/hr                                 │
│  ───────────────────────────────────────────  │
│  [View Profile]            [Quick Book →]    │
│                                               │
└───────────────────────────────────────────────┘
```

### Program Card

```
┌─────────────────────────────────────────────────┐
│  ┌───────────────────────────────────────────┐  │
│  │                                           │  │
│  │             COVER IMAGE                   │  │
│  │                                           │  │
│  │  ┌──────────┐              ┌──────────┐  │  │
│  │  │ TYPE     │              │ URGENCY  │  │  │
│  │  └──────────┘              └──────────┘  │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  Title of the Program                            │
│  ─────────────────────────────────────────────  │
│                                                  │
│  👤 Instructor Name • Company                   │
│                                                  │
│  📅 Start Date • Duration                       │
│  👥 Enrollment info                             │
│                                                  │
│  $XXX                    ★ 4.9 (45 reviews)     │
│                                                  │
│  [View Details]              [Enroll Now →]     │
│                                                  │
└─────────────────────────────────────────────────┘
```

### Booking Calendar

```
┌─────────────────────────────────────────┐
│                                          │
│  Select a date                           │
│                                          │
│       ◀  January 2025  ▶                │
│  ─────────────────────────────────────  │
│  Mon  Tue  Wed  Thu  Fri  Sat  Sun      │
│                                          │
│        1    2    3    4    5            │
│   ○    ●    ●    ○    ●    ·    ·       │
│                                          │
│   6    7    8    9   10   11   12       │
│   ●    ○   [●]   ●    ●    ·    ·       │
│                                          │
│  13   14   15   16   17   18   19       │
│   ●    ●    ●    ●    ○    ·    ·       │
│                                          │
│  Legend: ● Available  ○ Few slots       │
│          · Unavailable  [●] Selected    │
│                                          │
└─────────────────────────────────────────┘
```

### Time Slots

```
┌─────────────────────────────────────────┐
│                                          │
│  Available times for Wed, Jan 8         │
│  Timezone: PST (Los Angeles)  [Change]   │
│                                          │
│  Morning                                 │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐    │
│  │ 9:00 AM │ │10:00 AM │ │11:00 AM │    │
│  └─────────┘ └─────────┘ └─────────┘    │
│                                          │
│  Afternoon                               │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐    │
│  │ 2:00 PM │ │ 3:00 PM │ │ 4:00 PM │    │
│  └─────────┘ └─────────┘ └─────────┘    │
│                                          │
│  Evening                                 │
│  ┌─────────┐                            │
│  │ 6:00 PM │  <- selected              │
│  └─────────┘                            │
│                                          │
└─────────────────────────────────────────┘
```

### Review Card

```
┌──────────────────────────────────────────────────┐
│  👤 Alex Martinez        ★★★★★    Verified ✓    │
│  2 days ago • 1:1 Consultation                   │
│                                                   │
│  "The session was incredibly helpful. Sarah      │
│  helped me understand exactly what I needed      │
│  to do to transition into product management.    │
│  Highly recommend!"                               │
│                                                   │
│  💬 Expert replied: "Thanks Alex! Great to..."  │
│                                                   │
│  👍 Helpful (12)                                 │
└──────────────────────────────────────────────────┘
```

### Stats Card

```
┌──────────────────┐
│                  │
│  EARNINGS        │  <- Label
│                  │
│  $4,250          │  <- Primary value (large)
│  ▲ +12%          │  <- Change indicator (green/red)
│  vs last month   │  <- Context
│                  │
│  ────────────    │
│  [View Details]  │  <- Optional action
│                  │
└──────────────────┘
```

### Notification Toast

```
┌─────────────────────────────────────────────────┐
│  ┌────┐                                    ✕    │
│  │ 🎉 │  Session Booked Successfully!          │
│  └────┘  Your session with Sarah is confirmed  │
│          Wed, Jan 8 at 2:00 PM PST              │
│                                                  │
│          [View Booking]  [Add to Calendar]      │
└─────────────────────────────────────────────────┘
```

---

## Layout Patterns

### Two-Column with Sidebar

```
┌────────────────────────────────────────────────────────────────┐
│  NAVBAR (full width)                                            │
├───────────────────────────────┬────────────────────────────────┤
│                               │                                 │
│  SIDEBAR                      │  MAIN CONTENT                   │
│  (240-280px)                  │  (flex-1)                       │
│                               │                                 │
│  - Navigation                 │  - Header                       │
│  - Filters                    │  - Content grid                 │
│  - Quick actions              │  - Pagination                   │
│                               │                                 │
└───────────────────────────────┴────────────────────────────────┘
```

### Content with Sticky Sidebar

```
┌────────────────────────────────────────────────────────────────┐
│  NAVBAR                                                         │
├────────────────────────────────────────────────────────────────┤
│  BREADCRUMB                                                     │
├──────────────────────────────────┬─────────────────────────────┤
│                                  │                              │
│  SCROLLABLE CONTENT              │  STICKY SIDEBAR             │
│  (60%)                           │  (40%)                       │
│                                  │  ┌────────────────────────┐ │
│  - Profile info                  │  │                        │ │
│  - About                         │  │  Booking Card          │ │
│  - Experience                    │  │  (position: sticky)    │ │
│  - Reviews                       │  │                        │ │
│  ...                             │  │                        │ │
│  (scrolls)                       │  └────────────────────────┘ │
│                                  │                              │
└──────────────────────────────────┴─────────────────────────────┘
```

### Full-Width Sections

```
┌────────────────────────────────────────────────────────────────┐
│                                                                 │
│  HERO (full bleed, gradient bg)                                │
│                                                                 │
├────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  CONTAINER (max-width: 1280px, centered)                 │  │
│  │                                                           │  │
│  │  Content section 1                                        │  │
│  │                                                           │  │
│  └──────────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  CAROUSEL (full bleed, edge fade)                              │
│                                                                 │
├────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  CONTAINER                                                │  │
│  │                                                           │  │
│  │  Content section 2                                        │  │
│  │                                                           │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

---

## Responsive Breakpoints

```
Mobile:   < 640px   (sm)
Tablet:   640-1024px (md, lg)
Desktop:  1024-1440px (xl)
Wide:     > 1440px   (2xl)

Layout Changes:
- Mobile: Single column, bottom nav
- Tablet: Two columns, collapsible sidebar
- Desktop: Full layout with fixed sidebar
- Wide: Wider content, more whitespace
```

---

## Interactive States

```
DEFAULT
┌───────────────────┐
│  Button Label     │  Border: gray-300
└───────────────────┘

HOVER
┌───────────────────┐
│  Button Label     │  Background: gray-50
└───────────────────┘  Shadow: sm

FOCUS
┌───────────────────┐
│  Button Label     │  Ring: 2px primary
└───────────────────┘  Offset: 2px

ACTIVE/PRESSED
┌───────────────────┐
│  Button Label     │  Scale: 0.98
└───────────────────┘

DISABLED
┌───────────────────┐
│  Button Label     │  Opacity: 0.5
└───────────────────┘  Cursor: not-allowed

LOADING
┌───────────────────┐
│  ○ Loading...     │  Spinner + text
└───────────────────┘
```
