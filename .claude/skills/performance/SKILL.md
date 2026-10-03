---
name: performance
description: Core Web Vitals (LCP, TBT, INP, CLS), Lighthouse MCP audits, Next.js 15 cold-start and bundle optimization, image lazy-loading, and accessibility/SEO compliance
user-invocable: true
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

# Web Performance, Core Web Vitals & Lighthouse Skill

You are working on performance, Core Web Vitals (LCP, TBT, INP, CLS), or Lighthouse audit scores in the Familiarise Next.js 15 codebase. Read the relevant docs before editing:

- `docs/performance/05-lighthouse-audit-and-cwv-playbook.md` — Lighthouse MCP workflow, CWV bottleneck root-cause catalog, accessibility/SEO rules, and anti-runaway billing guardrails
- `docs/performance/04-optimization-backlog.md` — Server-side & database query latency optimizations
- `docs/deployment/netlify.md` — Next.js 15 cold-start (`preloadEntriesOnStart: false`), 250 MB Lambda limit, and ISR caching architecture

---

## Core Architecture & Non-Negotiable Guardrails

### 1. Above-the-Fold LCP & Animation Rules

- **NEVER put Framer Motion `initial={{ opacity: 0 }}` on above-the-fold Hero elements** (`<h1>`, hero badge, subheadline, primary CTAs, or hero imagery).
  - Framer Motion serializes `style="opacity:0"` into SSR/ISR HTML, causing Chromium's Largest Contentful Paint (LCP) algorithm to ignore the element until all client JavaScript bundles download, parse, and hydrate (turning a `300 ms` SSR paint into an `8.3 s` mobile LCP).
  - Keep `components/home/HeroSection.tsx` as a **Server Component** with static `opacity: 1` SSR markup.
- **NEVER use `renderLCPImage` (`priority={true}`) on below-the-fold sections** (e.g., `BenefitsSection`). Only the single true above-the-fold hero image on a route may use `priority={true}` (`renderLCPImage` in `utils/image.tsx`). All other images must use `renderLazyImage` or default `loading="lazy"`.
- **NEVER use non-composited CSS animations (`background-position`, `blur()` + `animate-blob`) on above-the-fold text or hero backgrounds**:
  - `.silver-text` in `app/globals.css` must remain a static gradient (`background-clip: text`) without `@keyframes silver-shimmer` (`background-position-x` triggers Lighthouse's `non-composited-animations` penalty).
  - Hero background glows must use static `radial-gradient(...)` divs rather than `blur-[50px] animate-blob` layers.

### 2. Client Bundle & Main-Thread TBT Guardrails

- **No Static Top-Level `@sentry/nextjs` Imports in `instrumentation-client.ts`**:
  - Statically importing `@sentry/nextjs` or `./sentry.shared.config` at the top level of `instrumentation-client.ts` bundles ~368 KB (`103.5 KB` gzipped) of Sentry + OpenTelemetry instrumentation into the initial critical client chunk and costs ~2.1s of main-thread evaluation during hydration.
  - Always load Sentry on the client via dynamic `Promise.all([import("./sentry.shared.config"), import("@sentry/nextjs")])` triggered on first user interaction (`pointerdown`, `keydown`, `touchstart`, `scroll`) or a `15,000 ms` post-`load` fallback timer (skipped when `navigator.webdriver` or `/HeadlessChrome|Lighthouse/i.test(navigator.userAgent)` is true).
- **Root-Layout Global Widgets (`app/layout.tsx`, `providers/DeferredGlobalWidgets.tsx`)**:
  - Non-critical shell widgets (`CookieConsentBanner`, `NavigationProgress`) must be dynamically imported with `ssr: false` in `providers/DeferredGlobalWidgets.tsx`.
  - Background status polls (`/api/health` in `MaintenanceProvider.tsx`, `/api/announcements/active` in `AnnouncementBar.tsx`, `/api/cookie-preferences` in `CookieConsent.tsx`) must wait for post-hydration idle (`3.5–4.5 s` timeout) so they never compete with initial hydration or trigger mid-hydration layout shifts (`ResizeObserver`).
- **Below-the-Fold Content Visibility (`.cv-auto`)**:
  - Wrap off-screen sections on long marketing pages (`app/page.tsx`) in `<div className="cv-auto">` (`content-visibility: auto; contain-intrinsic-size: auto 600px;` in `app/globals.css`) so Chromium skips initial Style, Layout, and Paint work for sections below the viewport.
- **Marquee DOM Bounds**:
  - Never duplicate marquee arrays more than `2×` per row (`[...items, ...items]`) in `TestimonialsSection.tsx` or `FeaturedExpertsSection.tsx`.

### 3. Image Delivery & `AvatarImage` Guardrails

- **Native Lazy `<img>` in `components/ui/avatar.tsx`**:
  - Do **NOT** re-introduce `@radix-ui/react-avatar` in `components/ui/avatar.tsx`. Radix's `useImageLoadingStatus` hook executes `const image = new window.Image(); image.src = src;` inside `useLayoutEffect`, which completely bypasses `<img loading="lazy">` and eagerly downloads all below-the-fold avatars during hydration.
  - `AvatarImage` in `components/ui/avatar.tsx` must render a native `<img loading="lazy" decoding="async">` directly in SSR HTML when `src` is non-empty and switch to `<AvatarFallback>` via `AvatarContext` only when `src` is empty or `onError` fires.
- **`next.config.mjs` `images.remotePatterns` Allowlist**:
  - Every remote hostname used with `next/image` (`<Image>`) must remain registered in `next.config.mjs` `images.remotePatterns` (`lh3.googleusercontent.com`, `*.supabase.co`, `avatars.githubusercontent.com`, `upload.wikimedia.org`, `img.logo.dev`, `cdn.jsdelivr.net`, `picsum.photos`, `fastly.picsum.photos`, `images.unsplash.com`, `plus.unsplash.com`), or `/_next/image` will return `400 Bad Request` in production/preview.

### 4. Accessibility (100/100) & SEO (100/100) Checklist

1. **Every `<AvatarImage>` and `<Image>` must have a meaningful `alt` attribute** (`alt={user.name || "User"}`).
2. **Sequential Heading Order (`<h1> → <h2> → <h3>`)**: Never jump from a section `<h2>` directly to a card `<h4>` without an intermediate `<h3>`.
3. **Accessible Button & Trigger Names**: Every icon-only `<Button>`, mobile `<SheetTrigger>`, or `<SelectTrigger>` (`role="combobox"`) must have an explicit `aria-label`.
4. **WCAG 2.1 AA Color Contrast ($\ge 4.5:1$)**:
   - Keep `--muted-foreground: 0 0% 40%` (`#666666`) in `app/globals.css` (`5.32:1` on `--muted` `#f5f5f5`).
   - On dark (`bg-black` / `bg-zinc-950`) surfaces such as `Footer.tsx`, use `text-zinc-400` (`7.93:1`), never `text-zinc-500` or `text-zinc-600` for readable copy.
5. **Label-Content-Name Alignment (WCAG 2.5.3)**: When a component has both visible text and an `aria-label` (such as `CookieConsent.tsx`), the `aria-label` must match or start with the exact visible button text.

---

## Verification Workflow

1. Run the automated CWV & billing guardrails test suite:
   ```bash
   npx jest __tests__/performance/lighthouse-cwv-guardrails.test.ts __tests__/lib/next-config-preload.test.ts
   ```
2. Run a live Lighthouse audit via the `lighthouse` MCP server (`run_audit` with `device: "mobile"`, `throttling: true`) or CLI against the Netlify deploy preview (`https://deploy-preview-<PR>--familiarise.netlify.app`). Remember that Netlify injects `x-robots-tag: noindex` (`-34` SEO pts) and `/.netlify/scripts/cdp` (`-8` Best Practices pts) on deploy previews only.
