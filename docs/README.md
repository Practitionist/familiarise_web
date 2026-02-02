# Documentation Index

This documentation is organized into logical categories for easy navigation.

## File Naming Convention

All documentation files follow the `lowercase-with-hyphens.md` naming convention.

---

## Implemented Systems

Documentation for working, production-ready systems.

### Architecture

- [distributed-systems-explained.md](./architecture/distributed-systems-explained.md) - Redis distributed locking and caching implementation

---

### Booking

Booking system, slot allocation, validation, and scheduling logic.

- [README.md](./booking/README.md) - System overview, source code map, navigation hub
- [01-architecture.md](./booking/01-architecture.md) - Services, data model, data flows, tentative lifecycle
- [02-event-types-and-validation.md](./booking/02-event-types-and-validation.md) - 4 event types, rules, 3 validation layers
- [03-slot-math-and-calculations.md](./booking/03-slot-math-and-calculations.md) - 30-min slots, week counting, consecutive validation
- [04-api-reference.md](./booking/04-api-reference.md) - 8 endpoints, Zod schemas, error codes
- [05-troubleshooting-and-changelog.md](./booking/05-troubleshooting-and-changelog.md) - Common errors, debugging, recent fixes

---

### Calendar

Calendar display, synchronization, and UI components.

- [display-analysis.md](./calendar/display-analysis.md) - Calendar display analysis
- [synchronization-refactor.md](./calendar/synchronization-refactor.md) - Calendar sync refactoring
- [responsive-appointments-system.md](./calendar/responsive-appointments-system.md) - Responsive design
- [visual-changes-summary.md](./calendar/visual-changes-summary.md) - Visual changes overview

---

### Payments

Payment system, checkout flows, and gateway integrations.

- [setup.md](./payments/setup.md) - Payment system setup
- [architecture.md](./payments/architecture.md) - Payment architecture
- [abandoned-solutions.md](./payments/abandoned-solutions.md) - Abandoned payment handling
- [STATUS_ENUMS_REFERENCE.md](./payments/STATUS_ENUMS_REFERENCE.md) - Status enums reference

#### Checkout Flow

- [checkout-flow/01-checkout-flow.md](./payments/checkout-flow/01-checkout-flow.md)
- [checkout-flow/02-checkout-flow.md](./payments/checkout-flow/02-checkout-flow.md)
- [checkout-flow/03-checkout-flow.md](./payments/checkout-flow/03-checkout-flow.md)
- [checkout-flow/04-checkout-flow.md](./payments/checkout-flow/04-checkout-flow.md)
- [checkout-flow/05-checkout-flow.md](./payments/checkout-flow/05-checkout-flow.md)
- [checkout-flow/06-status-flows.md](./payments/checkout-flow/06-status-flows.md)
- [checkout-flow/KNOWN_ISSUES_AND_FIXES.md](./payments/checkout-flow/KNOWN_ISSUES_AND_FIXES.md)

#### Gateways — Razorpay

- [gateways/razorpay/01-setup.md](./payments/gateways/razorpay/01-setup.md) - Setup
- [gateways/razorpay/02-architecture-and-flow.md](./payments/gateways/razorpay/02-architecture-and-flow.md) - Architecture
- [gateways/razorpay/03-payout-flow.md](./payments/gateways/razorpay/03-payout-flow.md) - Payouts
- [gateways/razorpay/kyc/01-kyc-overview.md](./payments/gateways/razorpay/kyc/01-kyc-overview.md) - KYC overview
- [gateways/razorpay/kyc/02-business-types-requirements.md](./payments/gateways/razorpay/kyc/02-business-types-requirements.md) - Business requirements
- [gateways/razorpay/kyc/03-industry-certifications.md](./payments/gateways/razorpay/kyc/03-industry-certifications.md) - Industry certifications
- [gateways/razorpay/kyc/04-setup-checklist.md](./payments/gateways/razorpay/kyc/04-setup-checklist.md) - Setup checklist

#### Gateways — Stripe

- [gateways/stripe/01-setup.md](./payments/gateways/stripe/01-setup.md) - Setup
- [gateways/stripe/02-architecture-and-flow.md](./payments/gateways/stripe/02-architecture-and-flow.md) - Architecture
- [gateways/stripe/03-payout-flow.md](./payments/gateways/stripe/03-payout-flow.md) - Payouts

#### Pay Later

- [pay-later/README.md](./payments/pay-later/README.md) - Pay later overview
- [pay-later/ARCHITECTURE.md](./payments/pay-later/ARCHITECTURE.md) - Architecture
- [pay-later/API_REFERENCE.md](./payments/pay-later/API_REFERENCE.md) - API reference
- [pay-later/CRON_SCHEDULES.md](./payments/pay-later/CRON_SCHEDULES.md) - Cron schedules
- [pay-later/DISTRIBUTED_LOCKING.md](./payments/pay-later/DISTRIBUTED_LOCKING.md) - Distributed locking
- [pay-later/EMAIL_NOTIFICATIONS.md](./payments/pay-later/EMAIL_NOTIFICATIONS.md) - Email notifications
- [pay-later/TESTING.md](./payments/pay-later/TESTING.md) - Testing guide
- [pay-later/TROUBLESHOOTING.md](./payments/pay-later/TROUBLESHOOTING.md) - Troubleshooting

#### Payouts

- [payouts/razorpay-payouts-code.md](./payments/payouts/razorpay-payouts-code.md) - Razorpay payouts code
- [payouts/stripe-payouts-code.md](./payments/payouts/stripe-payouts-code.md) - Stripe payouts code

#### Refunds & Disputes

- [refunds-disputes/README.md](./payments/refunds-disputes/README.md) - Overview
- [refunds-disputes/01-architecture.md](./payments/refunds-disputes/01-architecture.md) - Architecture
- [refunds-disputes/02-refund-flow.md](./payments/refunds-disputes/02-refund-flow.md) - Refund flow
- [refunds-disputes/03-dispute-flow.md](./payments/refunds-disputes/03-dispute-flow.md) - Dispute flow
- [refunds-disputes/04-api-reference.md](./payments/refunds-disputes/04-api-reference.md) - API reference
- [refunds-disputes/05-troubleshooting.md](./payments/refunds-disputes/05-troubleshooting.md) - Troubleshooting

---

### Payouts

Payout algorithm and consultant earnings.

- [algorithm/00-readme.md](./payouts/algorithm/00-readme.md) - Payout system overview
- [algorithm/01-architecture.md](./payouts/algorithm/01-architecture.md) - Architecture
- [algorithm/02-earnings-lifecycle.md](./payouts/algorithm/02-earnings-lifecycle.md) - Earnings lifecycle
- [algorithm/03-payout-processing.md](./payouts/algorithm/03-payout-processing.md) - Processing
- [algorithm/04-api-reference.md](./payouts/algorithm/04-api-reference.md) - API reference
- [algorithm/05-configuration.md](./payouts/algorithm/05-configuration.md) - Configuration

---

### Stream (Chat & Video)

Stream.io integration for messaging and video calls. This is the implemented messaging system.

- [01-architecture.md](./stream/01-architecture.md) - Stream architecture
- [02-setup-configuration.md](./stream/02-setup-configuration.md) - Setup and configuration
- [03-provider-authentication.md](./stream/03-provider-authentication.md) - Provider authentication
- [04-chat-implementation.md](./stream/04-chat-implementation.md) - Chat implementation
- [05-video-implementation.md](./stream/05-video-implementation.md) - Video implementation
- [06-channel-management.md](./stream/06-channel-management.md) - Channel management
- [07-user-management.md](./stream/07-user-management.md) - User management
- [08-token-management.md](./stream/08-token-management.md) - Token management
- [09-background-sync.md](./stream/09-background-sync.md) - Background sync
- [10-api-endpoints.md](./stream/10-api-endpoints.md) - API endpoints
- [11-hooks-utilities.md](./stream/11-hooks-utilities.md) - Hooks and utilities
- [12-error-handling.md](./stream/12-error-handling.md) - Error handling
- [13-recording-webhooks.md](./stream/13-recording-webhooks.md) - Recording webhooks
- [troubleshooting.md](./stream/troubleshooting.md) - Troubleshooting

---

### Supabase

Supabase configuration and policies.

- [setup-guide.md](./supabase/setup-guide.md) - Supabase setup guide

#### RLS Policies & Triggers

- [rls-policies-triggers/readme.md](./supabase/rls-policies-triggers/readme.md) - RLS overview
- [rls-policies-triggers/quick-reference.md](./supabase/rls-policies-triggers/quick-reference.md) - Quick reference
- [rls-policies-triggers/changelog.md](./supabase/rls-policies-triggers/changelog.md) - Changelog
- [rls-policies-triggers/troubleshooting.md](./supabase/rls-policies-triggers/troubleshooting.md) - Troubleshooting

---

### Upstash

Redis distributed locking.

- [redis/locking/00_README.md](./upstash/redis/locking/00_README.md) - Locking overview
- [redis/locking/01_MIGRATION_GUIDE.md](./upstash/redis/locking/01_MIGRATION_GUIDE.md) - Migration guide
- [redis/locking/02_API_REFERENCE.md](./upstash/redis/locking/02_API_REFERENCE.md) - API reference
- [redis/locking/03_DISTRIBUTED_LOCKING_DEEP_DIVE.md](./upstash/redis/locking/03_DISTRIBUTED_LOCKING_DEEP_DIVE.md) - Deep dive

---

### Webhooks

Webhook handlers and schemas.

- [monitoring.md](./webhooks/monitoring.md) - Webhook monitoring
- [razorpay-webhook-schema.md](./webhooks/razorpay-webhook-schema.md) - Razorpay webhook schema

#### Prototypes

- [prototypes/stripe-webhook-handler.md](./webhooks/prototypes/stripe-webhook-handler.md) - Stripe webhook prototype
- [prototypes/enhanced-webhook-handler.md](./webhooks/prototypes/enhanced-webhook-handler.md) - Enhanced webhook handler

---

### Storage

Storage management and document review system.

- [management-strategy.md](./storage/management-strategy.md) - Storage management strategy

---

### Performance

Implemented performance optimizations.

- [dashboard-prefetching.md](./performance/dashboard-prefetching.md) - Dashboard prefetching
- [optimization-checklist.md](./performance/optimization-checklist.md) - Optimization checklist

---

## Guides & Developer Resources

### Guides

Setup guides and how-to documentation.

- [cleanup-setup.md](./guides/cleanup-setup.md) - Cleanup configuration
- [cron-setup.md](./guides/cron-setup.md) - Cron job setup
- [using-fallback-image.md](./guides/using-fallback-image.md) - Fallback image usage

---

### API

Mobile API integration documentation.

> The Familiarise mobile app uses a separate Dart Frog backend. These docs describe web API contracts.

- [cancellation-api-mobile.md](./api/cancellation-api-mobile.md) - Cancellation API for mobile
- [support-tickets-mobile.md](./api/support-tickets-mobile.md) - Support tickets API for mobile

---

### Prisma

Prisma operations and migration documentation.

- [migrations-guide.md](./prisma/migrations-guide.md) - Migrations guide
- [prisma-7-migration.md](./prisma/prisma-7-migration.md) - Prisma 7 migration

---

### Education

Generic software architecture patterns and learning material (not Familiarise-specific).

- [education/README.md](./education/README.md) - **Full index**

---

## Business & Research

### Finances

Business model, pricing, and compliance documentation.

- [01-business-model.md](./finances/01-business-model.md) - Revenue model
- [02-payout-architecture.md](./finances/02-payout-architecture.md) - Payout architecture
- [03-international-payments.md](./finances/03-international-payments.md) - International payments
- [04-revenue-distribution.md](./finances/04-revenue-distribution.md) - Revenue splitting
- [05-saas-metrics-monthly.md](./finances/05-saas-metrics-monthly.md) - SaaS metrics
- [06-payout-implementation-plan.md](./finances/06-payout-implementation-plan.md) - Payout plan
- [07-pricing-calculator.md](./finances/07-pricing-calculator.md) - Pricing calculator
- [08-saas-expenditures.md](./finances/08-saas-expenditures.md) - Expenditures
- [09-tax-compliance-india.md](./finances/09-tax-compliance-india.md) - Tax compliance
- [10-profitability-minimum-pricing.md](./finances/10-profitability-minimum-pricing.md) - Profitability

---

### Competitors

Competitor analysis and research.

- [README.md](./competitors/README.md) - Competitors overview
- [01-topmate-io.md](./competitors/01-topmate-io.md) - Topmate analysis
- [02-preplaced-in.md](./competitors/02-preplaced-in.md) - Preplaced analysis
- [03-metvy-com.md](./competitors/03-metvy-com.md) - Metvy analysis
- [04-upgrad-com.md](./competitors/04-upgrad-com.md) - upGrad analysis
- [05-propeers-in.md](./competitors/05-propeers-in.md) - ProPeers analysis
- [06-growthschool-io.md](./competitors/06-growthschool-io.md) - GrowthSchool analysis

- [competitor-analysis.md](./competitor-analysis.md) - Consolidated competitor analysis

---

## Roadmap — Planned & Future Work

All documentation for features, integrations, and improvements that are **not yet implemented**.

- [roadmap/README.md](./roadmap/README.md) - **Full roadmap index**

### Highlights

- [Auth Migration (BetterAuth)](./roadmap/auth/betterauth-migration.md) - NextAuth → BetterAuth migration
- [Enterprise B2B Tier](./roadmap/enterprise/README.md) - SSO, org management, recording library
- [Infrastructure Hardening](./roadmap/infrastructure/README.md) - Security, monitoring, scaling (14 audit documents)
- [Notifications Architecture](./roadmap/notifications/service-integration-architecture.md) - Directus, ConvertKit, Resend, Novu interlinking
- [Content Strategy](./roadmap/content-strategy/README.md) - CMS, blog, gated community
- [Navigation Mega-Menu](./roadmap/navigation/README.md) - Mega-menu design
- [15 Planned Features](./roadmap/features/) - AI summaries, smart matching, referrals, and more
- [Performance Improvements](./roadmap/performance/) - Caching, scaling, zero-downtime migrations
