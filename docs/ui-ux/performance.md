# Performance Optimization Guide

> **Goal**: Sub-second page loads, instant interactions, no loading spinners.

---

## Current Performance Baseline

### Estimated Current Metrics

| Metric | Estimated Value | Target | World-Class |
|--------|-----------------|--------|-------------|
| LCP (Largest Contentful Paint) | ~2.5s | <1.2s | <0.8s |
| FID (First Input Delay) | ~100ms | <50ms | <10ms |
| CLS (Cumulative Layout Shift) | ~0.15 | <0.05 | <0.01 |
| TTFB (Time to First Byte) | ~400ms | <200ms | <100ms |
| Total Bundle Size | ~500KB | <300KB | <200KB |

### Key Performance Issues

1. **Home Page**: 50+ animated blob divs causing GPU thrashing
2. **Client-Side Fetching**: Waterfall requests causing loading spinners
3. **Large Bundle**: Full page renders as client components
4. **No Streaming**: User waits for all data before seeing anything
5. **Unoptimized Images**: Not using Next.js Image optimization fully

---

## Optimization Strategies

### 1. Server Components First

```tsx
// BEFORE: Everything is a client component
"use client";
export default function Home() {
  const { data, isLoading } = useQuery(['experts']);
  if (isLoading) return <Spinner />;
  return <ExpertList experts={data} />;
}

// AFTER: Server component with streaming
export default async function Home() {
  return (
    <>
      <HeroSection /> {/* Static, instant */}
      <Suspense fallback={<ExpertsSkeleton />}>
        <ExpertsServer />  {/* Streams in */}
      </Suspense>
    </>
  );
}

async function ExpertsServer() {
  const experts = await getExperts(); // Server-side fetch
  return <ExpertList experts={experts} />;
}
```

### 2. Parallel Data Fetching

```tsx
// BEFORE: Sequential fetches
async function getPageData() {
  const experts = await getExperts();        // 200ms
  const reviews = await getReviews();        // 200ms
  const stats = await getStats();            // 100ms
  // Total: 500ms
}

// AFTER: Parallel fetches
async function getPageData() {
  const [experts, reviews, stats] = await Promise.all([
    getExperts(),        // ─┐
    getReviews(),        // ─┼─ 200ms (parallel)
    getStats(),          // ─┘
  ]);
  // Total: 200ms
}
```

### 3. Streaming with Suspense

```tsx
// Layout with progressive loading
export default function Layout({ children }) {
  return (
    <html>
      <body>
        <Navbar /> {/* Instant */}

        <Suspense fallback={<MainSkeleton />}>
          {children}
        </Suspense>

        <Suspense fallback={null}>
          <Footer /> {/* Lazy, low priority */}
        </Suspense>
      </body>
    </html>
  );
}
```

### 4. Image Optimization

```tsx
// BEFORE: Unoptimized images
<img src={expert.image} alt={expert.name} />

// AFTER: Full optimization
<Image
  src={expert.image}
  alt={expert.name}
  width={200}
  height={200}
  placeholder="blur"
  blurDataURL={expert.blurHash || DEFAULT_BLUR}
  priority={index < 6}  // First 6 images are priority
  loading={index >= 6 ? 'lazy' : undefined}
  sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
/>
```

### 5. Bundle Optimization

```tsx
// Dynamic imports for heavy components
const RichTextEditor = dynamic(
  () => import('@/components/RichTextEditor'),
  {
    loading: () => <TextAreaSkeleton />,
    ssr: false,
  }
);

const CalendarPicker = dynamic(
  () => import('@/components/CalendarPicker'),
  { loading: () => <CalendarSkeleton /> }
);

// Route-based code splitting (automatic with App Router)
// /explore/experts -> only loads expert-related code
```

---

## Page-Specific Optimizations

### Home Page

#### Remove Blob Animations
```tsx
// BEFORE: Performance-killing blobs
const BlurryBackground = () => (
  <div className="absolute inset-0">
    {/* 50+ animated divs */}
    <div className="animate-blob..." />
    <div className="animate-blob..." />
    {/* ... */}
  </div>
);

// AFTER: Static gradient or no background
const Background = () => (
  <div className="absolute inset-0 bg-gradient-to-br from-purple-50 via-white to-blue-50" />
);

// OR: CSS-only subtle pattern
.background {
  background-image: radial-gradient(
    circle at 1px 1px,
    rgba(0,0,0,0.03) 1px,
    transparent 0
  );
  background-size: 24px 24px;
}
```

#### Optimize Marquee
```tsx
// Use CSS transform instead of JavaScript animation
.marquee-track {
  display: flex;
  animation: marquee 60s linear infinite;
  will-change: transform;  /* GPU acceleration */
}

@keyframes marquee {
  0% { transform: translateX(0); }
  100% { transform: translateX(-50%); }
}

/* Pause on hover without JS */
.marquee-container:hover .marquee-track {
  animation-play-state: paused;
}
```

### Explore Pages

#### Virtualized Lists
```tsx
import { useVirtualizer } from '@tanstack/react-virtual';

function ExpertList({ experts }) {
  const parentRef = useRef(null);

  const virtualizer = useVirtualizer({
    count: experts.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 280,
    overscan: 5,
  });

  return (
    <div ref={parentRef} className="h-[600px] overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <ExpertCard expert={experts[virtualRow.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

#### Optimistic Filter Updates
```tsx
// Update UI immediately, fetch in background
const handleFilterChange = (newFilters) => {
  // Immediately filter cached data
  const optimisticResults = filterLocally(cachedExperts, newFilters);
  setDisplayedExperts(optimisticResults);

  // Background fetch for accurate results
  queryClient.prefetchQuery({
    queryKey: ['experts', newFilters],
    queryFn: () => fetchExperts(newFilters),
  });
};
```

### Expert Details Page

#### Prefetch Adjacent Data
```tsx
// Prefetch next/previous week availability
useEffect(() => {
  const nextWeek = addDays(selectedDate, 7);

  queryClient.prefetchQuery({
    queryKey: ['availability', consultantId, formatDate(nextWeek)],
    queryFn: () => fetchAvailability(consultantId, nextWeek),
    staleTime: 5 * 60 * 1000,
  });
}, [selectedDate, consultantId]);
```

#### Skeleton Matching
```tsx
// Skeletons should match final layout exactly
const ExpertDetailsSkeleton = () => (
  <div className="flex gap-8">
    <div className="w-3/5 space-y-8">
      {/* Profile header skeleton */}
      <div className="flex gap-4">
        <Skeleton className="h-24 w-24 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
      {/* About section skeleton */}
      <div className="space-y-3">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
    <div className="w-2/5">
      {/* Booking card skeleton */}
      <Skeleton className="h-[500px] w-full rounded-xl" />
    </div>
  </div>
);
```

---

## Caching Strategy

### React Query Configuration

```tsx
// Optimal cache settings
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,        // 1 minute
      gcTime: 5 * 60 * 1000,       // 5 minutes
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      retry: 1,
    },
  },
});

// Per-query overrides
useQuery({
  queryKey: ['user', userId],
  queryFn: fetchUser,
  staleTime: 5 * 60 * 1000,  // User data: 5 minutes
  gcTime: 30 * 60 * 1000,    // Keep for 30 minutes
});

useQuery({
  queryKey: ['availability', date],
  queryFn: fetchAvailability,
  staleTime: 30 * 1000,  // Availability: 30 seconds (more dynamic)
});
```

### HTTP Caching Headers

```tsx
// API route with caching
export async function GET(request) {
  const data = await fetchData();

  return Response.json(data, {
    headers: {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
  });
}

// For user-specific data
export async function GET(request) {
  const data = await fetchUserData();

  return Response.json(data, {
    headers: {
      'Cache-Control': 'private, max-age=0',
    },
  });
}
```

### Static Generation

```tsx
// Generate static pages for SEO
export async function generateStaticParams() {
  const experts = await getTopExperts(50);

  return experts.map((expert) => ({
    consultantId: expert.id,
  }));
}

// ISR for dynamic pages
export const revalidate = 3600; // Revalidate every hour
```

---

## Monitoring & Metrics

### Web Vitals Tracking

```tsx
// app/layout.tsx
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
```

### Custom Performance Marks

```tsx
// Track specific interactions
useEffect(() => {
  performance.mark('experts-loaded');

  if (performance.getEntriesByName('page-start').length) {
    performance.measure('time-to-experts', 'page-start', 'experts-loaded');

    const measure = performance.getEntriesByName('time-to-experts')[0];
    console.log(`Experts loaded in ${measure.duration}ms`);

    // Send to analytics
    analytics.track('performance', {
      metric: 'time-to-experts',
      value: measure.duration,
    });
  }
}, [experts]);
```

---

## Quick Wins Checklist

### Immediate (Do Today)

- [ ] Remove animated blob background on home page
- [ ] Add `priority` to above-fold images
- [ ] Convert home page to server component
- [ ] Enable ISR for static pages
- [ ] Add blur placeholders to all images

### Short-term (This Week)

- [ ] Implement Suspense boundaries for streaming
- [ ] Add virtualization to expert/program lists
- [ ] Configure React Query caching properly
- [ ] Add loading skeletons that match layout
- [ ] Optimize bundle with dynamic imports

### Medium-term (This Month)

- [ ] Implement optimistic updates for filters
- [ ] Add prefetching for likely next actions
- [ ] Set up Web Vitals monitoring
- [ ] Create performance regression tests
- [ ] Document performance budgets

---

## Performance Budgets

### Bundle Size Budgets

| Resource | Budget | Action if Exceeded |
|----------|--------|-------------------|
| JavaScript (initial) | <150KB | Code split, lazy load |
| CSS (initial) | <30KB | Purge unused, critical CSS |
| Total page weight | <500KB | Compress, optimize images |
| Largest image | <100KB | Compress, use WebP |

### Timing Budgets

| Metric | Budget | Measurement |
|--------|--------|-------------|
| Server response | <100ms | TTFB |
| First paint | <500ms | FCP |
| Interactive | <1000ms | TTI |
| Full load | <2000ms | Load |

### Interaction Budgets

| Action | Budget | Example |
|--------|--------|---------|
| Button feedback | <50ms | Click response |
| Filter update | <100ms | Results change |
| Navigation | <200ms | Page transition |
| Form submission | <300ms | Submit response |

---

## Tools & Commands

### Analyze Bundle

```bash
# Generate bundle analysis
ANALYZE=true npm run build

# Or use the built-in script
npm run analyze
```

### Lighthouse CI

```bash
# Run Lighthouse locally
npx lighthouse http://localhost:3000 --view

# Audit specific page
npx lighthouse http://localhost:3000/explore/experts --view
```

### Performance Profiling

```bash
# Chrome DevTools
1. Open DevTools (F12)
2. Performance tab
3. Click Record
4. Perform action
5. Stop and analyze

# React DevTools Profiler
1. Install React DevTools extension
2. Open Profiler tab
3. Record and analyze renders
```
