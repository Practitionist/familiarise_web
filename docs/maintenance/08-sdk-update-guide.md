# SDK & Package Update Guide

For every major dependency, this document covers: current version, what it's used for, update policy, testing requirements, and whether maintenance mode is needed.

## Update Risk Levels

| Level | Meaning | Maintenance? |
|-------|---------|-------------|
| **Safe** | No breaking changes expected, minimal testing | No |
| **Needs Testing** | Potential behavioral changes, test before deploying | DEGRADED |
| **Needs Maintenance** | Breaking changes likely, DB migration possible | OFFLINE |

---

## Core Framework

### Next.js

| Field | Value |
|-------|-------|
| **Current Version** | ^15.3.8 |
| **Used For** | Framework: middleware, API routes, SSR, static generation, routing |
| **Key Files** | `middleware.ts`, all `app/` routes, `next.config.js` |
| **Minor Update** | Needs Testing -- middleware behavior changes can affect maintenance mode |
| **Major Update** | Needs Maintenance -- breaking changes to App Router, middleware API, or API routes |
| **How to Test** | 1. Run `npm run build` 2. Test middleware (auth, maintenance checks) 3. Test API routes (checkout, webhooks) 4. Test SSR pages |
| **Breaking Changes to Watch** | Middleware API changes, `cookies()` / `headers()` API, App Router changes, `route.ts` handler signatures |
| **Estimated Time** | Minor: 1-2 hours. Major: 4-8 hours. |

### React

| Field | Value |
|-------|-------|
| **Current Version** | ^18.3.1 |
| **Used For** | UI library for all components |
| **Key Files** | All `.tsx` files in `app/` and `components/` |
| **Minor Update** | Safe -- patch updates within React 18 |
| **Major Update** | Needs Maintenance -- React 19 has significant changes (use client directive behavior, hooks, Suspense) |
| **How to Test** | 1. Run `npm run build` 2. Test interactive components (forms, modals, tabs) 3. Test Stream.io video/chat components |
| **Breaking Changes to Watch** | React 19: `use()` hook, new JSX transform, Server Components changes, ref behavior |
| **Estimated Time** | Minor: 30 min. Major: 8-16 hours (React 19 migration). |

### TypeScript

| Field | Value |
|-------|-------|
| **Current Version** | ^5.9.3 (devDependency) |
| **Used For** | Type checking across the entire codebase |
| **Key Files** | `tsconfig.json`, all `.ts`/`.tsx` files |
| **Minor Update** | Safe |
| **Major Update** | Needs Testing -- new type checking rules may surface existing issues |
| **How to Test** | 1. Run `npx tsc --noEmit` 2. Fix any new type errors 3. Run `npm run build` |
| **Estimated Time** | Minor: 15 min. Major: 2-4 hours. |

---

## Database & ORM

### Prisma (Client + CLI)

| Field | Value |
|-------|-------|
| **Current Version** | ^7.3.0 (`@prisma/client` + `prisma` devDependency) |
| **Used For** | ORM for 60+ models, migrations, query building. Used by every API route and all 27 cron jobs. |
| **Key Files** | `prisma/schema.prisma`, `lib/prisma.ts`, all API routes, all jobs in `jobs/` |
| **Minor Update** | Needs Testing -- query behavior or generated client changes |
| **Major Update** | **Needs Maintenance (OFFLINE)** -- major versions change query API, migration format, generated types |
| **How to Test** | 1. `npx prisma generate` 2. `npx tsc --noEmit` 3. Run `npm run build` 4. Test checkout flow end-to-end 5. Run reconciliation jobs locally |
| **Breaking Changes to Watch** | Query API changes, `findMany`/`findUnique` behavior, relation loading, transaction API, migration engine changes |
| **Special Notes** | Also uses `@prisma/adapter-pg` (^7.3.0) for pg driver adapter. Update both together. |
| **Estimated Time** | Minor: 1-2 hours. Major: 8-16 hours. |

### PostgreSQL Driver (pg)

| Field | Value |
|-------|-------|
| **Current Version** | ^8.17.2 |
| **Used For** | Low-level PostgreSQL driver used by Prisma adapter |
| **Key Files** | `lib/prisma.ts` (via `@prisma/adapter-pg`) |
| **Minor Update** | Safe |
| **Major Update** | Needs Testing -- connection handling changes |
| **How to Test** | 1. Run `npm run build` 2. Test DB connectivity 3. Run a few API routes |
| **Estimated Time** | Minor: 15 min. Major: 1-2 hours. |

---

## Authentication & Session

### BetterAuth

| Field | Value |
|-------|-------|
| **Current Version** | ^1.4.18 |
| **Used For** | Authentication, sessions, social login (Google, GitHub), email/password |
| **Key Files** | `lib/auth.ts`, `lib/auth-client.ts`, `app/api/auth/[...all]/route.ts`, middleware auth checks |
| **Minor Update** | Needs Testing -- session handling or token format changes can break all authenticated routes |
| **Major Update** | **Needs Maintenance (OFFLINE)** -- auth table schema changes may require migration |
| **How to Test** | 1. Test login (email + social) 2. Test session persistence 3. Test logout 4. Test protected API routes 5. Test middleware auth checks |
| **Breaking Changes to Watch** | Session schema, JWT format, social provider config, middleware integration |
| **Estimated Time** | Minor: 1-2 hours. Major: 4-8 hours. |

---

## Payment Gateways

### Stripe

| Field | Value |
|-------|-------|
| **Current Version** | ^20.2.0 (server) + ^8.6.4 (`@stripe/stripe-js` client) |
| **Used For** | Payment intents, webhook handling, Connect payouts, refunds, disputes |
| **Key Files** | `lib/stripe.ts`, `app/api/checkout/route.ts`, `app/api/webhooks/stripe/route.ts`, payout jobs |
| **Minor Update** | Needs Testing -- API version changes can affect webhook payload format |
| **Major Update** | **Needs Testing** -- Stripe SDK major versions change API surface |
| **How to Test** | 1. Test checkout flow (create payment intent) 2. Test webhook signature verification 3. Test refund flow 4. Run payout reconciliation job |
| **Breaking Changes to Watch** | Default API version, webhook event format, PaymentIntent API changes, Connect API changes |
| **Special Notes** | Stripe SDK versions pin an API version. Updating may change default API version. |
| **Estimated Time** | Minor: 1-2 hours. Major: 4-8 hours. |

### Razorpay

| Field | Value |
|-------|-------|
| **Current Version** | ^2.9.6 |
| **Used For** | Payment orders, webhook handling, RazorpayX payouts |
| **Key Files** | `lib/razorpay.ts`, `app/api/checkout/route.ts`, `app/api/webhooks/razorpay/route.ts`, payout jobs |
| **Minor Update** | Needs Testing -- API changes can affect order creation or webhook format |
| **Major Update** | Needs Testing -- limited breaking changes historically |
| **How to Test** | 1. Test checkout (create order) 2. Test webhook signature verification 3. Test payout processing |
| **Breaking Changes to Watch** | Order API, webhook signature format, RazorpayX API changes |
| **Estimated Time** | Minor: 1 hour. Major: 2-4 hours. |

---

## Stream.io (Video + Chat)

### Stream Chat SDK

| Field | Value |
|-------|-------|
| **Current Version** | ^9.30.1 (`stream-chat`) + ^13.13.4 (`stream-chat-react`) |
| **Used For** | Chat channels, message sync, user management, chat UI components |
| **Key Files** | `lib/stream.ts`, chat components in dashboard, `stream-chat-react` UI |
| **Minor Update** | Needs Testing -- chat behavior or component API changes |
| **Major Update** | **Needs Testing** -- React component API changes, event handling |
| **How to Test** | 1. Test chat in a consultation 2. Test channel creation 3. Test message sending/receiving 4. Test user token generation |
| **Breaking Changes to Watch** | Channel API, event handlers, React component props, authentication |
| **Estimated Time** | Minor: 1-2 hours. Major: 4-8 hours. |

### Stream Video SDK

| Field | Value |
|-------|-------|
| **Current Version** | ^1.31.5 (`@stream-io/video-react-sdk`) |
| **Used For** | Video calls, recording, screen sharing in consultations |
| **Key Files** | Video call components in meeting pages, `lib/stream.ts` |
| **Minor Update** | Needs Testing -- video call behavior is critical |
| **Major Update** | **Needs Testing** -- component API changes, call handling |
| **How to Test** | 1. Test starting a video call 2. Test screen sharing 3. Test recording 4. Test call end handling |
| **Breaking Changes to Watch** | Call API, React hook changes, recording API, participant management |
| **Estimated Time** | Minor: 1-2 hours. Major: 4-8 hours. |

### Stream Node SDK

| Field | Value |
|-------|-------|
| **Current Version** | ^0.7.36 (`@stream-io/node-sdk`) |
| **Used For** | Server-side token generation, user creation/deletion, admin operations |
| **Key Files** | `lib/stream.ts`, `jobs/stream/stream-sync.ts` |
| **Minor Update** | Needs Testing -- token format or user API changes |
| **Major Update** | **Needs Testing** -- 0.x to 1.x may have significant changes |
| **How to Test** | 1. Test user token generation 2. Test user creation 3. Run Stream sync job |
| **Breaking Changes to Watch** | Token generation, user CRUD API, server-client initialization |
| **Estimated Time** | Minor: 30 min. Major: 2-4 hours. |

---

## Storage

### Supabase JS + Storage JS

| Field | Value |
|-------|-------|
| **Current Version** | ^2.93.1 (`@supabase/supabase-js` + `@supabase/storage-js`) |
| **Used For** | File storage: documents, profile images, support attachments |
| **Key Files** | `lib/supabase.ts`, document upload/download routes, storage reconciliation job |
| **Minor Update** | Safe -- storage API is stable |
| **Major Update** | Needs Testing -- storage bucket API or auth changes |
| **How to Test** | 1. Test file upload 2. Test file download 3. Test signed URL generation 4. Run document reconciliation job |
| **Breaking Changes to Watch** | Storage API, bucket policies, signed URL format |
| **Estimated Time** | Minor: 30 min. Major: 2-4 hours. |

---

## Redis & Rate Limiting

### Upstash Redis

| Field | Value |
|-------|-------|
| **Current Version** | ^1.36.1 (`@upstash/redis`) |
| **Used For** | Distributed locking, rate limiting, **maintenance state storage** |
| **Key Files** | `lib/redis.ts`, `lib/maintenance.ts`, `lib/maintenance-edge.ts` (direct REST calls) |
| **Minor Update** | Needs Testing -- Redis client changes can affect maintenance mode |
| **Major Update** | **Needs Testing** -- API changes affect critical maintenance functionality |
| **How to Test** | 1. Test maintenance mode toggle 2. Test rate limiting 3. Test distributed locks 4. Verify maintenance-edge.ts (uses direct REST, not SDK) |
| **Special Notes** | `lib/maintenance-edge.ts` uses direct `fetch()` to Upstash REST API, NOT the SDK. SDK updates don't affect edge runtime code. |
| **Estimated Time** | Minor: 30 min. Major: 1-2 hours. |

### Upstash Ratelimit

| Field | Value |
|-------|-------|
| **Current Version** | ^2.0.8 (`@upstash/ratelimit`) |
| **Used For** | API rate limiting for public and authenticated routes |
| **Key Files** | Rate limiting middleware/utilities |
| **Minor Update** | Safe |
| **Major Update** | Needs Testing -- algorithm or configuration changes |
| **How to Test** | 1. Test rate-limited API endpoints 2. Verify rate limit headers in responses |
| **Estimated Time** | Minor: 15 min. Major: 1 hour. |

---

## Notifications

### Novu

| Field | Value |
|-------|-------|
| **Current Version** | ^3.13.0 (`@novu/api`, `@novu/nextjs`, `@novu/react`) |
| **Used For** | Notification workflows: email, in-app, push notifications |
| **Key Files** | `lib/novu.ts`, Novu provider setup, notification components |
| **Minor Update** | Needs Testing -- notification delivery changes |
| **Major Update** | Needs Testing -- API or React component changes |
| **How to Test** | 1. Trigger a test notification 2. Check in-app notification bell 3. Verify email delivery |
| **Breaking Changes to Watch** | Workflow API, subscriber API, React component changes |
| **Estimated Time** | Minor: 30 min. Major: 2-4 hours. |

### Resend

| Field | Value |
|-------|-------|
| **Current Version** | ^6.8.0 |
| **Used For** | Email sending (transactional emails) |
| **Key Files** | `lib/email.ts`, email templates in `@react-email/` |
| **Minor Update** | Safe |
| **Major Update** | Needs Testing -- send API changes |
| **How to Test** | 1. Send a test email 2. Verify delivery |
| **Estimated Time** | Minor: 15 min. Major: 1 hour. |

---

## Data Fetching & State

### TanStack React Query

| Field | Value |
|-------|-------|
| **Current Version** | ^5.90.20 (`@tanstack/react-query`) |
| **Used For** | Client-side data fetching, caching, cache invalidation |
| **Key Files** | Query hooks throughout dashboard components |
| **Minor Update** | Safe |
| **Major Update** | Needs Testing -- cache behavior or hook API changes |
| **How to Test** | 1. Test dashboard data loading 2. Test cache invalidation after mutations 3. Test error states |
| **Breaking Changes to Watch** | `useQuery` / `useMutation` API, cache configuration, devtools |
| **Estimated Time** | Minor: 15 min. Major: 2-4 hours. |

### Axios

| Field | Value |
|-------|-------|
| **Current Version** | ^1.13.3 |
| **Used For** | HTTP client for external API calls |
| **Key Files** | Various API integration files |
| **Minor Update** | Safe |
| **Major Update** | Needs Testing -- request/response interceptor changes |
| **Estimated Time** | Minor: 15 min. Major: 1-2 hours. |

---

## UI Libraries

### Radix UI

| Field | Value |
|-------|-------|
| **Current Version** | Various (^1.x - ^2.x across 20 packages) |
| **Used For** | Accessible component primitives: dialogs, dropdowns, tabs, tooltips, etc. |
| **Key Packages** | `@radix-ui/react-dialog` (^1.1.15), `@radix-ui/react-dropdown-menu` (^2.1.16), `@radix-ui/react-select` (^2.2.6), `@radix-ui/react-tabs` (^1.1.13), `@radix-ui/react-toast` (^1.2.15), and 15 others |
| **Minor Update** | Safe -- Radix patches are generally backward compatible |
| **Major Update** | Needs Testing -- component API changes, accessibility improvements |
| **How to Test** | 1. Visual regression: check dialogs, dropdowns, selects 2. Test keyboard navigation 3. Test mobile responsiveness |
| **Estimated Time** | Minor: 15 min (update all together). Major: 2-4 hours per package. |

### Framer Motion

| Field | Value |
|-------|-------|
| **Current Version** | ^11.15.0 |
| **Used For** | Animations throughout the UI |
| **Key Files** | Components using `motion.*` elements, page transitions |
| **Minor Update** | Safe |
| **Major Update** | Needs Testing -- animation API changes, React compatibility |
| **How to Test** | 1. Check page transitions 2. Check component animations 3. Verify no layout shifts |
| **Estimated Time** | Minor: 15 min. Major: 2-4 hours. |

### TailwindCSS

| Field | Value |
|-------|-------|
| **Current Version** | ^3.4.17 (devDependency) |
| **Used For** | Utility-first CSS styling across all components |
| **Key Files** | `tailwind.config.ts`, `app/globals.css`, all component files |
| **Minor Update** | Safe |
| **Major Update** | **Needs Maintenance (DEGRADED)** -- Tailwind v4 has significant config and class changes |
| **How to Test** | 1. Visual regression across key pages 2. Check responsive design 3. Check dark mode (if applicable) |
| **Breaking Changes to Watch** | Tailwind v4: new config format, removed utilities, PostCSS changes |
| **Estimated Time** | Minor: 15 min. Major: 8-16 hours (v3 to v4). |

---

## Forms & Validation

### React Hook Form + Zod

| Field | Value |
|-------|-------|
| **Current Version** | ^7.71.1 (`react-hook-form`), ^5.2.2 (`@hookform/resolvers`), ^3.25.67 (`zod`) |
| **Used For** | Form state management, validation schemas |
| **Key Files** | All form components, validation schemas in `schemas/` |
| **Minor Update** | Safe |
| **Major Update** | Needs Testing -- form registration or validation API changes |
| **How to Test** | 1. Test form submission (checkout, onboarding, event creation) 2. Test validation errors 3. Test form reset |
| **Estimated Time** | Minor: 15 min. Major: 2-4 hours. |

---

## Bulk Update Strategy

For routine dependency updates:

1. **Low-risk batch** (no maintenance needed): Radix UI patches, Framer Motion patches, utility packages (clsx, date-fns, lucide-react)
2. **Medium-risk batch** (DEGRADED mode): TanStack Query minor, Novu minor, Resend minor
3. **High-risk individual** (OFFLINE mode): Prisma major, Next.js major, BetterAuth major, React major

**Update command**:
```bash
# Check for outdated packages
npm outdated

# Update all patch versions (safest)
npm update

# Update specific package
npm install package-name@latest
```

**Always after updating**:
1. `npx prisma generate` (if Prisma was updated)
2. `npm run build` (catch compile errors)
3. `npm test` (run test suite)
4. Test critical flows: checkout, auth, video calls
