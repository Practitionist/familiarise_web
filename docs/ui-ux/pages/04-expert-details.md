# Expert Details Page Modernization Guide

> **Route**: `/explore/experts/[consultantId]`
> **Priority**: P0 - Critical (Primary booking page)
> **Current Issues**: Fixed width layout, poor mobile, complex booking flow

---

## Current State Analysis

### What's Working
- Comprehensive expert information
- Multiple pricing options (consultation, subscription)
- Availability calendar with timezone support
- Reviews section

### Critical Issues
1. **Fixed 50% width** container - wastes space on desktop
2. **No sticky booking card** - user loses context while scrolling
3. **Calendar in sidebar** - too cramped
4. **No video introduction** option
5. **Reviews not filterable**
6. **Missing social proof** (total sessions, response time)
7. **No "similar experts"** recommendations

---

## Redesigned Layout

### Desktop View (1440px+)

```
┌─────────────────────────────────────────────────────────────────────┐
│ BREADCRUMB: Home > Experts > Sarah Chen                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                                                                  ││
│  │  PROFILE HEADER                                                  ││
│  │  ┌────────────────┐                                             ││
│  │  │                │  Sarah Chen                    [🔖 Save]    ││
│  │  │    PHOTO       │  Product Lead @ Google                      ││
│  │  │   (with play   │                                             ││
│  │  │   button for   │  ★ 4.9 (127 reviews) • 🟢 Usually responds ││
│  │  │   video)       │  within 2 hours • 450+ sessions completed   ││
│  │  │                │                                             ││
│  │  └────────────────┘  📍 San Francisco, CA • PST                 ││
│  │                                                                  ││
│  │  Product Strategy • User Research • Growth • Leadership         ││
│  │                                                                  ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                      │
├────────────────────────────────────────┬────────────────────────────┤
│                                        │                             │
│  MAIN CONTENT (60%)                    │  BOOKING SIDEBAR (40%)     │
│                                        │  (Sticky on scroll)        │
│  ┌──────────────────────────────────┐  │  ┌────────────────────────┐│
│  │                                   │  │  │                        ││
│  │  TABS: [About] [Programs] [Revs] │  │  │  BOOKING CARD          ││
│  │                                   │  │  │                        ││
│  └──────────────────────────────────┘  │  │  Select service:       ││
│                                        │  │  ┌────────────────────┐ ││
│  ABOUT                                 │  │  │ 1:1 Consultation   │ ││
│  ─────────────────────────────────     │  │  │ From $150/hr       │ ││
│                                        │  │  └────────────────────┘ ││
│  I'm a Product Leader with 10+ years  │  │  ┌────────────────────┐ ││
│  of experience scaling products at    │  │  │ Subscription       │ ││
│  Google, helping teams go from 0→1... │  │  │ From $499/mo       │ ││
│                                        │  │  └────────────────────┘ ││
│  [Read more...]                        │  │                        ││
│                                        │  │  ─────────────────────  ││
│  EXPERTISE                             │  │                        ││
│  ─────────────────────────────────     │  │  Select date:         ││
│                                        │  │  ◀ January 2025 ▶     ││
│  ┌─────────┐ ┌─────────┐ ┌─────────┐  │  │  M  T  W  T  F  S  S  ││
│  │ Product │ │  User   │ │ Growth  │  │  │  .. .. 1  2  3  4  5  ││
│  │Strategy │ │Research │ │Marketing│  │  │  6  7  8● 9  10 11 12 ││
│  │ ★★★★★  │ │ ★★★★☆  │ │ ★★★★★  │  │  │  ...                   ││
│  └─────────┘ └─────────┘ └─────────┘  │  │                        ││
│                                        │  │  ─────────────────────  ││
│  EXPERIENCE                            │  │                        ││
│  ─────────────────────────────────     │  │  Available times:     ││
│                                        │  │  ┌──────┐ ┌──────┐    ││
│  🏢 Google (2018-Present)             │  │  │ 9 AM │ │10 AM │    ││
│     Product Lead                       │  │  └──────┘ └──────┘    ││
│                                        │  │  ┌──────┐ ┌──────┐    ││
│  🏢 Meta (2015-2018)                  │  │  │ 2 PM │ │ 4 PM │    ││
│     Senior PM                          │  │  └──────┘ └──────┘    ││
│                                        │  │                        ││
│  EDUCATION                             │  │  ─────────────────────  ││
│  ─────────────────────────────────     │  │                        ││
│                                        │  │  $150          1 hour  ││
│  🎓 Stanford MBA                       │  │                        ││
│  🎓 MIT Computer Science               │  │  ┌────────────────────┐││
│                                        │  │  │  Book Session →    │││
│                                        │  │  └────────────────────┘││
│                                        │  │                        ││
│                                        │  │  🔒 Free cancellation  ││
│                                        │  │     up to 24h before   ││
│                                        │  │                        ││
│                                        │  └────────────────────────┘│
│                                        │                             │
│  CLASSES & WEBINARS                    │                             │
│  ─────────────────────────────────     │                             │
│                                        │                             │
│  ┌──────────────────────────────────┐  │                             │
│  │ PM Masterclass • 6 weeks • $499  │  │                             │
│  │ Next cohort: Feb 1, 2025         │  │                             │
│  │ [Learn More →]                    │  │                             │
│  └──────────────────────────────────┘  │                             │
│                                        │                             │
│  REVIEWS (127)                         │                             │
│  ─────────────────────────────────     │                             │
│                                        │                             │
│  Filter: [All ▾] [5★] [4★] [3★]       │                             │
│                                        │                             │
│  ┌──────────────────────────────────┐  │                             │
│  │ ★★★★★  "Sarah's advice was..."   │  │                             │
│  │ Alex M. • 2 days ago              │  │                             │
│  └──────────────────────────────────┘  │                             │
│                                        │                             │
│  [Load more reviews...]                │                             │
│                                        │                             │
└────────────────────────────────────────┴────────────────────────────┘

SIMILAR EXPERTS (Full width section at bottom)
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Similar Experts in Product Strategy                                 │
│                                                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐               │
│  │ Expert 1 │ │ Expert 2 │ │ Expert 3 │ │ Expert 4 │               │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘               │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Mobile Layout

```
┌─────────────────────────────┐
│ ← Sarah Chen                │
├─────────────────────────────┤
│                             │
│  ┌─────────────────────────┐│
│  │                         ││
│  │      PROFILE PHOTO      ││
│  │      (with video ▶)     ││
│  │                         ││
│  └─────────────────────────┘│
│                             │
│  Sarah Chen                 │
│  Product Lead @ Google      │
│  ★ 4.9 (127) • 🟢 Online    │
│                             │
│  ─────────────────────────  │
│                             │
│  $150/hr                    │
│  ┌─────────────────────────┐│
│  │    Check Availability   ││
│  └─────────────────────────┘│
│                             │
│  ─────────────────────────  │
│                             │
│  TABS: [About] [Progs] [Rev]│
│                             │
│  [Tab content...]           │
│                             │
│                             │
└─────────────────────────────┘

STICKY BOTTOM BAR (appears on scroll):
┌─────────────────────────────┐
│  $150/hr        [Book Now →]│
└─────────────────────────────┘
```

---

## Profile Header Enhancement

### Video Introduction
```
┌───────────────────────────────────────────────────────────────────┐
│                                                                    │
│  ┌──────────────────────┐                                         │
│  │                      │                                         │
│  │    PROFILE PHOTO     │   Sarah Chen                            │
│  │                      │   Product Lead @ Google                 │
│  │    ┌──────────────┐  │                                         │
│  │    │     ▶ 2:30   │  │   ★ 4.9 (127 reviews)                  │
│  │    │  Watch Intro │  │   🟢 Usually responds within 2 hours   │
│  │    └──────────────┘  │   450+ sessions completed               │
│  │                      │                                         │
│  └──────────────────────┘   📍 San Francisco, CA • PST           │
│                                                                    │
│  ─────────────────────────────────────────────────────────────    │
│                                                                    │
│  EXPERTISE TAGS                                                    │
│  ┌────────────────┐ ┌─────────────┐ ┌────────────┐ ┌──────────┐  │
│  │Product Strategy│ │User Research│ │Growth Hacks│ │Leadership│  │
│  └────────────────┘ └─────────────┘ └────────────┘ └──────────┘  │
│                                                                    │
│  STATS                                                             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐              │
│  │ 450+         │ │ 2 hours      │ │ 98%          │              │
│  │ sessions     │ │ avg response │ │ would book   │              │
│  │              │ │              │ │ again        │              │
│  └──────────────┘ └──────────────┘ └──────────────┘              │
│                                                                    │
└───────────────────────────────────────────────────────────────────┘
```

---

## Booking Card Redesign

### Service Selection

```
┌─────────────────────────────────────────┐
│                                          │
│  What are you looking for?               │
│                                          │
│  ┌──────────────────────────────────────┐│
│  │ ○  1:1 CONSULTATION                  ││
│  │    Get personalized advice           ││
│  │    From $150/hour                    ││
│  │    ────────────────────────────────  ││
│  │    ┌────────┐ ┌────────┐            ││
│  │    │ 30 min │ │ 60 min │            ││
│  │    │  $75   │ │  $150  │            ││
│  │    └────────┘ └────────┘            ││
│  └──────────────────────────────────────┘│
│                                          │
│  ┌──────────────────────────────────────┐│
│  │ ○  MONTHLY SUBSCRIPTION              ││
│  │    Regular sessions + async access   ││
│  │    From $499/month                   ││
│  │    ────────────────────────────────  ││
│  │    • 4 sessions per month            ││
│  │    • Priority scheduling             ││
│  │    • Chat access between sessions    ││
│  └──────────────────────────────────────┘│
│                                          │
└─────────────────────────────────────────┘
```

### Calendar Enhancement

```
┌─────────────────────────────────────────┐
│                                          │
│  Select a date                           │
│                                          │
│  ┌──────────────────────────────────────┐│
│  │       ◀  January 2025  ▶             ││
│  │ ──────────────────────────────────── ││
│  │  Mon  Tue  Wed  Thu  Fri  Sat  Sun   ││
│  │                                       ││
│  │        1    2    3    4    5         ││
│  │   ○    ●    ●    ○    ●    ·    ·    ││
│  │                                       ││
│  │   6    7    8    9   10   11   12    ││
│  │   ●    ○   [●]   ●    ●    ·    ·    ││
│  │                                       ││
│  │  13   14   15   16   17   18   19    ││
│  │   ●    ●    ●    ●    ○    ·    ·    ││
│  │                                       ││
│  └──────────────────────────────────────┘│
│                                          │
│  Legend:                                 │
│  ● Available  ○ Few slots  · Unavailable │
│                                          │
│  ────────────────────────────────────── │
│                                          │
│  Wednesday, January 8                    │
│  Timezone: PST (Los Angeles)    [Change] │
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
│  │ 6:00 PM │                            │
│  └─────────┘                            │
│                                          │
└─────────────────────────────────────────┘
```

### Booking Summary

```
┌─────────────────────────────────────────┐
│                                          │
│  YOUR BOOKING                            │
│  ────────────────────────────────────── │
│                                          │
│  1:1 Consultation (60 min)               │
│  Wed, Jan 8 at 2:00 PM PST              │
│                                          │
│  ────────────────────────────────────── │
│                                          │
│  Session fee                    $150.00  │
│  Platform fee                    $15.00  │
│  ────────────────────────────────────── │
│  Total                          $165.00  │
│                                          │
│  ┌──────────────────────────────────────┐│
│  │         Book Session →               ││
│  └──────────────────────────────────────┘│
│                                          │
│  🔒 Free cancellation up to 24h before  │
│  💳 Secure payment via Stripe           │
│                                          │
└─────────────────────────────────────────┘
```

---

## Reviews Section Enhancement

### Filter & Sort
```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  REVIEWS                                           127 total reviews │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                                                               │   │
│  │  RATING BREAKDOWN                                            │   │
│  │                                                               │   │
│  │  5★ ████████████████████████████████████████  85 (67%)       │   │
│  │  4★ ██████████████                            28 (22%)       │   │
│  │  3★ ████                                      10 (8%)        │   │
│  │  2★ █                                          3 (2%)        │   │
│  │  1★                                            1 (1%)        │   │
│  │                                                               │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Filter by:  [All Ratings ▾]  [All Topics ▾]  Sort: [Most Recent ▾] │
│                                                                      │
│  ────────────────────────────────────────────────────────────────   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  👤 Alex Martinez        ★★★★★         Verified Session     │   │
│  │  2 days ago • 1:1 Consultation • Product Strategy            │   │
│  │                                                               │   │
│  │  "Sarah's advice was incredibly insightful. She helped me    │   │
│  │  reframe my product roadmap and prioritize features that     │   │
│  │  actually moved the needle. Highly recommend for any PM."    │   │
│  │                                                               │   │
│  │  💬 Sarah responded: "Thanks Alex! Great session..."        │   │
│  │                                                               │   │
│  │  👍 Helpful (12)                                             │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  👤 Jennifer Wu          ★★★★★         Verified Session     │   │
│  │  1 week ago • PM Masterclass                                  │   │
│  │                                                               │   │
│  │  "The class was well-structured and Sarah's real-world       │   │
│  │  examples made complex concepts easy to understand..."       │   │
│  │                                                               │   │
│  │  👍 Helpful (8)                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  [Load more reviews...]                                              │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Micro-interactions

### Slot Selection
```tsx
// Slot button states and animations
const SlotButton = ({ time, available, selected }) => (
  <motion.button
    whileHover={{ scale: 1.02 }}
    whileTap={{ scale: 0.98 }}
    animate={{
      backgroundColor: selected ? '#3B82F6' : available ? '#F3F4F6' : '#E5E7EB',
      color: selected ? 'white' : 'inherit',
    }}
    disabled={!available}
    className={cn(
      "px-4 py-2 rounded-lg transition-all",
      !available && "opacity-50 cursor-not-allowed"
    )}
  >
    {time}
  </motion.button>
);
```

### Booking Confirmation
```tsx
// Success animation after booking
<motion.div
  initial={{ scale: 0 }}
  animate={{ scale: 1 }}
  className="text-center"
>
  <motion.div
    initial={{ scale: 0 }}
    animate={{ scale: 1 }}
    transition={{ delay: 0.2 }}
    className="w-16 h-16 bg-green-500 rounded-full mx-auto flex items-center justify-center"
  >
    <Check className="w-8 h-8 text-white" />
  </motion.div>
  <h3 className="mt-4 text-xl font-semibold">Session Booked!</h3>
  <p className="text-muted-foreground">Check your email for details</p>
</motion.div>
```

---

## Similar Experts Section

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  More Experts in Product Strategy                    [View All →]   │
│                                                                      │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌──────────┐│
│  │               │ │               │ │               │ │          ││
│  │    Photo      │ │    Photo      │ │    Photo      │ │  Photo   ││
│  │               │ │               │ │               │ │          ││
│  │ Michael Park  │ │ Emily Zhang   │ │ David Kim     │ │ Lisa T.  ││
│  │ Meta          │ │ Stripe        │ │ Airbnb        │ │ Uber     ││
│  │ ★ 4.8 (89)   │ │ ★ 4.9 (156)  │ │ ★ 4.7 (67)   │ │ ★ 4.9    ││
│  │ $125/hr       │ │ $175/hr       │ │ $100/hr       │ │ $200/hr  ││
│  │               │ │               │ │               │ │          ││
│  └───────────────┘ └───────────────┘ └───────────────┘ └──────────┘│
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Performance Optimizations

### Server-Side Data Fetching
```tsx
// Convert to server component with parallel data fetching
export default async function ExpertPage({ params }) {
  const [consultant, reviews, availability] = await Promise.all([
    getConsultant(params.consultantId),
    getReviews(params.consultantId),
    getAvailability(params.consultantId, new Date()),
  ]);

  return (
    <>
      <ProfileHeader consultant={consultant} />
      <Suspense fallback={<BookingCardSkeleton />}>
        <BookingCard
          consultant={consultant}
          initialAvailability={availability}
        />
      </Suspense>
      <Suspense fallback={<ReviewsSkeleton />}>
        <Reviews initialReviews={reviews} consultantId={params.consultantId} />
      </Suspense>
    </>
  );
}
```

### Prefetch Adjacent Dates
```tsx
// Prefetch next/previous week availability on mount
useEffect(() => {
  const nextWeek = addDays(selectedDate, 7);
  const prevWeek = subDays(selectedDate, 7);

  queryClient.prefetchQuery({
    queryKey: ['availability', consultantId, formatDate(nextWeek)],
    queryFn: () => fetchAvailability(consultantId, nextWeek),
  });
}, [selectedDate]);
```

---

## Implementation Checklist

### Phase 1: Layout
- [ ] Fix container width (60/40 split)
- [ ] Implement sticky booking sidebar
- [ ] Add mobile sticky footer

### Phase 2: Booking Flow
- [ ] Redesign service selection
- [ ] Enhance calendar UI
- [ ] Add time slot grouping
- [ ] Improve booking summary

### Phase 3: Content
- [ ] Add video introduction support
- [ ] Enhance reviews section
- [ ] Add similar experts
- [ ] Add stats (sessions, response time)

### Phase 4: Performance
- [ ] Convert to server component
- [ ] Add availability prefetching
- [ ] Optimize image loading
- [ ] Add proper skeletons
