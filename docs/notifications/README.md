# Notification System

The notification system uses a dual-layer architecture: **Resend** for direct transactional email delivery and **Novu** for multi-channel notification orchestration (in-app, email, push). Neither layer blocks the main transaction flow — a notification call never causes the calling operation to roll back. As of #474, Resend sends are not pure fire-and-forget: when a transactional email send fails, the already-rendered message is persisted to the `FailedEmail` table and a retry worker re-sends it with backoff. As of #1298, a missing or invalid `RESEND_API_KEY` is treated the same way — the send is dead-lettered into `FailedEmail` rather than silently dropped, because the failure happens inside `deliver()`'s try block instead of short-circuiting before it. Novu triggers remain genuinely fire-and-forget; all sixteen Novu workflow families are in-app only, so Novu never sends an email.

```mermaid
graph TD
    subgraph "Business Logic"
        A[API Routes / Webhooks / Cron Jobs]
    end

    subgraph "Notification Layer"
        A -->|Auth & Payment emails| B["Resend (Direct)"]
        A -->|All other notifications| C["Novu Service"]
        C -.->|Email channel: future, not configured| B
        C -->|In-App channel| D[Novu WebSocket]
        C -->|Push channel| E["FCM (Mobile)"]
    end

    subgraph "Delivery"
        B --> F[User Inbox]
        D --> G[Bell Icon / Notification Center]
        E --> H[Mobile Push]
    end

    subgraph "Templates"
        B -.->|Renders| I[React Email Templates]
    end
```

## Core Principles

- **Non-fatal** -- notification calls are wrapped in try-catch and a failure never rolls back the persisted business work; Novu failures are logged, while a failed or unconfigured Resend transactional send is persisted to `FailedEmail` and replayed by a retry worker rather than merely logged. Some callers still await the send (`lib/auth.ts` hooks) and one surfaces the failure to the caller (`app/api/contact/route.ts` answers 502 so the visitor can retry), so "non-fatal" does not mean "fire-and-forget"
- **A missing key dead-letters, it does not silently drop** -- `NOVU_SECRET_KEY` missing makes a Novu trigger a no-op; `RESEND_API_KEY` missing or rejected by Resend makes `deliver()` throw `EmailNotConfiguredError` inside its own try block, so the message is captured to `FailedEmail` and paged in Sentry rather than dropped
- **Singleton clients** -- both Resend and Novu use lazy-initialized singleton instances
- **Subscriber = User** -- Novu `subscriberId` is the Prisma `User.id`
- **67 notification events in 16 Novu workflow families** -- each event has a typed payload; the family is the Novu workflow and carries the event as `payload.event`; every family is in-app only, so Novu never carries an email
- **11 Resend senders, 10 React Email templates** -- `lib/email/index.ts` exports eleven sender functions; the contact-inquiry sender builds inline HTML instead of a template, so there are 10 React Email templates behind 11 senders. Every message is rendered server-side by `renderEmail()` (`lib/email/render.ts`, `react-email`'s `render()`) into both an HTML and a plain-text part
- **User preferences** -- channel toggles (in-app, email, push), category toggles (7 categories), quiet hours

## Source Code Map

### Backend Services

| File                                | Purpose                                                                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/novu/client.ts`                | Singleton Novu client, `isNovuConfigured()` guard                                                                                                                                                                 |
| `lib/novu/service.ts`               | 20+ trigger functions: `notifyAppointmentBooked`, `notifyPaymentSuccess`, etc.                                                                                                                                    |
| `lib/novu/workflows.ts`             | 69 event id constants and their typed payloads; `lib/novu/templates/` maps them onto 16 workflow families                                                                                                         |
| `lib/novu/subscriber.ts`            | `syncSubscriber`, `updateSubscriberPreferences`, `deleteSubscriber`                                                                                                                                               |
| `lib/email/index.ts`                | Eleven Resend sender functions (welcome, password reset, verification, account linked, payment link/success/failed, org invitation, waitlist confirm/welcome, contact inquiry); `@/lib/email` still resolves here |
| `lib/email/config.ts`               | `SENDERS` getters and `supportEmail()`/`contactInboxAddress()`/`billingEmail()`/`companyPostalAddress()`, all read from env at call time                                                                          |
| `lib/email/deliver.ts`              | `deliver()`, the single send core: content-hash idempotency key, `EmailNotConfiguredError`, `recordFailedEmail`                                                                                                   |
| `lib/email/idempotency.ts`          | Derives the `<EMAIL_TYPE>/<sha256(to\nsubject\nhtml)[:48]>` idempotency key shared by a sender and the retry worker                                                                                               |
| `lib/email/classify.ts`             | Classifies a Resend failure as terminal (dead key, unverified domain, missing key) or transient                                                                                                                   |
| `lib/email/render.ts`               | `renderEmail()` — renders a React Email element to `{ html, text }`                                                                                                                                               |
| `jobs/email/retry-failed-emails.ts` | Retry worker: dead-letters an expired verification/reset row, replays under the same idempotency key otherwise                                                                                                    |

### Frontend

| File                             | Purpose                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `providers/NovuProvider.tsx`     | Client-side Novu SDK wrapper, auth-gated                      |
| `hooks/useNovuSubscriberSync.ts` | Auto-syncs user to Novu on dashboard mount (30-min staleTime) |

### API Routes

| Route                   | Method | Purpose                                                       |
| ----------------------- | ------ | ------------------------------------------------------------- |
| `/api/novu/subscriber`  | POST   | Syncs authenticated user to Novu as subscriber                |
| `/api/novu/preferences` | GET    | Returns user's notification preferences (with defaults)       |
| `/api/novu/preferences` | PUT    | Updates notification preferences, syncs channel prefs to Novu |

### Email Templates (`emails/`)

The table below lists the ten React Email templates plus the one sender that builds inline HTML instead of a template; `components/EmailLogo.tsx` and `components/EmailFooter.tsx` are shared building blocks each template composes rather than templates of their own.

| Template                               | Category      | Sent Via                                                                                                    |
| -------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `components/EmailLogo.tsx`             | Shared        | Absolute logo URL via `getAppUrl()`, composed into every template                                           |
| `components/EmailFooter.tsx`           | Shared        | Copyright year, Privacy/Terms links, optional postal line, optional unsubscribe link, optional support line |
| `auth/WelcomeEmail.tsx`                | Auth          | `lib/email/index.ts` → `sendWelcomeEmail`                                                                   |
| `auth/PasswordResetEmail.tsx`          | Auth          | `lib/email/index.ts` → `sendPasswordResetEmail`                                                             |
| `auth/VerificationEmail.tsx`           | Auth          | `lib/email/index.ts` → `sendVerificationEmail`                                                              |
| `auth/AccountLinkedEmail.tsx`          | Auth          | `lib/email/index.ts` → `sendAccountLinkedEmail`                                                             |
| `payments/PaymentLinkEmail.tsx`        | Payments      | `lib/email/index.ts` → `sendPaymentLinkEmail`                                                               |
| `payments/PaymentSuccessEmail.tsx`     | Payments      | `lib/email/index.ts` → `sendPaymentSuccessEmail`                                                            |
| `payments/PaymentFailedEmail.tsx`      | Payments      | `lib/email/index.ts` → `sendPaymentFailedEmail`                                                             |
| `organizations/OrgInvitationEmail.tsx` | Organizations | `lib/email/index.ts` → `sendOrgInvitationEmail` (no caller today)                                           |
| `waitlist/WaitlistConfirmEmail.tsx`    | Newsletter    | `lib/email/index.ts` → `sendWaitlistConfirmEmail`                                                           |
| `waitlist/WaitlistWelcomeEmail.tsx`    | Newsletter    | `lib/email/index.ts` → `sendWaitlistWelcomeEmail`                                                           |
| Inline HTML (no `.tsx` file)           | Contact       | `lib/email/index.ts` → `sendContactInquiryEmail`, builds HTML directly instead of rendering a template      |

### Schemas

| File              | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `schemas/user.ts` | `NotificationPreferenceSchema`, `NotificationPreferenceUpdateSchema` |

## Source of truth for Novu templates

`lib/novu/templates/` is the source of truth for every Novu workflow's in-app copy, redirect and opt-out category; `scripts/novu/sync-workflows.ts` writes it to the Novu environment as one workflow per family. Run `npm run novu:sync -- --dry-run` to preview a change, `npm run novu:sync` to apply it, and `npm run novu:check` to check for drift (the CI-side guard). See [ADR 30](../enterprise/70-design-decisions/30-novu-templates-as-code-and-workflow-families.md) for why the templates moved into the repository and why they are grouped into families.

## Quick Navigation

| I want to...                                          | Go to                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Understand the dual-layer architecture                | [01-architecture.md](./01-architecture.md)                                                                     |
| See all 69 events, the 16 families and API endpoints  | [02-workflows-and-api.md](./02-workflows-and-api.md)                                                           |
| Read the #1298 outage diagnosis and the send-core fix | [06-engineering-log-2026-09-14-email-resend-outage.md](./06-engineering-log-2026-09-14-email-resend-outage.md) |
| Understand the payment system                         | [../payments/architecture.md](../payments/architecture.md)                                                     |
| Check the database schema                             | [../../prisma/schema.prisma](../../prisma/schema.prisma)                                                       |
