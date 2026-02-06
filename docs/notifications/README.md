# Notification System

The notification system uses a dual-layer architecture: **Resend** for direct transactional email delivery and **Novu** for multi-channel notification orchestration (in-app, email, push). Both layers follow a fire-and-forget pattern -- notifications never block the main transaction flow.

```mermaid
graph TD
    subgraph "Business Logic"
        A[API Routes / Webhooks / Cron Jobs]
    end

    subgraph "Notification Layer"
        A -->|Auth & Payment emails| B["Resend (Direct)"]
        A -->|All other notifications| C["Novu Service"]
        C -->|Email channel| B
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

- **Fire-and-forget** -- notification calls are wrapped in try-catch; failures are logged but never block the calling operation
- **Graceful degradation** -- if `NOVU_SECRET_KEY` or `RESEND_API_KEY` is missing, functions return `{success: false}` instead of throwing
- **Singleton clients** -- both Resend and Novu use lazy-initialized singleton instances
- **Subscriber = User** -- Novu `subscriberId` is the Prisma `User.id`
- **27 Novu workflows** -- each maps to a specific business event with typed payloads
- **10 React Email templates** -- server-rendered HTML via `@react-email/render`
- **User preferences** -- channel toggles (in-app, email, push), category toggles (7 categories), quiet hours

## Source Code Map

### Backend Services

| File                            | Purpose                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `lib/novu/client.ts`            | Singleton Novu client, `isNovuConfigured()` guard                                               |
| `lib/novu/service.ts`           | 20+ trigger functions: `notifyAppointmentBooked`, `notifyPaymentSuccess`, etc.                  |
| `lib/novu/workflows.ts`         | 27 workflow ID constants + 16 typed payload interfaces                                          |
| `lib/novu/subscriber.ts`        | `syncSubscriber`, `updateSubscriberPreferences`, `deleteSubscriber`                             |
| `lib/email.ts`                  | 6 Resend email functions (welcome, password reset, account linked, payment link/success/failed) |
| `lib/waitlist/notifications.ts` | 4 waitlist-specific Resend emails (joined, spot available, expiring, expired)                   |

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

| Template                                  | Category | Sent Via      |
| ----------------------------------------- | -------- | ------------- |
| `auth/WelcomeEmail.tsx`                   | Auth     | Resend direct |
| `auth/PasswordResetEmail.tsx`             | Auth     | Resend direct |
| `auth/AccountLinkedEmail.tsx`             | Auth     | Resend direct |
| `payments/PaymentLinkEmail.tsx`           | Payments | Resend direct |
| `payments/PaymentSuccessEmail.tsx`        | Payments | Resend direct |
| `payments/PaymentFailedEmail.tsx`         | Payments | Resend direct |
| `waitlist/WaitlistJoinedEmail.tsx`        | Waitlist | Resend direct |
| `waitlist/WaitlistSpotAvailableEmail.tsx` | Waitlist | Resend direct |
| `waitlist/WaitlistExpiringEmail.tsx`      | Waitlist | Resend direct |
| `waitlist/WaitlistExpiredEmail.tsx`       | Waitlist | Resend direct |

### Schemas

| File              | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `schemas/user.ts` | `NotificationPreferenceSchema`, `NotificationPreferenceUpdateSchema` |

## Quick Navigation

| I want to...                           | Go to                                                      |
| -------------------------------------- | ---------------------------------------------------------- |
| Understand the dual-layer architecture | [01-architecture.md](./01-architecture.md)                 |
| See all 27 workflows and API endpoints | [02-workflows-and-api.md](./02-workflows-and-api.md)       |
| Understand the payment system          | [../payments/architecture.md](../payments/architecture.md) |
| Check the database schema              | [../../prisma/schema.prisma](../../prisma/schema.prisma)   |
