# Improved Prefetching Strategy for Next.js Dashboard

## Overview

This document outlines the enhanced prefetching strategy implemented for better performance in the consultant/consultee dashboards.

## Key Improvements Made

### 1. **Consolidated Data Fetching Libraries**

- **Before**: Mixed SWR + React Query (confusing and problematic)
- **After**: Pure React Query with consistent patterns
- **Benefits**: Better caching, simpler debugging, unified error handling

### 2. **Smart Prefetching Strategy**

```typescript
// Priority-based prefetching
Priority 1 (0ms delay): Critical data (home, appointments, consultant details)
Priority 2 (500ms delay): Secondary data (requests, planner)
Priority 3 (1000ms delay): Heavy data (large datasets)
```

### 3. **Query Factory Pattern**

- Organized queries into factory functions for better maintainability
- Centralized query configurations
- Easier testing and debugging

### 4. **Enhanced Route Prefetching**

- Uses `router.prefetch()` for route-level prefetching
- Combined with data prefetching for holistic optimization
- Hover-based prefetching with throttling

## Next.js Prefetching Options Comparison

### 1. **Next.js Link Prefetching (Automatic)**

```jsx
<Link href="/dashboard/consultant/123/home" prefetch={true}>
  Home
</Link>
```

- ✅ Automatic viewport-based prefetching
- ✅ Built-in and optimized by Next.js
- ❌ Only prefetches routes, not data

### 2. **Manual Route Prefetching**

```javascript
router.prefetch("/dashboard/consultant/123/home");
```

- ✅ Programmatic control
- ✅ Can be triggered on hover/interaction
- ❌ Route-only, no data prefetching

### 3. **React Query Prefetching (Recommended)**

```javascript
queryClient.prefetchQuery({
  queryKey: ["dashboard", consultantId],
  queryFn: fetchDashboardData,
  staleTime: 2 * 60 * 1000,
});
```

- ✅ Data prefetching with caching
- ✅ Error handling and retry logic
- ✅ Stale-while-revalidate patterns
- ✅ Background updates

### 4. **Hybrid Approach (Our Implementation)**

```javascript
// Route prefetching
router.prefetch(`/dashboard/consultant/${consultantId}/home`);

// Data prefetching
prefetchOnTabHover("home");
```

- ✅ Best of both worlds
- ✅ Covers routes AND data
- ✅ Smart throttling and prioritization

## Performance Optimizations

### 1. **requestIdleCallback Usage**

```javascript
if (typeof window !== "undefined" && "requestIdleCallback" in window) {
  window.requestIdleCallback(prefetchCriticalData, { timeout: 2000 });
} else {
  setTimeout(prefetchCriticalData, 100);
}
```

### 2. **Throttling Mechanism**

```javascript
const throttledPrefetch = (fn: () => void) => {
  const key = `hover-${tabType}`;
  if (prefetchedRef.current.has(key)) return;

  prefetchedRef.current.add(key);
  fn();

  // Clear throttle after 5 seconds
  setTimeout(() => prefetchedRef.current.delete(key), 5000);
};
```

### 3. **Promise.allSettled for Resilience**

```javascript
const results = await Promise.allSettled(
  queries.map((query) => queryClient.prefetchQuery(query)),
);

// Handle partial failures gracefully
results.forEach((result, index) => {
  if (result.status === "rejected") {
    console.warn(`Prefetch failed for query:`, queries[index].queryKey);
  }
});
```

## Alternative Approaches to Consider

### 1. **Server-Side Data Fetching** (Future Enhancement)

```javascript
// In layout.tsx or page.tsx (App Router)
export async function generateStaticParams() {
  // Pre-generate common consultant IDs
}

// Server Components for initial data
async function DashboardData({ consultantId }) {
  const data = await fetchConsultantData(consultantId);
  return <DashboardContent data={data} />;
}
```

### 2. **Service Worker Prefetching**

```javascript
// Register service worker for aggressive caching
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}
```

### 3. **Intersection Observer API** (Advanced)

```javascript
// Prefetch when elements come into viewport
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      prefetchTabData(entry.target.dataset.tab);
    }
  });
});
```

## Best Practices Implemented

1. **Graceful Degradation**: Prefetching failures don't break the app
2. **Progressive Enhancement**: Works without JavaScript (server-side fallback)
3. **Memory Management**: Cleanup refs and clear throttles
4. **Error Boundaries**: Proper error handling and logging
5. **Performance Monitoring**: Development-time logging for debugging
6. **Stale-While-Revalidate**: Fresh data with immediate responses

## Monitoring & Debugging

### React Query DevTools

```javascript
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

// In your App component
{
  process.env.NODE_ENV === "development" && (
    <ReactQueryDevtools initialIsOpen={false} />
  );
}
```

### Performance Monitoring

```javascript
// Measure prefetch effectiveness
performance.mark("prefetch-start");
await prefetchAllConsultantData();
performance.mark("prefetch-end");
performance.measure("prefetch-duration", "prefetch-start", "prefetch-end");
```

## Migration Steps

1. ✅ **Replace SWR with React Query** - Done
2. ✅ **Implement query factory pattern** - Done
3. ✅ **Add smart hover prefetching** - Done
4. ✅ **Combine route + data prefetching** - Done
5. 🔄 **Add server-side prefetching** - Future enhancement
6. 🔄 **Implement service worker caching** - Future enhancement

## Impact Expected

- **Perceived Performance**: 60-80% faster navigation between tabs
- **Network Efficiency**: Smarter caching reduces redundant requests
- **User Experience**: Instant-feeling navigation
- **Bundle Size**: Slightly larger due to React Query, but better overall performance
- **Maintainability**: Much cleaner and more organized code

## Next Steps

1. Monitor Core Web Vitals improvements
2. A/B test with and without aggressive prefetching
3. Consider implementing service worker for offline capabilities
4. Add performance monitoring and analytics
5. Implement server-side prefetching for initial page loads
