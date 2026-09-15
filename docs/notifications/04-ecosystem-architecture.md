# Email, Notification & Newsletter — Full Ecosystem Architecture

> Complete map of every service, pipeline, component, and data flow in the Familiarise notification system.

**Last Updated**: 2026-09-14

---

## Status Legend

| Symbol        | Meaning                                              |
| ------------- | ---------------------------------------------------- |
| **LIVE**      | Fully implemented and wired into business logic      |
| **CODE DONE** | Code exists, external config needed (Novu Dashboard) |
| **STUB**      | Placeholder code, logs only, no real functionality   |
| **MISSING**   | Not implemented, not stubbed                         |

---

## Master Architecture Diagram

```mermaid
flowchart TB
    subgraph TRIGGERS["User & System Triggers"]
        direction LR
        T_AUTH["Sign Up\nPassword Reset\nOAuth Link"]
        T_BOOK["Book / Pay\nCancel / Reschedule"]
        T_SUPPORT["Support Ticket\nReview / Feedback"]
        T_TRIAL["Trial Request\nVerification Submit"]
        T_ADMIN["Admin Broadcast\nNewsletter Send"]
        T_CRON["Cron: Reminders\nCron: Auto-Complete"]
        T_STREAM["Stream.io:\nRecording Ready"]
        T_NL["Newsletter Subscribe\non website"]
    end

    subgraph PIPE1["PIPELINE 1: Resend Direct — LIVE"]
        direction TB
        P1_LIB["lib/email/index.ts\n11 functions"]
        subgraph P1_TEMPLATES["10 React Email Templates"]
            P1_T1["emails/auth/\nWelcomeEmail\nPasswordResetEmail\nVerificationEmail\nAccountLinkedEmail"]
            P1_T2["emails/payments/\nPaymentLinkEmail\nPaymentSuccessEmail\nPaymentFailedEmail"]
            P1_T3["emails/waitlist/\nConfirm | Welcome"]
            P1_T4["emails/organizations/\nOrgInvitationEmail"]
        end
        P1_RENDER["renderEmail()\nreact-email → {html, text}"]
        P1_DELIVER["deliver()\nsingle send core, idempotency key"]
    end

    subgraph PIPE2["PIPELINE 2: Novu Orchestrated — CODE DONE, DASHBOARD NEEDS CONFIG"]
        direction TB
        P2_SVC["lib/novu/service.ts\n30+ exported trigger functions\nfire-and-forget pattern"]
        P2_WF["lib/novu/workflows.ts\n40 workflow IDs\n20+ typed payload interfaces"]
        P2_CLIENT["lib/novu/client.ts\nSingleton, lazy init\nGraceful degradation"]
        P2_SUB["lib/novu/subscriber.ts\nsyncSubscriber()\nupdateSubscriberPreferences()\ndeleteSubscriber()"]
        subgraph NOVU_CLOUD["Novu Cloud Dashboard — NEEDS CONFIG"]
            NC_WF["15 Tier 1 Workflows\nSpecs: docs/notifications/\n03-novu-template-specs.md"]
            NC_EMAIL["Email Channel\nNOT CONFIGURED (ADR 30: in-app only)"]
            NC_INAPP["In-App Channel\nWebSocket → bell icon"]
            NC_PUSH["Push/FCM Channel\nNOT IMPLEMENTED"]
            NC_PREFS["Subscriber Custom Data\n7 category flags\n3 channel flags"]
        end
    end

    subgraph PIPE3["PIPELINE 3: Newsletter — LIVE (interim)"]
        direction TB
        P3_SUB["POST /api/waitlist\nUpserts a PENDING row, sends the confirm email"]
        P3_CONFIRM["GET /api/waitlist/confirm\nHMAC-signed, 48h link\nPENDING → SUBSCRIBED, sends welcome"]
        P3_UNSUB["GET|POST /api/waitlist/unsubscribe\nHMAC-signed, timeless token\nRFC 8058 one-click"]
        P3_SEND["POST /api/admin/waitlist/broadcast\nAdmin-only, Resend batch API\n100/call, auto-appends\nunsubscribe footer + headers"]
        P3_DB[("Waitlist table\nemail, name, status, source, tags\nconfirmedAt, unsubscribedAt")]
    end

    subgraph STUBS["DEFERRED — STUBS"]
        direction TB
        STUB_CK["ConvertKit / Kit\nNo code yet — deferred until\nthe list outgrows the Resend batch API"]
        STUB_CMS["Directus CMS\napp/api/webhooks/directus/\nLogs webhook, returns 200\nTODO: blog → broadcast"]
        STUB_PUSH["Push Notifications\nSchema: pushEnabled field\nNo FCM integration"]
    end

    subgraph PROMO["PROMOTIONAL — NOT CONNECTED"]
        PROMO_MD["emails/promotional/\n16 markdown templates\n8 consultant + 8 consultee\ninitial / followup /\nspecialized / reengagement\nFor: Lemlist, Apollo, Instantly"]
    end

    subgraph CLIENT["CLIENT-SIDE — LIVE"]
        direction TB
        CL_PROV["providers/NovuProvider.tsx\nWraps app with NovuSDKProvider\nAuth-gated rendering"]
        CL_INBOX["components/notifications/\nNotificationInbox.tsx\nBell icon + unread badge\nClick → redirect URL"]
        CL_HOOK["hooks/useNovuSubscriberSync.ts\nReact Query, 30min staleTime\nPOST /api/novu/subscriber"]
        CL_PREFS["components/notifications/\nNotificationPreferencesPanel.tsx\n3 channels + 7 categories\n+ quiet hours"]
    end

    subgraph DASHBOARDS["DASHBOARD INTEGRATION"]
        direction TB
        D_ADMIN["Admin Settings\nHas NotificationPreferencesPanel ✅"]
        D_STAFF["Staff Settings\nHas NotificationPreferencesPanel ✅"]
        D_CONSULTANT["Consultant Settings\nMISSING prefs panel ⚠️"]
        D_CONSULTEE["Consultee Settings\nMISSING prefs panel ⚠️"]
        D_ANNOUNCE["Admin: POST /api/announcements\nCreates announcement record\n+ notifyGeneralAnnouncement()\ntriggerBroadcast to ALL users"]
        D_NL_SEND["Admin: Newsletter Send UI\nPOST /api/admin/waitlist/broadcast"]
    end

    subgraph DELIVERY["DELIVERY"]
        DEL_RESEND["Resend API\nresend.emails.send()\nresend.batch.send()"]
        DEL_WS["Novu WebSocket\nReal-time in-app"]
        DEL_EMAIL["User Email Inbox"]
    end

    %% Trigger → Pipeline 1 (Resend Direct)
    T_AUTH -->|"sendWelcomeEmail\nsendPasswordResetEmail\nsendAccountLinkedEmail"| P1_LIB
    T_BOOK -->|"sendPaymentLinkEmail\nsendPaymentSuccessEmail\nsendPaymentFailedEmail"| P1_LIB

    %% Trigger → Pipeline 2 (Novu)
    T_BOOK -->|"notifyAppointmentBooked\nnotifyPaymentSuccess/Failed\nnotifyAppointmentCancelled"| P2_SVC
    T_SUPPORT -->|"notifySupportTicketCreated\nnotifyNewReview"| P2_SVC
    T_TRIAL -->|"notifyTrialRequested\nnotifyVerificationStatusChanged\nnotifyNewConsultantApplication"| P2_SVC
    T_ADMIN -->|"notifyGeneralAnnouncement"| P2_SVC
    T_CRON -->|"notifyAppointmentReminder\nnotifyAppointmentCompleted"| P2_SVC
    T_STREAM -->|"notifyRecordingAvailable"| P2_SVC

    %% Trigger → Pipeline 3 (Newsletter)
    T_NL --> P3_SUB
    T_ADMIN --> P3_SEND

    %% Pipeline 1 internal
    P1_LIB --> P1_RENDER
    P1_RENDER --> P1_DELIVER
    P1_DELIVER --> DEL_RESEND

    %% Pipeline 2 internal
    P2_SVC --> P2_CLIENT --> NOVU_CLOUD
    NC_EMAIL -.->|"future"| DEL_RESEND
    NC_INAPP --> DEL_WS

    %% Pipeline 3 internal
    P3_SUB --> P3_DB
    P3_SUB --> DEL_RESEND
    P3_CONFIRM --> P3_DB
    P3_CONFIRM --> DEL_RESEND
    P3_UNSUB --> P3_DB
    P3_SEND --> P3_DB
    P3_SEND --> DEL_RESEND

    %% Stubs
    STUB_CMS -.->|"future: blog webhook"| STUB_CK

    %% Delivery
    DEL_RESEND --> DEL_EMAIL
    DEL_WS --> CL_INBOX

    %% Client → Backend
    CL_PREFS -->|"PUT /api/novu/preferences"| P2_SUB
    CL_HOOK -->|"POST /api/novu/subscriber"| P2_SUB
    P2_SUB --> NC_PREFS

    %% Dashboard → Components
    CL_PREFS --> D_ADMIN
    CL_PREFS --> D_STAFF
    CL_PREFS -.->|"NOT included"| D_CONSULTANT
    CL_PREFS -.->|"NOT included"| D_CONSULTEE
    D_ANNOUNCE --> P2_SVC
    D_NL_SEND --> P3_SEND
```

---

## Pipeline Breakdown

### Pipeline 1: Resend Direct — LIVE

**Purpose:** Transactional emails that are tightly coupled to auth, payment, and newsletter flows. These bypass Novu because they don't need multi-channel delivery (no in-app, no push).

**How it works:**

1. Business logic calls a send function (e.g., `sendWelcomeEmail()`) in `lib/email/index.ts`
2. The function renders its React Email element via `renderEmail()` (`lib/email/render.ts`) into `{html, text}`
3. The function calls `deliver()` (`lib/email/deliver.ts`), the single send core: `getResendClient()` (lazy singleton), a content-hash Idempotency-Key, and a `From` address read from `SENDERS`
4. `deliver()` sends via `resend.emails.send()`; a thrown `EmailNotConfiguredError` or any other terminal failure is dead-lettered into `FailedEmail` rather than dropped

**10 React Email templates behind 11 senders** (the contact-inquiry sender builds inline HTML instead of a template):

| Template                   | From Address                            | Triggered By                                          |
| -------------------------- | --------------------------------------- | ----------------------------------------------------- |
| WelcomeEmail               | `onboarding@mail.familiarisenow.com`    | BetterAuth `user.create.after` hook (awaited, #1298)  |
| PasswordResetEmail         | `security@mail.familiarisenow.com`      | Password reset flow                                   |
| VerificationEmail          | `onboarding@mail.familiarisenow.com`    | Email verification flow                               |
| AccountLinkedEmail         | `security@mail.familiarisenow.com`      | OAuth account linking (awaited, #1298)                |
| PaymentLinkEmail           | `payments@mail.familiarisenow.com`      | Consultant approves consultation/subscription request |
| PaymentSuccessEmail        | `payments@mail.familiarisenow.com`      | Stripe/Razorpay payment webhook                       |
| PaymentFailedEmail         | `payments@mail.familiarisenow.com`      | Stripe/Razorpay failure webhook                       |
| OrgInvitationEmail         | `notifications@mail.familiarisenow.com` | Organization invitation flow (no caller today)        |
| WaitlistConfirmEmail       | `newsletter@news.familiarisenow.com`    | Double opt-in confirmation for a waitlist signup      |
| WaitlistWelcomeEmail       | `newsletter@news.familiarisenow.com`    | Sent once the confirm link is clicked                 |
| (inline HTML, no template) | `notifications@mail.familiarisenow.com` | `/contactus` submission → `sendContactInquiryEmail`   |

Every address above is env-derived from `EMAIL_TRANSACTIONAL_DOMAIN` / `EMAIL_NEWSLETTER_DOMAIN`; the values shown are the defaults.

**Design system:** White card on `#f5f5f5` background, black CTA button, `-apple-system` font stack, `16px` body, `28px` heading.

---

### Pipeline 2: Novu Orchestrated — CODE DONE, DASHBOARD NEEDS CONFIG

**Purpose:** Multi-channel notifications (in-app today; email and push are future channels). Novu is the "brain" that decides what/who/where/when. As of ADR 30 all sixteen workflow families are in-app only, so the email step described below is the planned design and is not created in any family; no Resend provider is configured in Novu.

**How it works:**

1. Business logic calls a trigger function (e.g., `notifyAppointmentBooked(userIds, payload)`)
2. Function checks `isNovuConfigured()` — if false, logs warning and returns `{success: false}`
3. Calls `novu.trigger()` (single user), `triggerForMultiple()` (batch of 100), or `triggerBroadcast()` (all subscribers)
4. Novu Cloud receives the event and executes the workflow:
   - **Email step (not yet created)** → would render a template with `{{payload.variables}}` and send via a Resend integration
   - **In-App step** → pushes to subscriber's WebSocket → appears in bell icon
   - **Digest/Delay steps** → can batch or schedule (configured per-workflow in Dashboard)
5. Novu checks subscriber preference data before sending (category flags)

**40 Workflow IDs (by tier):**

| Tier        | Workflows                                                                                                                                                                                                                                                                                    | Status                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Tier 1 (16) | appointment-booked, appointment-cancelled, appointment-reminder, payment-success, payment-failed, new-booking-request, subscription-started, subscription-cancelled, trial-session-\* (4), support-ticket-created, support-ticket-response, new-review-received, verification-status-changed | Template specs ready in `docs/notifications/03-novu-template-specs.md` |
| Tier 2 (9)  | appointment-rescheduled, appointment-completed, appointment-partially-scheduled, refund-processed, payout-processed, collaborator-invited/accepted/removed, new-consultant-application                                                                                                       | Triggers wired, Dashboard config deferred                              |
| Tier 3 (16) | subscription-renewed, referral-_, maintenance-_, dispute-_, recording-_, general-announcement, feedback-received, etc.                                                                                                                                                                       | Functions exist, wiring deferred                                       |

**Trigger wiring (which business logic calls which notification):**

| Business Logic File                                         | Notifications Fired                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `lib/payments/webhooks/handlers.ts`                         | appointmentBooked, paymentSuccess, paymentFailed               |
| `app/api/appointments/[id]/cancel/route.ts`                 | appointmentCancelled                                           |
| `app/api/appointments/[id]/reschedule/route.ts`             | appointmentRescheduled                                         |
| `app/api/cleanup/appointment-reminders/route.ts`            | appointmentReminder (cron)                                     |
| `scripts/appointments/auto-complete-appointments.ts`        | appointmentCompleted (cron)                                    |
| `app/api/scheduling/request-for-approval/route.ts`          | newBookingRequest                                              |
| `app/api/bookings/subscriptions/`                           | subscriptionStarted, subscriptionCancelled                     |
| `app/api/trials/route.ts` + `[trialId]/route.ts`            | trial\* (4)                                                    |
| `app/api/user/support-tickets/route.ts`                     | supportTicketCreated                                           |
| `app/api/staff/support-tickets/[id]/responses/route.ts`     | supportTicketResponse                                          |
| `app/api/user/reviews/route.ts`                             | newReview                                                      |
| `app/api/admin/verification/` + `app/api/staff/moderation/` | verificationStatusChanged                                      |
| `app/api/verification/submit/route.ts`                      | newConsultantApplication                                       |
| `lib/payments/payouts/payout-service.ts`                    | payoutProcessed                                                |
| `lib/collaborators/service.ts`                              | collaboratorInvited, collaboratorAccepted, collaboratorRemoved |
| `app/api/webhooks/stream/recording/route.ts`                | recordingAvailable                                             |
| `app/api/announcements/route.ts`                            | generalAnnouncement (broadcast)                                |
| `app/api/webhooks/utils.ts`                                 | refundProcessed, disputeCreated, disputeResolved               |
| `app/api/user/feedbacks/route.ts`                           | feedbackReceived                                               |

---

### Pipeline 3: Newsletter Interim — LIVE

**Purpose:** Collect newsletter subscribers with a double opt-in and send occasional broadcasts via the Resend batch API. Interim solution until a list tool such as ConvertKit is integrated at 500+ subscribers.

**How it works:**

```
Subscribe (double opt-in, see docs/marketing/01-waitlist-newsletter.md):
  User enters email on site → POST /api/waitlist
    → upserts a Waitlist row with status PENDING (re-subscribe resets it)
    → sendWaitlistConfirmEmail() with an HMAC-signed, 48-hour confirm link
    → returns {success: true}

Confirm:
  User clicks link → GET /api/waitlist/confirm?email=...&token=...&issuedAt=...
    → verifyConfirmToken() (signature + TTL)
    → status PENDING → SUBSCRIBED, confirmedAt = now()
    → sendWaitlistWelcomeEmail() with the unsubscribe link

Send:
  Admin calls POST /api/admin/waitlist/broadcast {subject, htmlBody, textBody?}
    → Auth check (ADMIN role only, requireAdminAuth())
    → listSendableSubscribers() from lib/waitlist/service.ts
    → For each batch of 100: resend.batch.send() via getResendClient() from lib/email
    → Each email gets: unsubscribe footer + List-Unsubscribe header
    → Returns {sent, failed, total}

  There is no `/api/admin/newsletter/send` route; the broadcast endpoint lives
  under `/api/admin/waitlist/broadcast` because the send list and the double
  opt-in confirmation share the Waitlist table.

Unsubscribe:
  User clicks link → GET /api/waitlist/unsubscribe?email=...&token=...
  Mail client one-click → POST /api/waitlist/unsubscribe (RFC 8058)
    → verifyUnsubscribeToken() (HMAC-SHA256, never expires)
    → status → UNSUBSCRIBED, unsubscribedAt = now()
    → Show HTML confirmation page
```

**Database model:** the `Waitlist` model in `prisma/schema.prisma` (`email`, `name`, `status`, `source`, `tags`, `userId`, `confirmedAt`, `unsubscribedAt`, consent proof). There are no token columns because both links are stateless HMACs; the field-by-field description lives in [docs/marketing/01-waitlist-newsletter.md](../marketing/01-waitlist-newsletter.md).

---

## Subscriber Lifecycle

```mermaid
sequenceDiagram
    participant User
    participant Auth as BetterAuth
    participant DB as Prisma DB
    participant Novu as Novu Cloud
    participant Bell as Bell Icon
    participant Prefs as Preferences Panel

    User->>Auth: Signs up (email/OAuth)
    Auth->>DB: Create User + NotificationPreference
    Auth->>Novu: syncSubscriber(userId, name, email)
    Auth->>User: sendWelcomeEmail() via Resend

    Note over User,Novu: On every dashboard load (30min cache)
    User->>Bell: Opens dashboard
    Bell->>Novu: useNovuSubscriberSync hook
    Novu-->>Bell: WebSocket connection established
    Novu-->>Bell: Push queued in-app notifications

    Note over User,Prefs: When user changes preferences
    User->>Prefs: Toggle category/channel
    Prefs->>DB: PUT /api/novu/preferences → upsert
    Prefs->>Novu: updateSubscriberPreferences()
    Note right of Novu: Stores 7 category flags +<br/>3 channel flags as<br/>subscriber custom data

    Note over User,Novu: On any business event
    DB->>Novu: notifyAppointmentBooked(userIds, payload)
    Novu->>Novu: Check subscriber prefs
    Novu->>User: Email via Resend (if emailEnabled + categoryAppointments)
    Novu->>Bell: In-App notification (if inAppEnabled)
```

---

## Stream.io Integration

```mermaid
flowchart LR
    subgraph STREAM["Stream.io Platform"]
        S1["Video Calls\n4 service types"]
        S2["Chat Channels\nConsultant-Consultee\nCollaborator channels"]
        S3["Webhook Events"]
    end

    subgraph HANDLERS["Webhook Handlers"]
        H1["app/api/stream/webhooks/route.ts\n8 event types\nHMAC signature verification"]
        H2["app/api/webhooks/stream/recording/route.ts\ncall.recording.ready\nLooks up Meeting → Slot → Users"]
    end

    subgraph ACTIONS["Notification Actions"]
        A1["Update Meeting\nrecording state in DB"]
        A2["notifyRecordingAvailable()\nAll participants via Novu"]
    end

    S3 -->|"call.recording_started\ncall.recording_stopped\ncall.session_ended\ncall.ended\nuser.flagged\nmessage.flagged"| H1
    S3 -->|"call.recording.ready"| H2
    H1 --> A1
    H2 --> A2
```

**Data path for recording notification:**
`Stream.io call.recording.ready` → `route.ts` → `prisma.meeting.findFirst({where: {streamCallId}})` → `include: appointmentOccurrence → appointment → consultation/subscription/webinar/class` → extract consultant name + participant user IDs from slot's M2M `user` relation → `notifyRecordingAvailable(userIds, {recordingUrl, ...})`

---

## Verification Flow

```mermaid
sequenceDiagram
    participant Consultant
    participant API as /api/verification/submit
    participant DB as Prisma DB
    participant Novu as Novu
    participant Admin as Admin/Staff

    Consultant->>API: POST {linkedinUrl, notes, documentIds}
    API->>DB: Create/Update ConsultantProfileVerification (PENDING)
    API->>DB: Set verificationStatus = UNDER_REVIEW
    API->>Novu: notifyNewConsultantApplication(adminIds, {name, email})
    Novu-->>Admin: In-App + Email notification

    Admin->>DB: Review → APPROVED or REJECTED
    DB->>Novu: notifyVerificationStatusChanged(consultantUserId, {status, reason})
    Novu-->>Consultant: In-App + Email: "Your status: APPROVED/REJECTED"
```

---

## Cron Jobs

```mermaid
flowchart LR
    subgraph CRONS["Scheduled Jobs"]
        C1["appointment-reminders\nGET /api/cleanup/appointment-reminders\nEvery 15 minutes\nAuth: Bearer CRON_SECRET"]
        C2["auto-complete-appointments\nGET /api/cleanup/auto-complete-appointments\nEvery 1 hour\nAuth: Bearer CRON_SECRET"]
    end

    subgraph LOGIC["Logic"]
        L1["Query slots starting in 23-25h\nQuery slots starting in 45-75min\nDeduplicate by appointmentId"]
        L2["Find SCHEDULED events\nwhere all slots ended 1h+ ago\nUpdate status → COMPLETED"]
    end

    subgraph NOTIFY["Notifications"]
        N1["notifyAppointmentReminder()\nboth parties"]
        N2["notifyAppointmentCompleted()\nboth parties"]
    end

    C1 --> L1 --> N1
    C2 --> L2 --> N2
```

---

## Dashboard & Admin Features

| Feature                      | Route                              | Who                                             | What It Does                                                |
| ---------------------------- | ---------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| **Notification Preferences** | Settings page                      | Admin ✅, Staff ✅, Consultant ⚠️, Consultee ⚠️ | 3 channels + 7 categories + quiet hours                     |
| **Bell Icon / Inbox**        | All dashboards                     | All roles                                       | Novu in-app notifications, unread count, click-to-redirect  |
| **Announcements**            | POST /api/announcements            | Admin, Staff                                    | Create announcement + broadcast to all Novu subscribers     |
| **Newsletter Send**          | POST /api/admin/waitlist/broadcast | Admin only                                      | Send HTML email to every SUBSCRIBED Waitlist row via Resend |
| **Newsletter Stats**         | (not built)                        | —                                               | Would show subscriber count, open rates                     |
| **Verification Review**      | /dashboard/admin/verification      | Admin, Staff                                    | Review applications → triggers verificationStatusChanged    |

---

## What's STUB vs LIVE vs MISSING

### LIVE (fully working)

| Component                                      | Files                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Resend email client                            | `lib/email/index.ts`, `lib/email/deliver.ts`, `lib/email/config.ts`                                              |
| 10 React Email templates behind 11 senders     | `emails/auth/`, `emails/payments/`, `emails/organizations/`, `emails/waitlist/`, `emails/components/`            |
| Novu client + service + workflows + subscriber | `lib/novu/*.ts`                                                                                                  |
| Novu React provider + bell icon + sync hook    | `providers/NovuProvider.tsx`, `components/notifications/NotificationInbox.tsx`, `hooks/useNovuSubscriberSync.ts` |
| Notification Preferences Panel                 | `components/notifications/NotificationPreferencesPanel.tsx`                                                      |
| Preferences API                                | `app/api/novu/preferences/route.ts` (GET/PUT)                                                                    |
| Subscriber sync API                            | `app/api/novu/subscriber/route.ts` (POST)                                                                        |
| Waitlist double opt-in confirm/unsubscribe     | `lib/waitlist/tokens.ts`, `lib/waitlist/service.ts`                                                              |
| Admin waitlist broadcast                       | `app/api/admin/waitlist/broadcast/route.ts`                                                                      |
| Appointment reminders cron                     | `app/api/cleanup/appointment-reminders/route.ts`                                                                 |
| Auto-complete + notify                         | `scripts/appointments/auto-complete-appointments.ts`                                                             |
| Stream recording webhook                       | `app/api/webhooks/stream/recording/route.ts`                                                                     |
| Stream main webhook                            | `app/api/stream/webhooks/route.ts`                                                                               |
| Announcements + broadcast                      | `app/api/announcements/route.ts`                                                                                 |
| 30+ notification trigger wiring                | Various API routes and services                                                                                  |

### STUB (placeholder code, no functionality)

| Component            | File                                 | What It Does Now        | When to Implement  |
| -------------------- | ------------------------------------ | ----------------------- | ------------------ |
| Directus CMS webhook | `app/api/webhooks/directus/route.ts` | Logs event, returns 200 | When blog launches |

### NEEDS EXTERNAL CONFIG (code complete, config needed)

| Component       | What's Needed                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Novu workflows  | Not a dashboard task: `lib/novu/templates/` is the source of truth and `npm run novu:sync` writes it to the Development environment (ADR 30); all sixteen families are in-app only, no Resend integration to configure |
| Resend domains  | Add `mail.familiarisenow.com` and `news.familiarisenow.com` in the Resend dashboard, then add the DKIM/return-path/SPF/DMARC records the dashboard returns in Netlify DNS (region: Tokyo, `ap-northeast-1`)            |
| Cron scheduling | Schedule reminder + auto-complete cron jobs in GitHub Actions or Netlify                                                                                                                                               |

### MISSING (no code, no stub)

| Component                              | Impact                                       | Recommendation                                             |
| -------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| Consultant/Consultee preferences panel | Users can't manage notification preferences  | Add `NotificationPreferencesPanel` to their settings pages |
| Newsletter subscribe UI component      | No way for users to subscribe on the website | Build footer/sidebar email input form                      |
| Push notifications (FCM)               | No browser push                              | Defer until significant user base                          |
| Email analytics (opens/clicks/bounces) | No deliverability monitoring                 | Add Resend webhook handler post-launch                     |
| Notification logging/audit             | No delivery audit trail                      | Novu Dashboard activity feed covers this                   |
| Promotional email automation           | 16 templates sit unused                      | Use external tool (Lemlist) for cold outreach              |

---

## Environment Variables

| Variable                             | Required | Used By                                                                              |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `RESEND_API_KEY`                     | Yes      | Resend direct emails, waitlist broadcast                                             |
| `EMAIL_TRANSACTIONAL_DOMAIN`         | No       | Transactional sender domain (defaults to `mail.familiarisenow.com`)                  |
| `EMAIL_NEWSLETTER_DOMAIN`            | No       | Waitlist/newsletter sender domain (defaults to `news.familiarisenow.com`)            |
| `NEXT_PUBLIC_SUPPORT_EMAIL`          | No       | Public support mailbox, default Reply-To                                             |
| `CONTACT_INBOX_ADDRESS`              | No       | `/contactus` delivery inbox (defaults to the support mailbox)                        |
| `BILLING_EMAIL`                      | No       | Supplier contact on tax invoices (defaults to the support mailbox)                   |
| `NEXT_PUBLIC_COMPANY_POSTAL_ADDRESS` | No       | Optional postal line in `EmailFooter`                                                |
| `NOVU_DEVELOPMENT_KEY`               | Yes      | Novu server-side SDK, Development environment (local, previews)                      |
| `NOVU_PRODUCTION_KEY`                | Yes      | Novu server-side SDK, Production environment (production only)                       |
| `NEXT_PUBLIC_NOVU_APP_ID`            | Yes      | Novu React SDK (client-side)                                                         |
| `NEXT_PUBLIC_APP_URL`                | Yes      | Email link URLs, unsubscribe URLs                                                    |
| `CRON_SECRET`                        | Yes      | Auth for cron job endpoints                                                          |
| `WAITLIST_HMAC_SECRET`               | Yes      | Waitlist confirm/unsubscribe token signing; there is no fallback to `RESEND_API_KEY` |
| `STREAM_WEBHOOK_SECRET`              | Yes      | Stream webhook signature verification                                                |

---

## NPM Packages

| Package        | Version | Pipeline                                                                                 |
| -------------- | ------- | ---------------------------------------------------------------------------------------- |
| `resend`       | ^6.28.0 | Pipeline 1 + 3                                                                           |
| `react-email`  | 6.9.5   | Pipeline 1 (replaces the deprecated `@react-email/components` and `@react-email/render`) |
| `@novu/api`    | 3.13.0  | Pipeline 2 (server)                                                                      |
| `@novu/nextjs` | 3.13.0  | Pipeline 2 (client)                                                                      |
| `@novu/react`  | 3.13.0  | Pipeline 2 (client)                                                                      |
