---
name: billing-guardrails
description: Anti-runaway billing and quota guardrails across Netlify, Sentry, Supabase, Upstash Redis, Resend, Stream.io, and Novu
user-invocable: true
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

# Anti-Runaway Billing & Quota Guardrails Skill

You are reviewing, configuring, or modifying code that affects cloud compute, serverless invocations, CDN caching, database connections, rate limiting, or telemetry ingestion across Netlify, Sentry, Supabase, Upstash Redis, Resend, Stream.io, or Novu. Read the relevant docs before editing:

- `docs/performance/05-lighthouse-audit-and-cwv-playbook.md` (Section 5: Application-Level & Platform-Level Anti-Runaway Billing Guardrails)
- `docs/deployment/netlify.md` — Serverless cold-start, ISR, cron consolidation, and function memory/size governance

---

## Mandatory Code-Level Billing Guardrails

### 1. Netlify Functions, ISR & Edge CDN (`next.config.mjs`, `netlify.toml`, `app/api/**`)

- **No Route Preloading on Cold Start**: `experimental.preloadEntriesOnStart: false` and `experimental.appDocumentPreloading: false` in `next.config.mjs` must remain `false`. Turning them `true` causes `NextNodeServer` to eagerly load 606 routes on every cold Lambda container, burning 20–34s of GB-seconds and triggering `504 Inactivity Timeout` OOMs.
- **No Keep-Warm Pinger Crons**: Never re-introduce `netlify/functions/keep-warm.mts` or external synthetic pingers that invoke SSR/API functions every few minutes (~32,400 wasted invocations/month).
- **Public Marketing Pages Must Use ISR (`revalidate = 3600`), Not `force-dynamic`**:
  - `app/page.tsx` and static marketing routes must be served from the Netlify Edge CDN without invoking `___netlify-server-handler` on every visitor.
- **CDN `Cache-Control` on Global Polling Endpoints**:
  - Any unauthenticated endpoint polled by the root layout (`app/layout.tsx`) across all visitors must return `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` so the Netlify CDN absorbs 99%+ of requests:
    - `app/api/health/route.ts` (`s-maxage=60, stale-while-revalidate=300`)
    - `app/api/announcements/active/route.ts` (`s-maxage=60, stale-while-revalidate=300`)
    - `app/api/cookie-preferences/route.ts` (`public, max-age=3600, s-maxage=3600` for anonymous visitors; `private, no-cache` only when `better-auth.session_token` cookie is present)
- **Service Worker Cache Header (`/sw.js`)**:
  - `netlify.toml` and `next.config.mjs` must serve `/sw.js` with `Cache-Control: public, max-age=0, must-revalidate` so browsers always validate service worker updates cleanly.

### 2. Sentry Telemetry Quota Guardrails (`sentry.shared.config.ts`, `instrumentation-client.ts`)

- **Capped Trace Sampling (`resolveDefaultTracesSampleRate`)**:
  - `resolveDefaultTracesSampleRate()` in `sentry.shared.config.ts` caps `tracesSampleRate` at **0.1 (10%)** in both `production` and `preview` (`0.2` in local dev), overridable via `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`. Never set `tracesSampleRate: 1.0` in `production` or `preview`—a single load test or Lighthouse audit loop at `1.0` can exhaust the monthly span quota in minutes.
- **Session Replay Disabled (`0`)**:
  - `replaysSessionSampleRate` and `replaysOnErrorSampleRate` must remain `0` unless explicitly budgeted.
- **Bot & Synthetic Audit Exclusion (`instrumentation-client.ts`)**:
  - `instrumentation-client.ts` loads `@sentry/nextjs` lazily on user interaction and skips the post-load fallback timer when `navigator.webdriver === true` or `/HeadlessChrome|Lighthouse|PTST/i.test(navigator.userAgent)`, preventing synthetic CI/Lighthouse runs from consuming Sentry client quotas.

### 3. Supabase PostgreSQL & Pooler Guardrails (`lib/prisma.ts`, `next.config.mjs`)

- **Bounded Serverless Pool**: Keep `connection_limit=5`, `pool_timeout=10`, `connect_timeout=10`, and `statement_timeout=15000ms` on the Supavisor Transaction Pooler (`:6543`) in `lib/prisma.ts`.
- **Bounded Build-Time Concurrency on Netlify**: Keep `staticGenerationMaxConcurrency: 2`, `cpus: 1`, and `enablePrerenderSourceMaps: false` when `process.env.NETLIFY === "true"` in `next.config.mjs` to prevent build-worker RSS spikes (exit 137) and pooler exhaustion during deploys.
- **Set-Based SQL in Background Jobs**: Scheduled cleanup and reconciliation jobs (`app/api/cleanup/[job]/route.ts`, `scripts/reconcile/reconcile-ledgers.ts`) must use set-based SQL / `GROUP BY` queries and bounded `LIMIT` batches under `withCronLock`, never unbounded `N+1` row loops.

### 4. Upstash Redis Rate-Limiting Guardrails

- Use single-pipeline `@upstash/ratelimit` sliding-window limiters with `analytics: false` (saving 1 extra Redis command per request) and fail-open timeout handling when Redis is unreachable.
- Do not run rate-limit Redis calls on static assets (`/_next/static/*`, `/_next/image/*`, `/favicon.ico`) or CDN-cached health/announcement endpoints.

### 5. Resend, Stream.io & Novu Outbox Guardrails

- Always route outbound emails, notifications, and webhook deliveries through idempotency keys and the Postgres transactional outbox (`NotificationOutbox`, `FailedEmail`, `OutboundWebhookDelivery`) guarded by `SystemJobExecution` leases (`withCronLock`) so transient third-party failures never trigger infinite retry loops.

---

## Platform Dashboard Spend Controls Checklist

When auditing or onboarding environments, verify these platform-level controls:

1. **Netlify**: Usage & Billing spend notifications at 50% / 75% / 90% of monthly credit allocation.
2. **Sentry**: Per-project **Rate Limits** and **Spend Allocations** on Errors, Transactions/Spans, and Structured Logs + Spike Protection enabled.
3. **Supabase**: Organization **Spend Caps** toggled ON (`Cost Control`).
4. **Upstash**: **Max Monthly Price Limit** (`Budget`) configured on the Redis instance.
5. **Resend / Stream.io / Novu**: Daily/monthly sending quotas and webhook rate alerts active.

---

## Verification Command

Always run the automated guardrails unit tests before committing:

```bash
npx jest __tests__/performance/lighthouse-cwv-guardrails.test.ts __tests__/lib/next-config-preload.test.ts
```
