# Explore Programs Page Modernization Guide

> **Route**: `/explore/programs`
> **Priority**: P1 - Important
> **Current Issues**: List/Grid toggle redundancy, generic cards, no program previews

---

## Current State Analysis

### What's Working
- Type filter (Classes/Webinars)
- Level filtering
- Sort functionality
- View mode toggle

### Critical Issues
1. **No visual distinction** between Classes and Webinars
2. **Massive padding** (pt-40 pb-32) wastes space
3. **Double price display** ("$$item.price" - bug)
4. **No schedule preview** - user has to click to see dates
5. **No instructor info** on cards
6. **Missing urgency indicators** (spots left, starting soon)

---

## Redesigned Layout

### Desktop View

```
┌─────────────────────────────────────────────────────────────────────┐
│ BREADCRUMB: Home > Programs                                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                                                              │    │
│  │  Level Up Your Skills with Expert-Led Programs              │    │
│  │                                                              │    │
│  │  Interactive classes and live webinars taught by            │    │
│  │  industry leaders.                                           │    │
│  │                                                              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  TABS: [All Programs (156)]  [Classes (89)]  [Webinars (67)]        │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  FILTER BAR                                                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  🔍 Search programs...                                      │    │
│  │                                                              │    │
│  │  Category: [All ▾]  Level: [All ▾]  Price: [All ▾]          │    │
│  │  Date: [Any time ▾]  Duration: [Any ▾]                      │    │
│  │                                                              │    │
│  │  Sort by: [Starting Soon ▾]              View: [≡] [⊞]      │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  FEATURED PROGRAMS (Carousel)                                        │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                                                              │    │
│  │  ◀ [Featured Card] [Featured Card] [Featured Card] ▶        │    │
│  │                                                              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  STARTING SOON                                                       │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                 │
│  │   Program    │ │   Program    │ │   Program    │                 │
│  │    Card      │ │    Card      │ │    Card      │                 │
│  │   🔴 Live    │ │   ⏰ 2 days  │ │   📅 Next wk │                 │
│  └──────────────┘ └──────────────┘ └──────────────┘                 │
│                                                                      │
│  ALL PROGRAMS                                                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                 │
│  │              │ │              │ │              │                 │
│  │   Program    │ │   Program    │ │   Program    │                 │
│  │    Card      │ │    Card      │ │    Card      │                 │
│  │              │ │              │ │              │                 │
│  └──────────────┘ └──────────────┘ └──────────────┘                 │
│                                                                      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                 │
│  │              │ │              │ │              │                 │
│  │   Program    │ │   Program    │ │   Program    │                 │
│  │    Card      │ │    Card      │ │    Card      │                 │
│  │              │ │              │ │              │                 │
│  └──────────────┘ └──────────────┘ └──────────────┘                 │
│                                                                      │
│  [Load More Programs...]                                             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Program Card Redesign

### Class Card

```
┌─────────────────────────────────────────────────┐
│  ┌───────────────────────────────────────────┐  │
│  │                                           │  │
│  │             COVER IMAGE                   │  │
│  │                                           │  │
│  │  ┌──────────┐              ┌──────────┐  │  │
│  │  │  CLASS   │              │ 12 spots │  │  │
│  │  └──────────┘              │   left   │  │  │
│  │                            └──────────┘  │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  Product Management Masterclass                  │
│  ─────────────────────────────────────────────  │
│                                                  │
│  👤 Sarah Chen, Product Lead @ Google           │
│                                                  │
│  📅 Starts Jan 15, 2025 • 6 weeks               │
│  ⏰ Mon & Wed, 6:00 PM PST                      │
│  👥 Cohort-based • Max 20 students              │
│                                                  │
│  ─────────────────────────────────────────────  │
│                                                  │
│  Learn to:                                       │
│  • Define product strategy                       │
│  • Run user research                             │
│  • Ship products at scale                        │
│                                                  │
│  ─────────────────────────────────────────────  │
│                                                  │
│  $499                    ★ 4.9 (45 reviews)     │
│                                                  │
│  [View Details]                [Enroll Now →]   │
│                                                  │
└─────────────────────────────────────────────────┘
```

### Webinar Card

```
┌─────────────────────────────────────────────────┐
│  ┌───────────────────────────────────────────┐  │
│  │                                           │  │
│  │             COVER IMAGE                   │  │
│  │                                           │  │
│  │  ┌──────────┐                            │  │
│  │  │ WEBINAR  │                            │  │
│  │  └──────────┘                            │  │
│  │                     ┌────────────────┐   │  │
│  │                     │ 🔴 LIVE NOW    │   │  │
│  │                     └────────────────┘   │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  AI in Product Development                       │
│  ─────────────────────────────────────────────  │
│                                                  │
│  👤 Michael Park, AI Lead @ OpenAI              │
│                                                  │
│  📅 Today, 3:00 PM PST                          │
│  ⏱️ 90 minutes                                  │
│  👁️ 234 registered                              │
│                                                  │
│  ─────────────────────────────────────────────  │
│                                                  │
│  You'll learn:                                   │
│  • Integrating AI into product workflows        │
│  • Practical use cases                           │
│  • Q&A with the speaker                         │
│                                                  │
│  ─────────────────────────────────────────────  │
│                                                  │
│  FREE                    ★ 4.8 (128 reviews)    │
│                                                  │
│  [Add to Calendar]           [Register Now →]   │
│                                                  │
└─────────────────────────────────────────────────┘
```

### Compact List View Card

```
┌─────────────────────────────────────────────────────────────────────┐
│  ┌─────────┐                                                         │
│  │  Image  │  Product Management Masterclass            CLASS        │
│  │         │  Sarah Chen • Google                                    │
│  │         │  Jan 15 - Feb 26 • Mon & Wed 6 PM PST    $499           │
│  │         │  ★ 4.9 (45)  •  12 spots left            [Enroll →]    │
│  └─────────┘                                                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Visual Type Distinction

### Color Coding
```css
/* Classes - Blue theme */
.program-badge-class {
  background: linear-gradient(135deg, #3B82F6, #1D4ED8);
  color: white;
}

/* Webinars - Purple theme */
.program-badge-webinar {
  background: linear-gradient(135deg, #8B5CF6, #6D28D9);
  color: white;
}

/* Live indicator - Red pulse */
.live-badge {
  background: #EF4444;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}
```

### Badge Styles
```
CLASS:   ┌──────────┐
         │ 📚 CLASS │  Blue background
         └──────────┘

WEBINAR: ┌───────────┐
         │ 🎥 WEBINAR │  Purple background
         └───────────┘

LIVE:    ┌───────────────┐
         │ 🔴 LIVE NOW   │  Red with pulse
         └───────────────┘
```

---

## Urgency & Social Proof

### Starting Soon Section
```
┌─────────────────────────────────────────────────┐
│                                                  │
│  🔥 STARTING SOON                               │
│                                                  │
│  Don't miss these upcoming programs              │
│                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────┐ │
│  │             │  │             │  │          │ │
│  │ 🔴 LIVE     │  │ ⏰ 2 hours │  │ 📅 2 days│ │
│  │   NOW      │  │             │  │          │ │
│  └─────────────┘  └─────────────┘  └──────────┘ │
│                                                  │
└─────────────────────────────────────────────────┘
```

### Scarcity Indicators
```
Spots left:
- "🔴 Last 3 spots!" (1-3 spots) - Red urgent
- "⚠️ Only 8 spots left" (4-10 spots) - Orange warning
- "12 spots left" (11+) - Normal gray

Timing:
- "🔴 LIVE NOW" - Currently happening
- "⏰ Starts in 2 hours" - Same day
- "📅 Starts tomorrow" - Next day
- "Starts Jan 15" - Future date
```

---

## Filter Improvements

### Quick Filter Pills
```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Quick Filters:                                                      │
│                                                                      │
│  [🔥 Starting This Week]  [💰 Free]  [⭐ Top Rated]  [🆕 New]       │
│                                                                      │
│  [Design]  [Engineering]  [Product]  [Marketing]  [More...]         │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Date Picker Enhancement
```
┌─────────────────────────────────────────┐
│  Date                                    │
│  ┌───────────────────────────────────┐  │
│  │ [Any Time ▾]                      │  │
│  ├───────────────────────────────────┤  │
│  │  ○ Any time                       │  │
│  │  ○ Starting this week             │  │
│  │  ○ Starting this month            │  │
│  │  ─────────────────────────────    │  │
│  │  ○ Custom date range              │  │
│  │     From: [Jan 1]  To: [Jan 31]   │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

---

## Featured Programs Carousel

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ⭐ FEATURED PROGRAMS                          [View All →]         │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                                                                 │ │
│  │  ┌───────────────────────────────────────────────────────────┐ │ │
│  │  │                                                            │ │ │
│  │  │                    FEATURED COVER                         │ │ │
│  │  │                                                            │ │ │
│  │  │   🏆 TOP RATED                                            │ │ │
│  │  │                                                            │ │ │
│  │  │   Product Management Bootcamp                             │ │ │
│  │  │   Learn PM fundamentals in 8 weeks                        │ │ │
│  │  │                                                            │ │ │
│  │  │   👤 Sarah Chen • Google                                  │ │ │
│  │  │   ★ 4.9 (234 reviews)                                     │ │ │
│  │  │                                                            │ │ │
│  │  │   [Learn More →]                                          │ │ │
│  │  │                                                            │ │ │
│  │  └───────────────────────────────────────────────────────────┘ │ │
│  │                                                                 │ │
│  │        ○ ● ○ ○ ○  (pagination dots)                           │ │
│  │                                                                 │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Performance Optimizations

### Fix Current Bug
```tsx
// BEFORE: Double dollar sign bug
<div className="text-gray-900 font-semibold">
  $${item.price}  // Shows "$$50" instead of "$50"
</div>

// AFTER: Fix the template literal
<div className="text-gray-900 font-semibold">
  ${item.price}
</div>
```

### Image Optimization
```tsx
// Cover images should be lazy loaded with blur
<Image
  src={program.imageUrl}
  alt={program.title}
  width={400}
  height={225}
  placeholder="blur"
  blurDataURL={program.blurHash || defaultProgramBlur}
  loading={index < 6 ? 'eager' : 'lazy'} // First 6 eager
  className="object-cover"
/>
```

### Skeleton Loading
```
┌─────────────────────────────────────────────────┐
│  ┌───────────────────────────────────────────┐  │
│  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  │
│  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  │
│  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░                  │
│  ────────────────────────────────────────────   │
│                                                  │
│  ░░░░░░░░░░░░░░░░░░░░░                         │
│                                                  │
│  ░░░░░░░░░░░░░░  ░░░░░░░░░░░                   │
│                                                  │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░           │
│  ░░░░░░░░░░░░░░░░░░░░░░░░                      │
│                                                  │
│  ░░░░░░             ░░░░░░░░░░░░░░░░░░░░      │
│                                                  │
└─────────────────────────────────────────────────┘
```

---

## Mobile Optimizations

### Mobile Card
```
┌─────────────────────────────────┐
│  ┌─────────────────────────────┐│
│  │                             ││
│  │        COVER IMAGE          ││
│  │                             ││
│  │  ┌───────┐     ┌─────────┐ ││
│  │  │ CLASS │     │12 spots │ ││
│  │  └───────┘     └─────────┘ ││
│  └─────────────────────────────┘│
│                                 │
│  Product Management Masterclass │
│  👤 Sarah Chen • Google         │
│                                 │
│  📅 Jan 15 - Feb 26            │
│  ⏰ Mon & Wed, 6 PM            │
│                                 │
│  $499        ★ 4.9 (45)        │
│                                 │
│  ┌─────────────────────────────┐│
│  │        Enroll Now →         ││
│  └─────────────────────────────┘│
│                                 │
└─────────────────────────────────┘
```

### Swipeable Tabs
```tsx
// Use touch-friendly tab navigation
<Tabs className="touch-pan-x">
  <TabsList className="flex overflow-x-auto snap-x">
    <TabsTrigger className="snap-start">All</TabsTrigger>
    <TabsTrigger className="snap-start">Classes</TabsTrigger>
    <TabsTrigger className="snap-start">Webinars</TabsTrigger>
  </TabsList>
</Tabs>
```

---

## Implementation Checklist

### Phase 1: Bug Fixes
- [ ] Fix double dollar sign bug
- [ ] Remove excessive padding
- [ ] Add proper image loading

### Phase 2: Card Redesign
- [ ] Create ClassCard component
- [ ] Create WebinarCard component
- [ ] Add type badges with colors
- [ ] Add instructor info

### Phase 3: UX Improvements
- [ ] Add urgency indicators
- [ ] Implement featured carousel
- [ ] Add "Starting Soon" section
- [ ] Improve filter UX

### Phase 4: Performance
- [ ] Add skeleton loading
- [ ] Implement lazy loading
- [ ] Add prefetching
- [ ] Mobile optimizations
