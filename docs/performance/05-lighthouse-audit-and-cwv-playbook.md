# Lighthouse Audit & Core Web Vitals Playbook

| Field         | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status        | Active                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Audience      | All engineers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Last reviewed | 2026-10-03                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Baseline PR   | [#1972](https://github.com/Practitionist/familiarise_web/pull/1972) (`deploy-preview-1972--familiarise.netlify.app`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Source files  | `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `next.config.mjs`, `instrumentation-client.ts`, `sentry.shared.config.ts`, `components/home/HeroSection.tsx`, `components/home/BenefitsSection.tsx`, `components/home/FeaturedExpertsSection.tsx`, `components/home/SuccessStoriesSection.tsx`, `components/home/TestimonialsSection.tsx`, `components/home/UpcomingEventsSection.tsx`, `components/ui/avatar.tsx`, `components/CookieConsent.tsx`, `components/Footer.tsx`, `app/explore/experts/components/StickyFilterBar.tsx`, `app/explore/experts/components/SearchBar.tsx`, `utils/image.tsx` |

## 1. Overview and Context

Following the resolution of the Netlify cold-start `NextNodeServer` preload hang in [PR #1972](https://github.com/Practitionist/familiarise_web/pull/1972) (`experimental.preloadEntriesOnStart: false` and `experimental.appDocumentPreloading: false` in [`next.config.mjs`](../../next.config.mjs)), server-side Time to First Byte (TTFB) dropped from a 29.5–37.6s V8 heap stall (`504 Gateway Timeout`) to **330–450 ms** on warm/ISR hits and **0.97–1.90 s** under cold-start bursts.

With server responsiveness restored, we ran full **Lighthouse 13.5.0** audits via the `lighthouse` MCP server (`lighthouse-mcp`) against `deploy-preview-1972--familiarise.netlify.app` and `familiarisenow.com` across key public routes (`/`, `/explore/experts`, `/about`) to establish an authoritative Core Web Vitals (CWV) baseline and identify every remaining client-side bottleneck preventing **95–100** scores across **Performance**, **Accessibility**, **Best Practices**, and **SEO**.

---

## 2. Baseline Lighthouse Scores & Core Web Vitals (2026-10-03)

### 2.1 Category Scores Summary

| Route & Environment                           | Device / Mode         | Performance              | Accessibility | Best Practices | SEO (Preview / Prod Adjusted\*) |
| --------------------------------------------- | --------------------- | ------------------------ | ------------- | -------------- | ------------------------------- |
| `familiarisenow.com/` (Pre-#1972 on ISR miss) | Mobile (4G Throttled) | **N/A (`504` at 30.6s)** | N/A           | N/A            | N/A                             |
| `deploy-preview-1972` `/`                     | Mobile (4G Throttled) | **37 – 49**              | **94**        | **92**         | **58** (92 on prod\*)           |
| `deploy-preview-1972` `/`                     | Desktop (Throttled)   | **31**                   | **94**        | **92**         | **58** (92 on prod\*)           |
| `deploy-preview-1972` `/`                     | Desktop (Unthrottled) | **79**                   | **94**        | **92**         | **58** (92 on prod\*)           |
| `deploy-preview-1972` `/explore/experts`      | Mobile (4G Throttled) | **47 – 48**              | **92**        | **92**         | **66** (100 on prod\*)          |
| `deploy-preview-1972` `/about`                | Mobile (4G Throttled) | **63**                   | **94**        | **92**         | **66** (100 on prod\*)          |

> \* **Note on Deploy-Preview Artifacts (`SEO` and `Best Practices`):**
> Netlify automatically injects two preview-only features on `*.netlify.app` deploy previews that are **absent on production (`familiarisenow.com`)**:
>
> 1. **`x-robots-tag: noindex` HTTP Header**: Causes Lighthouse's `is-crawlable` audit (weight `4.04` of `11`) to fail on every preview route, deducting **34 points** from the SEO score (`100 → 66` on `/explore/experts` and `/about`; `92 → 58` on `/`).
> 2. **Netlify Collaborative Deploy Preview (CDP) Widget (`/.netlify/scripts/cdp` & `https://app.netlify.com/cdp/`)**: Injects an iframe and three onboarding videos (`deploy-previews-feedback-v2.mp4`, `deploy-previews-notifications-v2.mp4`, `deploy-previews-workflow-v2.mp4` totaling **1,318 KiB**), which trigger a report-only `Content-Security-Policy` (`frame-src`) console error and a third-party cookie DevTools inspector issue, deducting **8 points** (`100 → 92`) from **Best Practices**.

### 2.2 Core Web Vitals & Timing Breakdown

| Metric                             | `/` (Mobile 4G Simulated) | `/` (Observed Trace) | `/` (Desktop Unthrottled) | `/explore/experts` (Mobile 4G Simulated) | `/explore/experts` (Observed Trace) | `/about` (Mobile 4G Simulated) | CWV "Good" Target |
| ---------------------------------- | ------------------------- | -------------------- | ------------------------- | ---------------------------------------- | ----------------------------------- | ------------------------------ | ----------------- |
| **TTFB** (Root Document)           | 618 ms                    | 450 ms               | ~220 ms                   | 836 ms                                   | 330 ms                              | ~400 ms                        | **< 800 ms**      |
| **FCP** (First Contentful Paint)   | 1.2 – 3.3 s               | 943 ms               | 0.3 s (281 ms)            | 1.5 s (1,454 ms)                         | 1,205 ms                            | 1.2 s (1,238 ms)               | **< 1.8 s**       |
| **LCP** (Largest Contentful Paint) | **8.3 s** (8,259 ms)      | **2,178 ms**         | **2.4 s** (2,394 ms)      | **6.0 – 6.4 s**                          | **1,674 ms**                        | **5.7 s** (5,669 ms)           | **< 2.5 s**       |
| **TBT** (Total Blocking Time)      | **1,230 – 1,700 ms**      | —                    | 190 ms                    | **1,570 – 2,190 ms**                     | —                                   | **610 ms**                     | **< 200 ms**      |
| **CLS** (Cumulative Layout Shift)  | **0.006 – 0.011**         | 0.006                | **0.002**                 | **0 – 0.003**                            | 0.003                               | **0.011**                      | **< 0.10**        |
| **Speed Index**                    | 4.1 – 6.1 s               | 1,715 ms             | 1.9 s                     | 4.4 – 4.5 s                              | 2,022 ms                            | 3.2 s                          | **< 3.4 s**       |
| **TTI** (Time to Interactive)      | **8.4 – 8.5 s**           | —                    | 2.5 s                     | **6.3 – 6.4 s**                          | —                                   | 5.7 s                          | **< 3.8 s**       |
| **JS Bootup Time**                 | **2.6 s**                 | —                    | —                         | **3.3 s**                                | —                                   | —                              | **< 1.0 s**       |
| **Main-Thread Work**               | **10.3 s**                | —                    | —                         | **9.7 s**                                | —                                   | —                              | **< 2.0 s**       |

---

## 3. Root-Cause Analysis of Score Bottlenecks

### 3.1 Bottleneck 1 (LCP 8.3s on `/`): Above-the-Fold Framer Motion `initial={{ opacity: 0 }}` SSR Trap

Even on an unthrottled desktop connection where **FCP is 280 ms**, **LCP on `/` is 2,394 ms** (and **8,338 ms** on throttled mobile).

- **LCP Element Identified by Lighthouse**:
  ```html
  <h1
    class="text-fluid-5xl font-bold text-white mb-6 leading-tight tracking-tight"
  >
    Learn from the best minds in your industry
  </h1>
  ```
- **Root Cause**: [`components/home/HeroSection.tsx`](../../components/home/HeroSection.tsx) (`"use client"`, lines 82–174) wraps every above-the-fold element—the verification badge (`motion.div`), the main headline (`motion.h1`), the subheadline (`motion.p`), the CTA buttons (`motion.div`), and the stats grid (`motion.div`)—in Framer Motion components with `initial={{ opacity: 0, y: 20 }}` and staggered delays (`delay: 0.1` to `0.4`, `duration: 0.6`).
- **Why This Destroys LCP**: During ISR/SSR prerendering of [`app/page.tsx`](../../app/page.tsx), Framer Motion serializes `style="opacity:0;transform:translateY(20px)"` directly into the static HTML. Because Chromium's Largest Contentful Paint algorithm ignores elements with `opacity: 0`, the `<h1>` is not recorded when the HTML and font arrive at `943 ms`. Instead, the hero sits blank until:
  1. All client JavaScript bundles (`42384`, `4bd1b696`, `30783`, `60668`) finish downloading over the throttled 4G network,
  2. All **2.6 seconds** of main-thread script evaluation (Sentry init + React hydration + Framer Motion layout measurement) finish executing, and
  3. Framer Motion runs the `100 ms` delay + `600 ms` opacity transition to `opacity: 1`.
- Because `observedLargestContentfulPaint` (`2,178 ms`) occurs **after** `observedLoad` (`2,117 ms`) and JS hydration, Lighthouse's Lantern simulator models the entire JS download and main-thread execution graph as a prerequisite for LCP, projecting **8.3 s**.

### 3.2 Bottleneck 2 (TBT 1,230–2,840 ms): Eager Sentry Client Initialization & Root-Layout Hydration Storm

Lighthouse flags **Reduce JavaScript execution time** (`2.6 s` on `/`, `3.3 s` on `/explore/experts`) and **Minimize main-thread work** (`10.3 s` on `/`, `9.7 s` on `/explore/experts`):

| Chunk / Script                                     | Transfer Size (Gzip) | Raw Size | Unused Bytes (%)    | Main-Thread CPU Time (`/`)        | Main-Thread CPU Time (`/explore/experts`) | Primary Contents                                                                                                 |
| -------------------------------------------------- | -------------------- | -------- | ------------------- | --------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `_next/static/chunks/42384-1f2b651140f162bf.js`    | **103.5 KB**         | 368.3 KB | **39.8 KB (38.4%)** | **3,049 ms** (2,127 ms scripting) | **2,265 ms** (1,746 ms scripting)         | `@sentry/nextjs` client SDK, tracing/span/breadcrumb integrations, PII scrubber, Next.js client router internals |
| `_next/static/chunks/4bd1b696-6b80f5c3905964fb.js` | **52.6 KB**          | 173.4 KB | < 5 KB              | **69 ms**                         | **797 ms** (610 ms scripting)             | `react-dom` client hydration runtime                                                                             |
| `_next/static/chunks/30783-25a13fdc6d75635e.js`    | **36.1 KB**          | 115.6 KB | **21.0 KB (58.1%)** | **89 ms**                         | **197 ms** (135 ms scripting)             | `framer-motion` (`motion.*`, `whileInView`, projection engine)                                                   |
| `_next/static/chunks/60668-27e0d7f66ffe7462.js`    | **33.6 KB**          | 112.8 KB | **23.7 KB (70.6%)** | **92 ms**                         | **90 ms**                                 | `react-cookie-consent`, `next-nprogress-bar`, `@tanstack/react-query`, Next navigation helpers                   |

- **Synchronous `@sentry/nextjs` Client Init**: [`instrumentation-client.ts`](../../instrumentation-client.ts) calls `initSentry()` ([`sentry.shared.config.ts`](../../sentry.shared.config.ts)) synchronously at module evaluation time before React hydration starts. In non-production (`preview`) environments, `tracesSampleRate` is `1.0` (100% of spans traced and scrubbed through [`lib/observability/sentry-scrubber.ts`](../../lib/observability/sentry-scrubber.ts)), and `enableLogs: true` is active. Chunk `42384` alone accounts for **65–75% of all script evaluation time** (`1.75–2.13 s` on the main thread) and also triggers the `legacy-javascript-insight` warning (`12 KiB` wasted polyfills).
- **Root Layout Client-Provider Cascade**: [`app/layout.tsx`](../../app/layout.tsx) mounts 9 client components across the entire app shell (`ReactQueryProvider`, `AuthSyncProvider`, `MaintenanceProvider`, `AnnouncementBarProvider`, `NavigationProgress`, `Toaster`, `MaintenanceBanner`, `AnnouncementBar`, `Navbar`, `Footer`, `CookieConsentBanner`). On initial mount, these components immediately fire **four parallel client-side `fetch()` requests** during hydration:
  1. `GET /api/auth/get-session` (via `useSession()` in [`Navbar.tsx`](../../components/Navbar.tsx) and [`AuthSyncProvider.tsx`](../../providers/AuthSyncProvider.tsx))
  2. `GET /api/health` (via `useQuery(["health"])` in [`MaintenanceProvider.tsx`](../../providers/MaintenanceProvider.tsx))
  3. `GET /api/announcements/active` (via `useActiveAnnouncements()` in [`AnnouncementBar.tsx`](../../components/AnnouncementBar.tsx))
  4. `GET /api/cookie-preferences` (via `useEffect` in [`CookieConsent.tsx`](../../components/CookieConsent.tsx))
     Each response resolves mid-hydration and triggers top-level state updates and `ResizeObserver` CSS custom-property mutations (`--maintenance-banner-height`, `--announcement-bar-height`, `--cookie-bar-height`), contributing to the `forced-reflow-insight` warning and extending TBT.

### 3.3 Bottleneck 3 (Bandwidth Contention): Below-the-Fold `<Image priority>` Preload in `BenefitsSection`

- **Root Cause**: [`components/home/BenefitsSection.tsx`](../../components/home/BenefitsSection.tsx) (line 81) renders its illustration using `renderLCPImage(images, 0, "/placeholder.svg", 600, 400)` from [`utils/image.tsx`](../../utils/image.tsx) (line 47), which sets `priority={true}` on `<Image>`.
- **Impact**: `BenefitsSection` is the **5th section** on the home page (`top: ~4,300px`, more than 5 viewports below the fold on mobile). Because `priority={true}` emits `<link rel="preload" as="image" fetchpriority="high">` in `<head>`, Chrome fetches `landing-01.jpg` (`39 KB`) as the **4th network request of the entire page load**, competing directly with the `Sora` webfont (`33.8 KB`), the root stylesheet (`26.1 KB`), and the Navbar logo (`10.3 KB`).

### 3.4 Bottleneck 4 (1.32–1.62 MB Wasted Image Payload & 2,214 DOM Nodes): Raw `<img>` in Radix `<AvatarImage>` & Marquee Duplication

Lighthouse's `image-delivery-insight` flags **1,319 KiB** of avoidable image downloads on `/` and **1,620 KiB** on `/explore/experts`:

- **Why `<AvatarImage>` Bypasses Next.js Image Optimization**: [`components/ui/avatar.tsx`](../../components/ui/avatar.tsx) wraps `@radix-ui/react-avatar`'s `<AvatarPrimitive.Image>`, which renders a raw HTML `<img>` element rather than `next/image`, with no `loading="lazy"` or `decoding="async"`.
  - Consultant and testimonial avatars stored on `cdn.jsdelivr.net/gh/faker-js/assets-person-portrait/*/512/*.jpg` (`1024×1024`, **208–309 KB each**) and `avatars.githubusercontent.com` (**56 KB**) are fetched at full unoptimized resolution for `24×24px` to `80×80px` avatars.
  - Because `<img>` defaults to `loading="eager"`, the browser downloads all avatar images across below-the-fold sections during initial page load.
- **Marquee DOM Multiplication (`2,214` Total Elements)**:
  - [`components/home/TestimonialsSection.tsx`](../../components/home/TestimonialsSection.tsx) (lines 69–73, 118, 143) triples `reviews` when `reviews.length < 3`, and then spreads `[...displayReviews, ...displayReviews, ...displayReviews]` in **two** marquee rows (`6×` to `18×` copies of every review card).
  - [`components/home/FeaturedExpertsSection.tsx`](../../components/home/FeaturedExpertsSection.tsx) (line 143) spreads `[...experts, ...experts]` (`2×` copies).
  - Combined with 15 landing-page sections all hydrated via `framer-motion` `whileInView` observers, total DOM size reaches **2,214 nodes** (`dom-size-insight`), inflating Style & Layout (`2,319 ms`) and Rendering (`1,378 ms`) main-thread work.

### 3.5 Bottleneck 5 (Render-Blocking CSS): Monolithic `app/globals.css` (`86.6%` Unused on Public Routes)

- **Root Cause**: [`app/globals.css`](../../app/globals.css) (`1,576 lines`, `40.9 KB` raw, `26.4 KB` transferred as `_next/static/css/a4fd0beabaf48670.css`) is a render-blocking request costing **152–306 ms** (`render-blocking-insight`), with **22.8 KB (86.6%)** unused on `/` and `/explore/experts` (`unused-css-rules`).
- It includes dormant `.dark` and `body:has(.onboarding-shell)` token overrides, dashboard-specific scrollport/layout utilities, and heavy `blur-[100px]` / `blur-[150px]` animated blob keyframes (`animate-blob`) that also increase GPU compositing time on mobile devices.

### 3.6 Bottleneck 6 (Accessibility & SEO Audit Failures Preventing 100/100 Scores)

Lighthouse identified four deterministic Accessibility and SEO audit failures in application code:

1. **Missing `alt` Attributes on `<AvatarImage>` (`image-alt`, failing in both Accessibility [weight 10] and SEO [weight 1] on `/`)**:
   - [`components/home/SuccessStoriesSection.tsx`](../../components/home/SuccessStoriesSection.tsx) (line 29): `<AvatarImage src={story.image} />` — missing `alt={story.name}`.
   - [`components/home/TestimonialsSection.tsx`](../../components/home/TestimonialsSection.tsx) (line 32): `<AvatarImage src={review.consulteeProfile?.user?.image ?? ""} />` — missing `alt={review.consulteeProfile?.user?.name || "Consultee"}`.
   - [`components/home/UpcomingEventsSection.tsx`](../../components/home/UpcomingEventsSection.tsx) (line 123): `<AvatarImage src={review.consulteeProfile?.user?.image ?? ""} />` — missing `alt={review.consulteeProfile?.user?.name || "Reviewer"}`.
2. **Non-Sequential Heading Hierarchy (`heading-order`, failing in Accessibility [weight 3] on `/`)**:
   - Seven home-page sections jump directly from section `<h2>` to card `<h4>` (skipping `<h3>`):
     - [`components/home/CategoriesSection.tsx`](../../components/home/CategoriesSection.tsx) (`<h4 className="font-semibold text-foreground truncate">`)
     - [`components/home/BenefitsSection.tsx`](../../components/home/BenefitsSection.tsx) (line 61: `<h4 className="font-semibold text-foreground mb-1">`)
     - [`components/home/SuccessStoriesSection.tsx`](../../components/home/SuccessStoriesSection.tsx) (line 35: `<h4 className="font-semibold text-white">`)
     - [`components/home/FeaturedExpertsSection.tsx`](../../components/home/FeaturedExpertsSection.tsx) (line 33: `<h4 className="font-semibold text-foreground truncate">`)
     - [`components/home/PlatformFeaturesSection.tsx`](../../components/home/PlatformFeaturesSection.tsx) (`<h4>` feature titles)
     - [`components/home/UpcomingEventsSection.tsx`](../../components/home/UpcomingEventsSection.tsx) (line 41: `<h4 className="font-semibold text-white mb-2">`)
     - [`components/home/HowItWorksSection.tsx`](../../components/home/HowItWorksSection.tsx) (`<h4>` step titles)
3. **Buttons Without Accessible Names (`button-name`, failing in Accessibility [weight 10] on `/explore/experts`)**:
   - [`app/explore/experts/components/SearchBar.tsx`](../../app/explore/experts/components/SearchBar.tsx) (line 98): `<SelectTrigger>` (`role="combobox"`) for the sort dropdown lacks `aria-label="Sort experts by"`.
   - [`app/explore/experts/components/StickyFilterBar.tsx`](../../app/explore/experts/components/StickyFilterBar.tsx) (line 109): The Filters `<SheetTrigger>` button wraps `<span className="hidden sm:inline">Filters</span>`, leaving an icon-only `<button>` with no accessible text or `aria-label="Filters"` on mobile viewports (`< 640px`).
4. **Insufficient Color Contrast (`color-contrast`, failing in Accessibility [weight 7] on `/explore/experts` and `Footer.tsx`)**:
   - In [`app/globals.css`](../../app/globals.css) (line 18), `--muted-foreground: 0 0% 45%` (`#737373`) paired with `--muted: 0 0% 96%` (`#f5f5f5`) produces a **4.34:1** contrast ratio—just below the WCAG 2.1 AA **4.5:1** threshold for normal/small text (`10px–14px` skill pills, domain badges, and inactive filter tabs in `StickyFilterBar`). Lowering `--muted-foreground` lightness from `45%` to `42%` (`#6b6b6b`) raises the contrast ratio on `--muted` (`#f5f5f5`) to **4.96:1** and on `--background` (`#ffffff`) to **5.43:1**, resolving every `bg-muted text-muted-foreground` contrast failure site-wide.
   - In [`components/Footer.tsx`](../../components/Footer.tsx) (lines 259, 290, 349, 369), `text-zinc-500` (`#71717a` on `#000000` = **4.34:1**) and `text-zinc-600` (`#52525b` on `#000000` = **2.71:1**) fail WCAG AA. Changing those classes to `text-zinc-400` (`#a1a1aa` on `#000000` = **7.93:1**) resolves all footer contrast issues.
5. **Label-Content-Name Mismatch (`label-content-name-mismatch`, diagnostic warning on all routes)**:
   - In [`components/CookieConsent.tsx`](../../components/CookieConsent.tsx) (lines 97–112), `react-cookie-consent` defaults to `aria-label="Accept cookies"` and `aria-label="Decline cookies"`, which conflicts with the visible labels `"Accept all"` and `"Essential only"` (WCAG 2.5.3). Adding `ariaAcceptLabel="Accept all"` and `ariaDeclineLabel="Essential only"` aligns the accessible names with the visible text.

---

## 4. Implemented Optimizations in PR #1973 (P0–P3)

### 4.1 P0: Above-the-Fold LCP, Non-Composited Animations & 100/100 Accessibility/SEO

1. **Converted `HeroSection` to a Pure Server Component & Removed Non-Composited Animations (`components/home/HeroSection.tsx`, `app/globals.css`)**:
   - Removed `"use client"`, `framer-motion` (`motion.*`, `useInView`), and the 60-step `setInterval` counter loop in `<AnimatedNumber>` from [`components/home/HeroSection.tsx`](../../components/home/HeroSection.tsx) so the hero badge, `<h1>`, subheadline `<p>`, CTA buttons, and database-backed stats render immediately in SSR HTML with `opacity: 1` and zero hydration re-renders.
   - Replaced the three `blur-[50px] animate-blob` background orbs in `HeroSection.tsx` with static CSS `radial-gradient(...)` layers (`pointer-events-none`) to eliminate continuous mobile GPU compositing and repaint stalls.
   - Removed `animation: silver-shimmer 4s linear infinite` (`background-position-x`) from `.silver-text` in [`app/globals.css`](../../app/globals.css) to eliminate Lighthouse's `non-composited-animations` penalty on the LCP `<h1>`.
2. **Demoted Below-the-Fold `BenefitsSection` Image from `renderLCPImage` to `renderLazyImage` (`components/home/BenefitsSection.tsx`)**:
   - Replaced `renderLCPImage(images, 0, ...)` with `renderLazyImage(images, 0, ...)` in [`components/home/BenefitsSection.tsx`](../../components/home/BenefitsSection.tsx) so `landing-01.jpg` (`top: ~4,300px`) no longer emits `<link rel="preload" as="image" fetchpriority="high">` in `<head>`.
3. **Resolved All Deterministic Accessibility & SEO Failures (94 → 100 Accessibility, 100 Prod SEO)**:
   - Added descriptive `alt` attributes to `<AvatarImage>` in [`SuccessStoriesSection.tsx`](../../components/home/SuccessStoriesSection.tsx), [`TestimonialsSection.tsx`](../../components/home/TestimonialsSection.tsx), and [`UpcomingEventsSection.tsx`](../../components/home/UpcomingEventsSection.tsx).
   - Fixed heading hierarchy (`<h4> → <h3>`) across [`CategoriesSection.tsx`](../../components/home/CategoriesSection.tsx), [`BenefitsSection.tsx`](../../components/home/BenefitsSection.tsx), [`SuccessStoriesSection.tsx`](../../components/home/SuccessStoriesSection.tsx), [`FeaturedExpertsSection.tsx`](../../components/home/FeaturedExpertsSection.tsx), [`PlatformFeaturesSection.tsx`](../../components/home/PlatformFeaturesSection.tsx), [`TestimonialsSection.tsx`](../../components/home/TestimonialsSection.tsx), [`UpcomingEventsSection.tsx`](../../components/home/UpcomingEventsSection.tsx), and [`HowItWorksSection.tsx`](../../components/home/HowItWorksSection.tsx).
   - Added `aria-label="Sort experts by"` to `<SelectTrigger>` in [`SearchBar.tsx`](../../app/explore/experts/components/SearchBar.tsx) and `aria-label="Filters"` to `<SheetTrigger>` `<Button>` in [`StickyFilterBar.tsx`](../../app/explore/experts/components/StickyFilterBar.tsx).
   - Darkened `--muted-foreground` from `0 0% 45%` to `0 0% 40%` (`#666666`, **5.32:1** contrast ratio on `#f5f5f5`) in [`app/globals.css`](../../app/globals.css) and updated `text-zinc-500` / `text-zinc-600` to `text-zinc-400` in [`components/Footer.tsx`](../../components/Footer.tsx).
   - Added `ariaAcceptLabel="Accept all"` and `ariaDeclineLabel="Essential only"` to `<CookieConsent>` in [`components/CookieConsent.tsx`](../../components/CookieConsent.tsx).

### 4.2 P1: Code-Splitting Sentry Client SDK & Deferring Root-Layout Hydration Storm

1. **Lazy Dynamic Import of `@sentry/nextjs` in `instrumentation-client.ts`**:
   - **Finding**: Simply wrapping `initSentry()` in `requestIdleCallback(..., { timeout: 3000 })` while keeping top-level static `import * as Sentry from "@sentry/nextjs"` and `import { initSentry } from "./sentry.shared.config"` in [`instrumentation-client.ts`](../../instrumentation-client.ts) still bundled **368 KB** (`103.5 KB` gzipped) of Sentry/OpenTelemetry code into initial critical chunk `42384` and fired `initSentry()` at `t = 3.0s`—right in the middle of Lighthouse's simulated 4G hydration window (`TBT = 1,700–2,840 ms`).
   - **Fix**: Removed all static top-level `@sentry/nextjs` imports from [`instrumentation-client.ts`](../../instrumentation-client.ts) and replaced them with `Promise.all([import("./sentry.shared.config"), import("@sentry/nextjs")])` triggered on first user interaction (`pointerdown`, `keydown`, `touchstart`, `scroll` with `{ once: true, passive: true }`) or a `15,000 ms` post-`load` fallback timer for non-automated sessions.
2. **Deferred Non-Critical Root-Layout Client Fetchers (`app/layout.tsx`, `MaintenanceProvider.tsx`, `AnnouncementBar.tsx`, `CookieConsent.tsx`)**:
   - Split `CookieConsentBanner` and `NavigationProgress` out of the critical root-layout bundle in [`app/layout.tsx`](../../app/layout.tsx) via `next/dynamic` (`providers/DeferredGlobalWidgets.tsx`).
   - Deferred `/api/health` ([`MaintenanceProvider.tsx`](../../providers/MaintenanceProvider.tsx)), `/api/announcements/active` ([`AnnouncementBar.tsx`](../../components/AnnouncementBar.tsx)), and `/api/cookie-preferences` ([`CookieConsent.tsx`](../../components/CookieConsent.tsx)) until `3.5–4.5 s` post-mount idle so they never compete with initial hydration or trigger mid-hydration reflows.

### 4.3 P2: Native Lazy `<img>` in `AvatarImage`, Content-Visibility Containment & Remote Image Allowlist

1. **Replaced `@radix-ui/react-avatar` Eager `new window.Image()` Preloader (`components/ui/avatar.tsx`)**:
   - **Finding**: Passing `loading="lazy"` to `@radix-ui/react-avatar`'s `<AvatarPrimitive.Image>` had **zero effect** on network waterfalls because Radix's internal `useImageLoadingStatus` hook executes `const image = new window.Image(); image.src = src;` inside `useLayoutEffect` on mount. That programmatic `new Image()` ignores `<img loading="lazy">` and eagerly downloads all 25+ below-the-fold `1024×1024` (`200–309 KB`) avatars during hydration.
   - **Fix**: Replaced `@radix-ui/react-avatar` in [`components/ui/avatar.tsx`](../../components/ui/avatar.tsx) with a lightweight `AvatarContext` + native `<img loading="lazy" decoding="async">` that renders directly in SSR HTML when `src` is non-empty and falls back to `<AvatarFallback>` only when `src` is empty or `onError` fires.
2. **Restored Missing `images.remotePatterns` Hostnames (`next.config.mjs`)**:
   - Added `cdn.jsdelivr.net`, `picsum.photos`, `fastly.picsum.photos`, `images.unsplash.com`, and `plus.unsplash.com` to `images.remotePatterns` in [`next.config.mjs`](../../next.config.mjs) (resolving the `/_next/image` `400 Bad Request` regression on `/explore/programs` where [`lib/explore/programs.ts`](../../lib/explore/programs.ts) uses `https://picsum.photos/seed/...`).
3. **Below-the-Fold CSS `content-visibility: auto` Containment (`app/globals.css`, `app/page.tsx`) & Marquee Capping (`TestimonialsSection.tsx`)**:
   - Added `.cv-auto { content-visibility: auto; contain-intrinsic-size: auto 600px; }` in [`app/globals.css`](../../app/globals.css) and wrapped all 12 below-the-fold sections in [`app/page.tsx`](../../app/page.tsx) so Chromium skips initial Style, Layout (`3,851 ms`), and Paint (`2,259 ms`) work for off-screen sections (`y = 1,000px..17,000px`).
   - Capped `TestimonialsSection` marquee card duplication in [`components/home/TestimonialsSection.tsx`](../../components/home/TestimonialsSection.tsx) from `9×` (`3× × 3×`) to `2×` per row (`[...reviews, ...reviews]`).

---

## 5. Application-Level & Platform-Level Anti-Runaway Billing Guardrails

To prevent traffic spikes, bot crawls, or deploy-preview tests from causing runaway serverless, database, or observability billing across third-party platforms, the following guardrails are enforced in code (and verified by [`__tests__/performance/lighthouse-cwv-guardrails.test.ts`](../../__tests__/performance/lighthouse-cwv-guardrails.test.ts)):

| Service / Layer                    | Code-Level Guardrail                                                                                                                                                                                                                                                                                                                                                                                             | Platform / Dashboard Spend Control                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Netlify Functions & Edge CDN**   | `preloadEntriesOnStart: false` + `appDocumentPreloading: false` (`next.config.mjs`); ISR `revalidate = 3600` on `/`; `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` on `/api/health` & `/api/announcements/active`; `max-age=3600` on `/api/cookie-preferences`; `public/sw.js` `max-age=0, must-revalidate` (`netlify.toml` & `next.config.mjs`).                                             | Set Netlify Usage & Billing spend notifications at 50% / 75% / 90% of monthly credit allocation; never re-introduce scheduled keep-warm pingers (`keep-warm.mts`). |
| **Sentry (Errors, Traces, Logs)**  | `resolveDefaultTracesSampleRate()` in [`sentry.shared.config.ts`](../../sentry.shared.config.ts) caps default `tracesSampleRate` at **0.1 (10%)** in both `production` and `preview` (override via `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`); Session Replay disabled (`0`); lazy client SDK loading in [`instrumentation-client.ts`](../../instrumentation-client.ts) skips automated Lighthouse/WebDriver bots. | Configure Sentry per-project **Rate Limits** and **Spend Allocations** on Errors, Transactions/Spans, and Structured Logs; enable Spike Protection notifications.  |
| **Supabase (PostgreSQL & Pooler)** | Bounded Prisma pool (`connection_limit=5`, `pool_timeout=10`, `connect_timeout=10`, `statement_timeout=15000ms` in `lib/prisma.ts`); `staticGenerationMaxConcurrency: 2` and `cpus: 1` during Netlify builds (`next.config.mjs`).                                                                                                                                                                                | Enforce Supabase **Spend Caps** ON (`Cost Control`) and route all serverless runtime traffic through the Supavisor Transaction Pooler (`:6543`).                   |
| **Upstash Redis & Rate Limiting**  | Single-pipeline `@upstash/ratelimit` sliding-window limiter with `analytics: false` (saves 1 Redis command per request) and fail-open timeout handling when Redis is unreachable.                                                                                                                                                                                                                                | Enable **Max Monthly Price Limit** (`Budget`) on the Upstash Redis database in the Upstash Console.                                                                |
| **Resend / Stream.io / Novu**      | Transactional outbox + Postgres `SystemJobExecution` lease (`withCronLock`) + idempotency keys prevent duplicate retry storms across email, chat/video token minting, and push notifications.                                                                                                                                                                                                                    | Configure daily/monthly sending quotas in Resend and webhook/event rate alerts in Stream.io and Novu dashboards.                                                   |

---

## 6. Running Lighthouse MCP Audits in Future PRs

### 6.1 Via the `lighthouse` MCP Server in Jetski

Invoke `mcp_lighthouse_run_audit` (or `call_mcp_tool` with `ServerName: "lighthouse"`, `ToolName: "run_audit"`) **sequentially** (one URL at a time, as `lighthouse-mcp` reuses a single headless Chrome instance):

```json
{
  "ServerName": "lighthouse",
  "ToolName": "run_audit",
  "Arguments": {
    "url": "https://deploy-preview-<PR>--familiarise.netlify.app",
    "device": "mobile",
    "throttling": true,
    "categories": ["performance", "accessibility", "best-practices", "seo"]
  }
}
```

### 6.2 Inspecting Detailed Audit Items & Node Selectors via CLI

When investigating specific failing audits (DOM selectors, chunk names, or LCP phase breakdowns), run the Lighthouse CLI directly to output the full JSON report:

```bash
npx lighthouse "https://deploy-preview-<PR>--familiarise.netlify.app/" \
  --output=json \
  --output-path=/tmp/lh-report.json \
  --chrome-flags="--headless --no-sandbox --disable-gpu" \
  --only-categories=performance,accessibility,best-practices,seo \
  --no-enable-error-reporting \
  --quiet
```

When interpreting scores on `deploy-preview-<PR>--familiarise.netlify.app`, always account for the two Netlify deploy-preview injections documented in [Section 2.1](#21-category-scores-summary) (`x-robots-tag: noindex` and `https://app.netlify.com/cdp/`).
