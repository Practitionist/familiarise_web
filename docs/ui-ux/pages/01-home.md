# Home Page Modernization Guide

> **Route**: `/` (app/page.tsx)
> **Priority**: P0 - Critical
> **Current Issues**: Performance-heavy blob animations, generic hero, waterfall data fetching

---

## Current State Analysis

### What's Working
- Good section variety (Hero, Features, Experts, Testimonials, FAQ)
- Marquee animations for experts/testimonials
- Mobile-responsive layout

### What Needs Work
- **50+ animated blob divs** causing GPU overhead and jank
- Hero lacks punch - generic headline
- Too much vertical scroll before reaching value
- Data waterfall: images -> experts -> reviews (sequential)
- No above-fold CTA specificity
- Newsletter section feels disconnected

---

## Redesigned Structure

### Section Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ NAVBAR (sticky, blur backdrop)                                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                        HERO SECTION                                  │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  "Find Your Perfect Expert in 60 Seconds"                   │    │
│  │                                                              │    │
│  │  [Search by expertise, name, or topic...            🔍]     │    │
│  │                                                              │    │
│  │  Popular: Product Design • Startup Advice • Career Coach    │    │
│  │                                                              │    │
│  │  Trusted by 10,000+ professionals                           │    │
│  │  ★★★★★ 4.9 average rating from 2,500+ sessions             │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                    SOCIAL PROOF BAR                                  │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  [Logo] [Logo] [Logo] [Logo] [Logo]                         │    │
│  │  "Experts from Google, Meta, Stripe, and 500+ companies"    │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                    FEATURED EXPERTS CAROUSEL                         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                                                              │    │
│  │  "Top-Rated Experts This Week"                              │    │
│  │                                                              │    │
│  │  ◀ [Expert] [Expert] [Expert] [Expert] [Expert] ▶           │    │
│  │       Card     Card     Card     Card     Card              │    │
│  │                                                              │    │
│  │  [Browse All Experts →]                                      │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                    HOW IT WORKS                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                                                              │    │
│  │   ①              ②               ③              ④          │    │
│  │  Find          Book           Connect        Grow          │    │
│  │  Expert        Session        via Video      Together      │    │
│  │                                                              │    │
│  │  Interactive step-by-step with micro-animations            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                    VALUE PROPOSITIONS                                │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐           │
│  │ 1:1 Sessions   │ │ Group Classes  │ │ Live Webinars  │           │
│  │                │ │                │ │                │           │
│  │ Personalized   │ │ Interactive    │ │ Scale your     │           │
│  │ guidance       │ │ learning       │ │ knowledge      │           │
│  │                │ │                │ │                │           │
│  │ From $30/hr    │ │ From $50       │ │ From $20       │           │
│  │ [Book Now]     │ │ [Explore]      │ │ [View All]     │           │
│  └────────────────┘ └────────────────┘ └────────────────┘           │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                    TESTIMONIALS                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                                                              │    │
│  │  "What Our Community Says"                                  │    │
│  │                                                              │    │
│  │  ←← Infinite scroll marquee (pause on hover) →→            │    │
│  │  ←← Reverse direction row →→                                │    │
│  │                                                              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                    BECOME AN EXPERT CTA                              │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                                                              │    │
│  │  "Share Your Expertise, Earn While You Teach"               │    │
│  │                                                              │    │
│  │  Join 500+ experts earning $5,000+/month                    │    │
│  │                                                              │    │
│  │  [Start Earning Today]                                       │    │
│  │                                                              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                    FAQ (Accordion)                                   │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  ▸ How do I find the right expert?                          │    │
│  │  ▸ What if I'm not satisfied with my session?               │    │
│  │  ▸ How does payment work?                                   │    │
│  │  ▸ Can I reschedule my booking?                             │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                    FOOTER                                            │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Hero Section Redesign

### Current Problems
- Generic headline: "Elevate Your Career with Familiarise"
- No clear value proposition
- CTA says "Get Started" - too vague
- Social proof buried below fold

### New Hero Design

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│          ┌─ Subtle gradient background (not animated blobs)         │
│          │                                                           │
│   Badge: │ ⭐ #1 Expert Platform • 4.9/5 from 2,500+ reviews        │
│          │                                                           │
│          │      Find Your Perfect Expert                             │
│          │      in Under 60 Seconds                                  │
│          │                                                           │
│          │  Book 1:1 sessions with verified industry leaders.       │
│          │  No scheduling hassles. Instant video calls.             │
│          │                                                           │
│          │  ┌───────────────────────────────────────────────────┐   │
│          │  │ 🔍 Search "product management", "startup"...      │   │
│          │  │                                     [Find Expert] │   │
│          │  └───────────────────────────────────────────────────┘   │
│          │                                                           │
│          │  Popular: Design • Engineering • Marketing • Finance     │
│          │                                                           │
│          │  ┌──────────────────────────────────────┐                │
│          │  │ 👤👤👤👤👤 +2,847 sessions this week │                │
│          │  │ "Life-changing advice!" - Sarah K.  │                │
│          │  └──────────────────────────────────────┘                │
│          │                                                           │
│          └──────────────────────────────────────────────────────────│
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Hero Copy Alternatives

**Option A - Speed Focus:**
> "Book Expert Advice in 60 Seconds"
> Skip the networking. Skip the cold emails. Connect directly with proven experts.

**Option B - Outcome Focus:**
> "Get Unstuck, Fast"
> 1-on-1 sessions with industry leaders who've solved your exact problem.

**Option C - Social Proof Focus:**
> "Join 10,000+ Professionals Getting Expert Advice"
> 4.9★ rated platform with experts from Google, Meta, and 500+ companies.

---

## Performance Optimizations

### Remove Blob Animations
```tsx
// BEFORE: 50+ animated divs causing GPU thrashing
<BlurryBackground /> // Remove this entirely

// AFTER: Static gradient or subtle CSS-only effect
<div className="absolute inset-0 bg-gradient-to-br from-purple-50 via-white to-blue-50" />
```

### Implement Streaming with Suspense
```tsx
// BEFORE: Client-side waterfall
const { data: experts } = useQuery(['experts']...);

// AFTER: Server components with streaming
export default async function Home() {
  return (
    <>
      <HeroSection /> {/* Static, instant */}
      <Suspense fallback={<ExpertsSkeleton />}>
        <FeaturedExpertsServer /> {/* Streams in */}
      </Suspense>
      <Suspense fallback={<TestimonialsSkeleton />}>
        <TestimonialsServer /> {/* Streams in */}
      </Suspense>
    </>
  );
}
```

### Optimize Images
```tsx
// Use Next.js Image with priority for LCP
<Image
  src={heroImage}
  priority
  placeholder="blur"
  blurDataURL={heroBlurHash}
  sizes="(max-width: 768px) 100vw, 50vw"
/>
```

---

## Component Specifications

### Expert Card (Redesigned)

```
┌─────────────────────────────┐
│  ┌─────────┐                │
│  │         │ ★ 4.9 (127)    │
│  │  Photo  │                │
│  │         │ 🟢 Available   │
│  └─────────┘                │
│                              │
│  Sarah Chen                  │
│  Product Lead @ Google       │
│                              │
│  Product Strategy • Growth   │
│                              │
│  "10+ years scaling..."      │
│                              │
│  From $150/hr                │
│  ────────────────────────   │
│  [View Profile]              │
└─────────────────────────────┘
```

### Key Improvements:
1. Show availability status (green dot = available today)
2. Company affiliation prominent
3. Expertise tags
4. Clear pricing
5. Hover state: slight lift + shadow
6. Click anywhere to navigate

---

## Animation Guidelines

### Allowed Animations
- Page transitions (opacity fade, 200ms)
- Card hover effects (translateY -2px, 150ms)
- Button press states (scale 0.98, 100ms)
- Marquee scroll (60fps, GPU-accelerated)

### Removed Animations
- Blob background animations
- Complex entrance animations
- Parallax effects
- Auto-playing carousels

### Motion Tokens
```css
--duration-instant: 100ms;
--duration-fast: 150ms;
--duration-normal: 200ms;
--duration-slow: 300ms;

--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
```

---

## Data Fetching Strategy

### Server-Side Prefetching
```tsx
// app/page.tsx - Server Component
import { prefetchHomeData } from '@/lib/prefetch';

export default async function Home() {
  // Parallel fetch on server
  const [experts, reviews, stats] = await Promise.all([
    getTopExperts(10),
    getLatestReviews(20),
    getPlatformStats(),
  ]);

  return (
    <HomePageClient
      initialExperts={experts}
      initialReviews={reviews}
      stats={stats}
    />
  );
}
```

### Stale-While-Revalidate
```tsx
// For dynamic content, use SWR pattern
const { data } = useQuery({
  queryKey: ['experts'],
  queryFn: fetchExperts,
  staleTime: 60 * 1000, // 1 minute
  gcTime: 5 * 60 * 1000, // 5 minutes
});
```

---

## Mobile Considerations

### Touch Targets
- All buttons: minimum 44x44px
- Cards: full-width on mobile
- Navigation: bottom sheet menu

### Simplified Mobile Hero
```
┌─────────────────────┐
│                     │
│  Find Your Expert   │
│                     │
│  ┌───────────────┐  │
│  │ 🔍 Search...  │  │
│  └───────────────┘  │
│                     │
│  [Browse Experts]   │
│                     │
│  👤👤👤 2,847 this  │
│        week         │
│                     │
└─────────────────────┘
```

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| LCP | ~2.5s | <1.0s |
| Time to Interactive | ~3s | <1.5s |
| Bounce Rate | ~45% | <30% |
| CTA Click Rate | ~2% | >5% |
| Expert Card Clicks | ~8% | >15% |

---

## Implementation Checklist

- [ ] Remove BlurryBackground component
- [ ] Implement static gradient background
- [ ] Redesign Hero with search bar
- [ ] Add social proof bar
- [ ] Convert to Server Component with Suspense
- [ ] Optimize image loading (priority, blur)
- [ ] Redesign Expert cards
- [ ] Simplify marquee animation
- [ ] Add proper loading skeletons
- [ ] Mobile responsive polish
- [ ] A/B test new hero copy
