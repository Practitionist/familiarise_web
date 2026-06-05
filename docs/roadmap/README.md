# Roadmap — Planned & Future Work

> All documentation for features, integrations, and improvements that are **not yet implemented**.

---

## Table of Contents

- [Auth Migration](#auth-migration)
- [Enterprise B2B Tier](#enterprise-b2b-tier)
- [Infrastructure & Production Hardening](#infrastructure--production-hardening)
- [Content Strategy (CMS, Blog, Community)](#content-strategy-cms-blog-community)
- [Navigation](#navigation)
- [Planned Features](#planned-features)
- [Performance Improvements](#performance-improvements)
- [Schema Changes](#schema-changes)

---

## Auth Migration

BetterAuth migration from NextAuth (Auth.js now in maintenance mode).

- [auth/betterauth-migration.md](./auth/betterauth-migration.md) - Full comparison, migration steps, enterprise plugin details

---

## Enterprise B2B Tier

Organization management, SSO, team seats, recording library, org billing. The roadmap-local enterprise notes were superseded by the shipped subsystem; the maintained documentation now lives in the banded tree.

- [../enterprise/README.md](../enterprise/README.md) - The enterprise documentation index, with band map and SDE reading paths

---

## Infrastructure & Production Hardening

Security, monitoring, and scaling audit documents. **None of these are implemented yet.**

- [infrastructure/README.md](./infrastructure/README.md) - **Full index with categorized links**
- [infrastructure/01-security-vulnerabilities.md](./infrastructure/01-security-vulnerabilities.md) - Security audit findings
- [infrastructure/02-database-performance.md](./infrastructure/02-database-performance.md) - Database optimization plan
- [infrastructure/03-payment-system.md](./infrastructure/03-payment-system.md) - Payment hardening plan
- [infrastructure/04-rate-limiting-ddos.md](./infrastructure/04-rate-limiting-ddos.md) - Rate limiting plan
- [infrastructure/05-scaling-architecture.md](./infrastructure/05-scaling-architecture.md) - Scaling strategy
- [infrastructure/06-implementation-roadmap.md](./infrastructure/06-implementation-roadmap.md) - Implementation order
- [infrastructure/07-infrastructure-overview.md](./infrastructure/07-infrastructure-overview.md) - Infrastructure requirements
- [infrastructure/07b-nextjs-scaling-infrastructure.md](./infrastructure/07b-nextjs-scaling-infrastructure.md) - Next.js scaling
- [infrastructure/08-security-arcjet.md](./infrastructure/08-security-arcjet.md) - Arcjet integration plan
- [infrastructure/09-error-tracking-sentry.md](./infrastructure/09-error-tracking-sentry.md) - Sentry integration plan
- [infrastructure/10-analytics-posthog.md](./infrastructure/10-analytics-posthog.md) - PostHog integration plan
- [infrastructure/11-background-jobs-inngest.md](./infrastructure/11-background-jobs-inngest.md) - Inngest migration plan
- [infrastructure/12-caching-upstash-redis.md](./infrastructure/12-caching-upstash-redis.md) - Distributed caching plan
- [infrastructure/13-monitoring-observability.md](./infrastructure/13-monitoring-observability.md) - Monitoring stack plan
- [infrastructure/14-netlify-vs-vercel.md](./infrastructure/14-netlify-vs-vercel.md) - Deployment platform comparison

---

## Content Strategy (CMS, Blog, Community)

> **Note**: The notification system (Resend + Novu) has been implemented and moved to [docs/notifications/](../notifications/README.md). The service integration architecture for Directus, ConvertKit, and Enterprise features remains in the content strategy section below.

Directus CMS, ConvertKit newsletter, blog and gated community decisions.

- [content-strategy/README.md](./content-strategy/README.md) - Content strategy overview and decisions
- [content-strategy/01-directus-cms-setup.md](./content-strategy/01-directus-cms-setup.md) - Directus setup and database isolation
- [content-strategy/02-blog-and-community.md](./content-strategy/02-blog-and-community.md) - Blog and community research
- [content-strategy/03-convertkit-newsletter.md](./content-strategy/03-convertkit-newsletter.md) - ConvertKit newsletter integration

---

## Navigation

Mega-menu design with competitor analysis and coming-soon strategy.

- [navigation/README.md](./navigation/README.md) - Full mega-menu structure, competitor nav analysis

---

## Planned Features

Individual features in design or proposal phase.

> Waitlist, messaging, and document review were previously listed here but are now fully implemented. See [docs/stream/](../stream/) for messaging, and the main [docs/README.md](../README.md) for other implemented systems.

- [features/ai-summaries/README.md](./features/ai-summaries/README.md) - AI meeting summaries
- [features/analytics-dashboard/README.md](./features/analytics-dashboard/README.md) - Analytics dashboard
- [features/booking-widget/README.md](./features/booking-widget/README.md) - Embeddable booking widget
- [features/buffer-times/README.md](./features/buffer-times/README.md) - Buffer times between appointments
- [features/calendar-sync/README.md](./features/calendar-sync/README.md) - Calendar sync (Google, Outlook)
- [features/collaborators/implementation.md](./features/collaborators/implementation.md) - Webinar/class collaborators
- [features/collaborators/podcast-schema-integration.md](./features/collaborators/podcast-schema-integration.md) - Podcast schema
- [features/consultant-badges/README.md](./features/consultant-badges/README.md) - Achievement badges
- [features/gift-consultations/README.md](./features/gift-consultations/README.md) - Gift consultation purchases
- [features/live-qa-sessions/README.md](./features/live-qa-sessions/README.md) - Live Q&A sessions
- [features/notification-channels/README.md](./features/notification-channels/README.md) - SMS/WhatsApp notifications (email/in-app already working)
- [features/package-bundles/README.md](./features/package-bundles/README.md) - Consultation bundles
- [features/referral-program/README.md](./features/referral-program/README.md) - Referral system
- [features/smart-matching/README.md](./features/smart-matching/README.md) - AI matching engine
- [features/video-intro/README.md](./features/video-intro/README.md) - Consultant video intros

---

## Performance Improvements

Planned performance optimizations and scaling strategies.

- [performance/migration-guide.md](./performance/migration-guide.md) - Zero-downtime migration patterns
- [performance/realtime-caching-strategy.md](./performance/realtime-caching-strategy.md) - Real-time caching architecture
- [performance/scaling-roadmap.md](./performance/scaling-roadmap.md) - Scaling roadmap

---

## Schema Changes

Planned database schema modifications.

- [schema/user-schema-enhancement-plan.md](./schema/user-schema-enhancement-plan.md) - User schema enhancement plan
