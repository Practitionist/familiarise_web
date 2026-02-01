# Infrastructure & Production Hardening

> **Status:** None of these are implemented yet. All files are audit findings and implementation plans.

Security, monitoring, and scaling work needed before large-scale production deployment.

---

## Security & Hardening

- [01-security-vulnerabilities.md](./01-security-vulnerabilities.md) - Security audit findings
- [03-payment-system.md](./03-payment-system.md) - Payment system hardening plan
- [04-rate-limiting-ddos.md](./04-rate-limiting-ddos.md) - Rate limiting and DDoS protection
- [08-security-arcjet.md](./08-security-arcjet.md) - Arcjet security platform integration

## Database & Performance

- [02-database-performance.md](./02-database-performance.md) - Missing indexes, N+1 queries, optimization plan
- [05-scaling-architecture.md](./05-scaling-architecture.md) - Scaling strategy
- [12-caching-upstash-redis.md](./12-caching-upstash-redis.md) - Distributed caching plan (beyond current locking-only usage)

## Monitoring & Observability

- [09-error-tracking-sentry.md](./09-error-tracking-sentry.md) - Sentry error tracking
- [10-analytics-posthog.md](./10-analytics-posthog.md) - PostHog product analytics
- [13-monitoring-observability.md](./13-monitoring-observability.md) - Logging, uptime, observability stack

## Background Jobs & Infrastructure

- [11-background-jobs-inngest.md](./11-background-jobs-inngest.md) - Inngest migration for background jobs
- [07-infrastructure-overview.md](./07-infrastructure-overview.md) - Infrastructure requirements overview
- [07b-nextjs-scaling-infrastructure.md](./07b-nextjs-scaling-infrastructure.md) - Next.js serverless scaling considerations

## Planning

- [06-implementation-roadmap.md](./06-implementation-roadmap.md) - Prioritized implementation order (Phase 1-5)
- [14-netlify-vs-vercel.md](./14-netlify-vs-vercel.md) - Deployment platform comparison
