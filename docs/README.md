# Documentation Index

This documentation is organized into logical categories for easy navigation.

## File Naming Convention

All documentation files follow the `lowercase-with-hyphens.md` naming convention.

---

## Architecture

System design, scaling strategies, and architectural decisions.

- [scaling-strategies-part1.md](./architecture/scaling-strategies-part1.md) - Database optimizations and caching
- [scaling-strategies-part2.md](./architecture/scaling-strategies-part2.md) - Concurrency and microservices
- [server-actions-vs-api-routes.md](./architecture/server-actions-vs-api-routes.md) - Next.js patterns comparison
- [schema-design-correction.md](./architecture/schema-design-correction.md) - Database schema fixes

---

## Booking

Booking system, slot management, and scheduling logic.

- [checkout-system.md](./booking/checkout-system.md) - Checkout flow overview
- [multiple-attempts-flow.md](./booking/multiple-attempts-flow.md) - Handling multiple booking attempts
- [slot-types.md](./booking/slot-types.md) - Slot type definitions
- [slot-type-refactor.md](./booking/slot-type-refactor.md) - Slot type refactoring notes

### Booking Algorithm

Detailed documentation for the booking algorithm.

- [00-readme.md](./booking/algorithm/00-readme.md) - Algorithm overview
- [01-quick-start.md](./booking/algorithm/01-quick-start.md) - Quick start guide
- [02-architecture.md](./booking/algorithm/02-architecture.md) - Architecture details
- [03-event-types.md](./booking/algorithm/03-event-types.md) - Event type handling
- [04-validation-layers.md](./booking/algorithm/04-validation-layers.md) - Validation logic
- [05-slot-calculations.md](./booking/algorithm/05-slot-calculations.md) - Slot calculation logic
- [06-api-reference.md](./booking/algorithm/06-api-reference.md) - API reference
- [07-bug-fixes-changelog.md](./booking/algorithm/07-bug-fixes-changelog.md) - Bug fixes history
- [08-troubleshooting.md](./booking/algorithm/08-troubleshooting.md) - Troubleshooting guide
- [09-testing-guide.md](./booking/algorithm/09-testing-guide.md) - Testing guide
- [architecture-overview.md](./booking/algorithm/architecture-overview.md) - High-level architecture
- [datetime-migration-plan.md](./booking/algorithm/datetime-migration-plan.md) - DateTime migration
- [flows.md](./booking/algorithm/flows.md) - Booking flows
- [ui-guide.md](./booking/algorithm/ui-guide.md) - UI implementation guide

#### Testing Reports

- [testing/bug-report-part1.md](./booking/algorithm/testing/bug-report-part1.md)
- [testing/bug-report-part2.md](./booking/algorithm/testing/bug-report-part2.md)
- [testing/bug-report-part3.md](./booking/algorithm/testing/bug-report-part3.md)
- [testing/bug-report-part4.md](./booking/algorithm/testing/bug-report-part4.md)
- [testing/comprehensive-testing-prompt.md](./booking/algorithm/testing/comprehensive-testing-prompt.md)
- [testing/more-testing-phases.md](./booking/algorithm/testing/more-testing-phases.md)
- [testing/2025-10-14-allocation-bugs.md](./booking/algorithm/testing/2025-10-14-allocation-bugs.md)

---

## Calendar

Calendar display, synchronization, and UI components.

- [display-analysis.md](./calendar/display-analysis.md) - Calendar display analysis
- [synchronization-refactor.md](./calendar/synchronization-refactor.md) - Calendar sync refactoring
- [responsive-appointments-system.md](./calendar/responsive-appointments-system.md) - Responsive design
- [visual-changes-summary.md](./calendar/visual-changes-summary.md) - Visual changes overview

---

## Features

Feature-specific documentation.

- [document-review-system.md](./features/document-review-system.md) - Document review feature

### Collaborators

- [collaborators/implementation.md](./features/collaborators/implementation.md) - Collaborators implementation
- [collaborators/podcast-schema-integration.md](./features/collaborators/podcast-schema-integration.md) - Podcast schema

---

## Guides

Setup guides and how-to documentation.

- [cleanup-setup.md](./guides/cleanup-setup.md) - Cleanup configuration
- [cron-setup.md](./guides/cron-setup.md) - Cron job setup
- [migration-guide.md](./guides/migration-guide.md) - Migration guide
- [using-fallback-image.md](./guides/using-fallback-image.md) - Fallback image usage

---

## Payments

Payment system, checkout flows, and gateway integrations.

- [setup.md](./payments/setup.md) - Payment system setup
- [abandoned-solutions.md](./payments/abandoned-solutions.md) - Abandoned payment handling

### Checkout Flow

- [checkout-flow/01-checkout-flow.md](./payments/checkout-flow/01-checkout-flow.md)
- [checkout-flow/02-checkout-flow.md](./payments/checkout-flow/02-checkout-flow.md)
- [checkout-flow/03-checkout-flow.md](./payments/checkout-flow/03-checkout-flow.md)
- [checkout-flow/04-checkout-flow.md](./payments/checkout-flow/04-checkout-flow.md)
- [checkout-flow/05-checkout-flow.md](./payments/checkout-flow/05-checkout-flow.md)

### Razorpay

- [razorpay/kyc/01-kyc-overview.md](./payments/razorpay/kyc/01-kyc-overview.md) - KYC overview
- [razorpay/kyc/02-business-types-requirements.md](./payments/razorpay/kyc/02-business-types-requirements.md) - Business requirements
- [razorpay/kyc/03-industry-certifications.md](./payments/razorpay/kyc/03-industry-certifications.md) - Industry certifications
- [razorpay/kyc/04-setup-checklist.md](./payments/razorpay/kyc/04-setup-checklist.md) - Setup checklist

### System

- [system/test-report.md](./payments/system/test-report.md) - Payment system test report

---

## Performance

Performance optimization and prefetching strategies.

- [prefetching.md](./performance/prefetching.md) - Prefetching basics
- [prefetching-advanced.md](./performance/prefetching-advanced.md) - Advanced prefetching
- [dashboard-prefetching.md](./performance/dashboard-prefetching.md) - Dashboard prefetching
- [optimization-checklist.md](./performance/optimization-checklist.md) - Optimization checklist

---

## Reference

Technical references and schema documentation.

- [seeding-bugs-report.md](./reference/seeding-bugs-report.md) - Seeding bugs report
- [seeding-updates-subscription-validation.md](./reference/seeding-updates-subscription-validation.md) - Seeding updates
- [collaborators-schema.prisma](./reference/collaborators-schema.prisma) - Collaborators Prisma schema

---

## Storage

Storage management documentation.

- [management-strategy.md](./storage/management-strategy.md) - Storage management strategy

---

## Stream

Stream.io integration for chat and video.

- [readme.md](./stream/readme.md) - Stream overview
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
- [13-known-issues.md](./stream/13-known-issues.md) - Known issues
- [14-troubleshooting.md](./stream/14-troubleshooting.md) - Troubleshooting

---

## Supabase

Supabase configuration and policies.

- [setup-guide.md](./supabase/setup-guide.md) - Supabase setup guide

### RLS Policies & Triggers

- [rls-policies-triggers/readme.md](./supabase/rls-policies-triggers/readme.md) - RLS overview
- [rls-policies-triggers/quick-reference.md](./supabase/rls-policies-triggers/quick-reference.md) - Quick reference
- [rls-policies-triggers/changelog.md](./supabase/rls-policies-triggers/changelog.md) - Changelog
- [rls-policies-triggers/troubleshooting.md](./supabase/rls-policies-triggers/troubleshooting.md) - Troubleshooting

---

## Webhooks

Webhook handlers and schemas.

- [monitoring.md](./webhooks/monitoring.md) - Webhook monitoring
- [razorpay-webhook-schema.md](./webhooks/razorpay-webhook-schema.md) - Razorpay webhook schema

### Prototypes

- [prototypes/stripe-webhook-handler.md](./webhooks/prototypes/stripe-webhook-handler.md) - Stripe webhook prototype
- [prototypes/enhanced-webhook-handler.md](./webhooks/prototypes/enhanced-webhook-handler.md) - Enhanced webhook handler

---

## Upcoming Documentation

The following documentation will be added from `fix/payment-algorithm-2` branch:

- `payments/pay-later/` - Pay later feature documentation
- `upstash/redis/locking/` - Redis distributed locking
- `reference/status-enums.md` - Status enums reference
