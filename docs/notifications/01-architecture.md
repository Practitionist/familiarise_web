# Notification Architecture

## Design Decision: Resend + Novu

The notification system uses two complementary services rather than one:

| Service    | Role                                     | Analogy     |
| ---------- | ---------------------------------------- | ----------- |
| **Resend** | Email delivery infrastructure            | The postman |
| **Novu**   | Multi-channel notification orchestration | The brain   |

**Why both?** Resend sends emails reliably (DKIM, SPF, bounce handling) but cannot do in-app notifications, push notifications, digest batching, or user preference routing. Novu orchestrates all channels but cannot deliver emails itself. As of ADR 30 every Novu workflow family is in-app only, so the Novu email channel shown below is a possible future path, not a configured one; Novu sends no email today.

**Why not Novu for everything?** Some emails (auth, payment links) are tightly coupled to their API routes and don't need multi-channel delivery. Sending these directly through Resend avoids unnecessary complexity.

```mermaid
graph LR
    subgraph "Direct Resend Path"
        A1[Auth Emails] --> R[Resend API]
        A2[Payment Emails] --> R
        A3[Newsletter Emails] --> R
        R --> T[React Email Templates]
        T --> D[Email Delivery]
    end

    subgraph "Novu Orchestrated Path"
        B1[Appointment Events] --> N[Novu API]
        B2[Support Events] --> N
        B3[Subscription Events] --> N
        B4[Admin Events] --> N
        N -.->|Email channel: future, not configured| R
        N -->|In-App channel| WS[WebSocket]
        N -->|Push channel| FCM[Firebase]
    end
```

### When to Use Each Path

| Use Resend Directly                                   | Use Novu                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| Auth emails (welcome, password reset, account linked) | Appointment lifecycle (booked, cancelled, rescheduled, completed) |
| Payment transactional (payment link, success, failed) | Support tickets (created, updated, response)                      |
| Newsletter opt-in (confirm, welcome)                  | Feedback and reviews                                              |
| Any email that doesn't need in-app/push delivery      | Trial sessions, subscriptions                                     |
|                                                       | Consultant-specific (booking requests, verification, payouts)     |
|                                                       | Admin/system (announcements, new applications)                    |
|                                                       | Disputes, recordings                                              |

---

## Two Novu tenants, and the Resend path underneath

Novu treats Development and Production as two fully separate tenants — separate workflows, separate subscribers, separate notification history, and a secret key that only works against its own tenant. `lib/novu/secret-key.ts` decides which tenant a given process talks to by reading `NEXT_PUBLIC_SENTRY_ENVIRONMENT`: the Netlify production context and the GitHub Actions cron twins resolve to `NOVU_PRODUCTION_KEY`, and every preview, branch deploy and local shell resolves to `NOVU_DEVELOPMENT_KEY`, so a developer testing on a preview can never trigger a workflow that reaches a real subscriber's inbox. The platform ships 16 workflow families against Novu's 20-workflow plan cap, and all 69 individual events across those families have a trigger call site in code; promoting a workflow from Development to Production is a per-workflow `workflows.sync({ targetEnvironmentId })` call made from the Development side, because Novu's environment-publish endpoint itself refuses API keys.

The diagram also follows the direct-Resend path for the emails that never go through Novu. A `Failed*/email` component under `emails/**` is rendered to HTML by `@react-email/render` inside `lib/email.ts`, sent with `resend.emails.send({ from: "<name> <address>@<sender domain>", ... })`, and, on a thrown error, persisted verbatim to a `FailedEmail` row that `jobs/email/retry-failed-emails.ts` retries on a fixed backoff before giving up to `DEAD_LETTER`. Whichever domain appears after the `@` in that `from` address has to be a domain Resend has verified, with DKIM, SPF and DMARC records published at whatever host manages that domain's DNS; those records are what let a receiving mail server trust that the message actually came from this platform rather than being spoofed.

```mermaid
flowchart LR
  subgraph NovuTenants["Novu — two tenants, one key each"]
    DEV_ENV["Development tenant<br/>NOVU_DEVELOPMENT_KEY"]
    PROD_ENV["Production tenant<br/>NOVU_PRODUCTION_KEY"]
    SYNC["workflows.sync({ targetEnvironmentId })<br/>promotes a workflow Development -> Production"]
    DEV_ENV -- "16 families, 69 triggered events" --> SYNC --> PROD_ENV
  end
  APP["Next.js app<br/>lib/novu/secret-key.ts picks the key from NEXT_PUBLIC_SENTRY_ENVIRONMENT"]
  APP -- "preview / branch-deploy / local shell" --> DEV_ENV
  APP -- "Netlify production context + GitHub Actions cron twins" --> PROD_ENV
  BELL["NEXT_PUBLIC_NOVU_APP_ID<br/>in-app bell (client SDK)"]
  PROD_ENV --> BELL

  subgraph ResendPath["Direct Resend path"]
    TPL["emails/** React Email components"]
    RENDER["@react-email/render<br/>lib/email.ts"]
    SEND["resend.emails.send<br/>from: name@&lt;verified sender domain&gt;"]
    OK["Delivered"]
    FAIL["FailedEmail row"]
    RETRY["jobs/email/retry-failed-emails.ts<br/>1m, 5m, 30m, 2h, 8h backoff"]
    DEAD["DEAD_LETTER — operator-replayable"]
  end
  TPL --> RENDER --> SEND
  SEND -- "success" --> OK
  SEND -- "throws" --> FAIL --> RETRY
  RETRY -- "exhausted after 5 attempts" --> DEAD
  RETRY -- "succeeds" --> OK
```

## Resend Layer

### Client Initialization

```
lib/email/
├── index.ts          -- 11 sender functions plus renderPaymentSuccessEmail()/renderPaymentFailedEmail(); @/lib/email still resolves to this module
├── config.ts         -- SENDERS getters, EMAIL_BUDGET_MS, supportEmail(), contactInboxAddress(), billingEmail(), companyPostalAddress()
├── deliver.ts         -- deliver() = stage() + attempt(), the single send core; getResendClient(), recordFailedEmail(), EmailNotConfiguredError
├── idempotency.ts     -- derives the content-hash Idempotency-Key shared by a sender and the retry worker
├── classify.ts        -- classifies a Resend failure as terminal or transient
├── render.ts          -- renderEmail(), returns { html, text }
├── preferences.ts     -- loadEmailRecipients(), the NotificationPreference gate
├── send-to-recipients.ts -- sendToRecipients() / stageToRecipients() / attemptStaged(), the per-recipient fan-out
└── senders/
    ├── booking.ts     -- the six booking lifecycle senders (#1653), re-exported from index.ts
    ├── money.ts       -- the six money senders (#1653), re-exported from index.ts
    └── people.ts      -- the six people and access senders (#1653), re-exported from index.ts

sendWelcomeEmail()         -- from: SENDERS.onboarding (onboarding@mail.familiarisenow.com)
sendPasswordResetEmail()   -- from: SENDERS.security (security@mail.familiarisenow.com)
sendVerificationEmail()    -- from: SENDERS.onboarding
sendAccountLinkedEmail()   -- from: SENDERS.security
sendPaymentLinkEmail()     -- from: SENDERS.payments (payments@mail.familiarisenow.com)
sendPaymentSuccessEmail()  -- from: SENDERS.payments
sendPaymentFailedEmail()   -- from: SENDERS.payments
sendOrgInvitationEmail()   -- from: SENDERS.notifications, entityRef orgInvite:<id> (invitations route) or membership:<id> (bulk import)
sendWaitlistConfirmEmail() -- from: SENDERS.newsletter (newsletter@news.familiarisenow.com)
sendWaitlistWelcomeEmail() -- from: SENDERS.newsletter
sendContactInquiryEmail()  -- from: SENDERS.notifications, to: contactInboxAddress()

sendAppointmentBookedEmail() / stageAppointmentBookedEmail(tx, …)
                           -- from: SENDERS.notifications, category appointments, entityRef appointment:<id>
sendAppointmentCancelledEmail()   -- from: SENDERS.notifications, category appointments, entityRef appointment:<id>
sendAppointmentRescheduledEmail() -- from: SENDERS.notifications, category appointments, entityRef appointment:<id>
sendAppointmentReminderEmail()    -- from: SENDERS.notifications, category appointments, entityRef appointment:<id>:<24h|1h>
sendNewBookingRequestEmail()      -- from: SENDERS.notifications, category appointments, entityRef request:<id>
sendTrialScheduledEmail()         -- from: SENDERS.notifications, category trials, entityRef trial:<id>
```

The six booking senders in `lib/email/senders/booking.ts` (#1653) differ from the eleven above in shape: each takes user ids plus the raw domain values its call site already holds (Dates, names, ids and the href the sibling Novu bell computed), resolves the recipients through `loadEmailRecipients()`, and renders one message per recipient in that recipient's zone through `sendToRecipients()`, so the subject and body of the booked and trial emails switch on whether the reader is the consultee or the consultant. Every time is written as `formatInViewerZone(d, zone, "EEE, d MMM yyyy 'at' h:mm a")` followed by the zone label. A booking sender never throws: an unexpected error is reported to Sentry with `tags: { subsystem: "email", emailType }` and returned as a failed count, and the caller's budget (`REQUEST` from an API route, `JOB` from a sweep or script, `WEBHOOK` from the payment webhook) bounds how long the caller waits. The templates live in `emails/booking/` and render inside `EmailLayout`. Each sender is called right after the Novu bell it twins, with the same recipients and the same href, and the bell itself is unchanged.

sendRefundProcessedEmail() / stageRefundProcessedEmail(tx, …) -- from: SENDERS.payments, category payments, entityRef payment:<id>
sendRefundFailedEmail() -- from: SENDERS.payments, category payments, entityRef payment:<id>
sendOrgPayoutFailedEmail() -- from: SENDERS.finance, category orgBilling, entityRef orgPayout:<id>
sendOrgInvoiceOverdueEmail() -- from: SENDERS.finance, category orgBilling, entityRef orgInvoice:<id>
sendOrgWalletLowEmail() -- from: SENDERS.finance, category orgBilling, entityRef org:<id>
sendOrgOverageDueEmail() -- from: SENDERS.finance, category orgBilling, entityRef overage:<id>

```

The six money senders in `lib/email/senders/money.ts` (#1653) are the first lifecycle senders built on the preference gate: each takes user ids plus raw domain values, resolves the recipients with `loadEmailRecipients()`, fans out with `sendToRecipients()`, and never throws, because a missed email must never fail the request, webhook or job that moved the money (ADR 21). The org senders take `recipientUserIds` rather than an org id on purpose: the call site computes the roster once with `rosterForOrg(orgId, VISIBILITY_ROLES)`, now exported from `lib/novu/org-workflows.ts`, so the bell and the email always reach the same people. Every call site awaits its email after the bell, and the budget is the caller's: `WEBHOOK` from the refund and payout webhooks, `REQUEST` from the rejection, event-refund and overage routes, and `JOB` from the dunning, wallet, no-show and refund-reconcile jobs.

sendSupportTicketResponseEmail() -- from: SENDERS.notifications, category support, entityRef ticket:<id>
sendSupportTicketUpdateEmail() -- from: SENDERS.notifications, category support, entityRef ticket:<id>
sendAccountSuspendedEmail() -- from: SENDERS.security, category null (required notice), entityRef user:<id>
sendAccountBannedEmail() -- from: SENDERS.security, category null (required notice), entityRef user:<id>
sendOrgSsoCertExpiringEmail() -- from: SENDERS.security, category null (required notice), entityRef org:<id>
sendNewReviewEmail() -- from: SENDERS.notifications, category feedback, entityRef review:<id>

```

The six people and access senders in `lib/email/senders/people.ts` (#1653) share the shape the booking senders introduced: each takes user ids plus the raw domain values its call site already holds, resolves the recipients through `loadEmailRecipients()`, and renders one message per recipient in that recipient's zone through `sendToRecipients()`, so a suspension's end date and a certificate's expiry are printed in the reader's own zone. The three notices that pass a `null` category are never gated and carry no unsubscribe link, and `sendOrgInvitationEmail()` is never gated either because the invitee has no account row to read; the support and review senders are gated on `support` and `feedback`. A people sender never throws: an unexpected error is reported to Sentry with `tags: { subsystem: "email", emailType }` and returned as a failed count, and the caller's budget (`REQUEST` from an API route or the moderation action, `JOB` from the certificate sweep) bounds how long the caller waits. The templates live in `emails/support/`, `emails/account/`, `emails/organizations/` and `emails/reviews/` and render inside `EmailLayout`. Each sender is called right after the Novu bell it twins, with the same recipient and the same href, and no bell changed except the invitation bell, which is now awaited.

Every domain in `SENDERS` is read from `EMAIL_TRANSACTIONAL_DOMAIN` / `EMAIL_NEWSLETTER_DOMAIN` at call time (defaults `mail.familiarisenow.com` / `news.familiarisenow.com`), not hardcoded, so an environment can point sends at a different verified domain without a code change.

### Email Rendering Pipeline

Every sender follows render → build → deliver. `renderEmail()` (`lib/email/render.ts`) renders the React Email element once and returns both an HTML string and a plain-text string, so every outbound message carries a text part alongside the HTML part. `deliver()` (`lib/email/deliver.ts`) is the single send core all eleven senders funnel through, and since #1654 it is two phases: `stage()` writes the rendered message as a `PENDING` `FailedEmail` row before any network call, and `attempt()` performs one inline send under a time budget and settles the row. The outbox row exists the moment the business change is durable, so a function that freezes between the commit and the send can no longer lose the email; the relay described below finishes whatever the inline attempt left `PENDING`.

```mermaid
sequenceDiagram
    participant API as API Route
    participant Fn as Email Function
    participant RE as renderEmail()
    participant DL as deliver() = stage() + attempt()
    participant FE as FailedEmail table
    participant RS as Resend API

    API->>Fn: sendPaymentLinkEmail({email, name, amount, ...})
    Fn->>RE: renderEmail(PaymentLinkEmail({name, amount, ...}))
    RE-->>Fn: {html, text}
    Fn->>DL: deliver({from, to, subject, html, text}, emailType, {entityRef, budgetMs})
    DL->>FE: stage() -- PENDING row with the rendered body and entityRef
    DL->>RS: attempt() -- emails.send(payload, {idempotencyKey, signal: AbortSignal.timeout(budgetMs)})
    alt sent
        RS-->>DL: {id: "email_xxx"}
        DL->>FE: status SENT, sentAt, resendId
        DL-->>Fn: {success: true, data}
    else timed out
        DL->>DL: log once, no Sentry
        DL-->>Fn: {success: false, staged: true} -- the row stays PENDING for the relay
    else terminal error (dead key, unverified domain, rejected body)
        DL->>FE: status DEAD_LETTER, lastError; Sentry error fingerprint ["email-send-terminal", reason]
        DL-->>Fn: {success: false, staged: true}
    else transient error or missing key
        DL->>FE: lastError only -- still PENDING, the relay's backoff starts from its own first try
        DL-->>Fn: {success: false, staged: true}
    end
    Fn-->>API: DeliverResult
```

The inline attempt runs under a budget named in `EMAIL_BUDGET_MS` (`lib/email/config.ts`) and chosen per caller, because the caller's request is what a slow provider would otherwise hold open until Netlify's ~26-second ceiling. The table below lists the budgets and who uses each.

| Budget                 | Milliseconds | Callers                                                                                                        |
| ---------------------- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| `AUTH`                 | 8 000        | The Better Auth hooks (welcome, verification, password reset, account linked) and the organisation invitation. |
| `CONTACT_AND_WAITLIST` | 5 000        | The contact form and both waitlist senders.                                                                    |
| `WEBHOOK`              | 3 000        | The payment senders (receipt, failure notice, payment link).                                                   |
| `JOB`                  | 10 000       | The compliance alert jobs and every send the relay itself makes.                                               |
| `REQUEST`              | 5 000        | API-route senders of lifecycle mail (#1653): the request must not wait on Resend longer than this.             |

A timeout is not a failure. The Resend SDK spreads the request options into `fetch`, so the `AbortSignal` genuinely aborts the call, and `attempt()` recognises either a thrown `AbortError`/`TimeoutError` or the SDK's generic "could not be resolved" error while its own signal is aborted; in both cases the row is left `PENDING` and untouched, a single log line is written, and nothing reaches Sentry. The relay sends the row on its next pass under the same content-hash Idempotency-Key (`lib/email/idempotency.ts`, of the form `<EMAIL_TYPE>/<sha256(to\nsubject\nhtml)[:48]>`), which Resend deduplicates for 24 hours, so a send that actually completed after the caller stopped waiting is not delivered twice. `deliver()` defaults Reply-To to `supportEmail()` when the caller does not set one; `stage()` applies the same default so the row and the send agree. A missing key (`EmailNotConfiguredError`) is reported at level `"error"` with fingerprint `["email-send-terminal", "not_configured"]` but leaves the row `PENDING`, because it replays once the key exists (#1298); a dead key, an unverified domain or a body Resend rejects dead-letters the row on the spot, since no replay changes the answer.

Every sender stamps the row's `entityRef` with the business anchor it knows: the auth senders write `user:<id>`, the payment senders `payment:<id>`, the waitlist senders `waitlist:<email>`, the contact form `contact:<email>`, and the booking senders `appointment:<id>` (suffixed `:24h` or `:1h` for the reminder), `request:<id>` or `trial:<id>`, and the people senders `ticket:<id>`, `user:<id>`, `org:<id>`, `review:<id>`, `orgInvite:<id>` or, for a bulk import that creates no invitation row, `membership:<id>`. A sender's `DeliverResult` carries `staged: true` on failure when the row exists, which is how `app/api/contact/route.ts` answers success for an inquiry that is durable but not yet delivered and keeps its 502 for the case where even the row could not be written.

#### Staging inside a transaction

A caller that owns a database transaction calls the two phases itself rather than `deliver()`: `stage(message, emailType, { tx, entityRef })` inside the transaction and `attempt(staged, message, emailType, { budgetMs })` after it commits. Inside a transaction a staging failure propagates, so the row and the business write roll back together, which is the whole point of the outbox; an attempt inside the transaction would send before the business write is durable, so the split is deliberate. `lib/payments/webhooks/handlers.ts` is the one caller today: `stagePaymentSuccessEmail()` reads the receipt's inputs through the Phase 1 transaction, renders with `renderPaymentSuccessEmail()` (`lib/email/index.ts`, the render-only half of `sendPaymentSuccessEmail()`), stages the row, and Phase 2 attempts it under the `WEBHOOK` budget; the two blocked outcomes that Phase 2 refunds (a capture after cancellation, a double-booking loser) stage nothing. `handlePaymentFailure()` does the same with `stagePaymentFailedEmail()` and attempts after its own transaction commits. Since #1653 the booked confirmation rides the same read: `loadAppointmentForEmails()` is the one appointment read Phase 1 makes for mail, `stagePaymentSuccessEmail()` and `stageBookedEmails()` both render from it, and `stageAppointmentBookedEmail(tx, …)` reads the two recipients through the transaction and stages one row per allowed recipient; Phase 2 runs `attemptStaged()` next to the receipt's attempt. A subscription placeholder with no session yet stages no booked email, as its bell is skipped, and the two blocked outcomes stage nothing. Nothing else in the money transaction changed (ADR 21). The refund webhook (`handleRefundCreated` in `app/api/webhooks/utils.ts`) is the third caller since #1653: `stageRefundProcessedEmail(tx, …)` reads the payer through the Serializable transaction with `loadEmailRecipients([userId], "payments", tx)`, stages with `stageToRecipients()` right after the bell is staged, and `attemptStaged()` runs after commit next to the bell's attempt under the `WEBHOOK` budget. The list of staged rows is reset at the top of the transaction callback because a serialization retry re-runs it. The receipt omits the credit-note number, since the Sec 34 `CreditNote` is minted inside the refund cascade and is not in scope at the staging point; adding a query for it would be a change inside a money transaction.

### The relay

`jobs/email/retry-failed-emails.ts` is both the retry worker of #474 and the outbox relay of #1654: it drains `FailedEmail` rows whose status is `PENDING`, or `RETRY` with a `nextRetryAt` that has passed, up to fifty per tick, re-sends each stored message verbatim under its original Idempotency-Key with the `JOB` budget as an abort signal, writes `resendId` on success, and walks the shared backoff ladder in `lib/retry/backoff.ts` on failure. The drain paces itself at one send every 125 milliseconds, because Resend's team limit is ten requests a second and the inline fast path sends alongside the relay. It runs from two places: the Netlify ticker (`netlify/functions/cron-tick.mts`) posts `/api/cleanup/retry-failed-emails?limit=20` on every tick whose wall-clock minute is a multiple of fifteen, and the GitHub Actions workflow `retry-failed-emails.yml` runs the same worker unbounded as the backstop (#1648, ADR 27). Both entries take the fail-closed cron lock `retry-failed-emails`, so an overlap answers 409 instead of sending a row twice. Since #1647 the same tick, under the same lock, also drains `FailedEmailBatch` rows: the newsletter broadcast stages one row per batch request before calling `resend.batch.send`, and the relay replays up to five of them per tick through `resend.batch.send` under the stored idempotency key, walking the same backoff ladder and dead-lettering on the same terminal reasons as a single row. The tick's summary reports the batch drain apart from the single rows as `batchesScanned`, `batchesSent`, `batchesRetried` and `batchesDeadLettered`.

### Delivery events and suppression

`app/api/webhooks/resend/route.ts` (#1647) is where Resend tells us what happened to a message after it was accepted. Every signed event, whatever its type, becomes one `EmailEvent` row holding the svix id, the Resend email id, the type, the first recipient (normalised to lower case) and the full payload, so support can trace a `FailedEmail.resendId` to its delivery history. The receiver verifies the signature with the SDK's `webhooks.verify()` against `RESEND_WEBHOOK_SECRET`, answers 401 without logging the body when the signature does not verify, 400 when a svix header is missing, 413 above a 256 KB body, and 503 with a Sentry page when the secret or the API key is not configured. It is idempotent on the svix id: a redelivery or a dashboard replay hits the unique constraint and answers 200 with `duplicate: true` without re-running any side effect, and the row is written before any side effect so a failure after that point still answers 200 rather than making Resend retry an event that is already durable.

Two event types do more than store a row. An `email.bounced` event whose `bounce.type` is `Permanent` writes the address to `EmailSuppression` with reason `HARD_BOUNCE` and moves a `PENDING` or `SUBSCRIBED` `Waitlist` row to `BOUNCED`; an `email.complained` event writes reason `COMPLAINT` and moves the `Waitlist` row to `UNSUBSCRIBED` with `unsubscribedAt` stamped. A `Transient` bounce (a full mailbox, greylisting) does not suppress, because the address is not dead and the next send may well be accepted. The suppression upsert has an empty update, so an existing row is never downgraded from `COMPLAINT` to `HARD_BOUNCE` or re-stamped by a later event; a `MANUAL` reason exists for an operator to add an address by hand.

The list is enforced at both ends of the outbox. `stage()` in `lib/email/deliver.ts` reads `EmailSuppression` for the recipient (through the caller's transaction when there is one) before writing the `FailedEmail` row, and a suppressed address is written as `DEAD_LETTER` with `lastError` set to `suppressed:<REASON>`; `attempt()` then returns `{ success: false, staged: true }` with an `EmailSuppressedError` and never calls Resend. The relay reads the list once per tick for the rows it selected and dead-letters a suppressed row the same way without a send, and the newsletter broadcast filters suppressed addresses out of its recipients and reports the count as `skippedSuppressed`. None of these refusals reach Sentry, because the refusal is the intended outcome. Resend's own event hook delivers to production only (the same constraint as Stream's), so the `EmailEvent` and `EmailSuppression` tables fill only there; previews and local runs see no events.

### From Address Convention

| Domain Prefix    | Used For                                                            | Domain                    |
| ---------------- | ------------------------------------------------------------------- | ------------------------- |
| `onboarding@`    | Welcome, email verification                                         | `mail.familiarisenow.com` |
| `security@`      | Password reset, linking, suspension, ban, SSO cert expiry           | `mail.familiarisenow.com` |
| `payments@`      | Payment link, success, failure                                      | `mail.familiarisenow.com` |
| `notifications@` | Org invitations, contact inquiry, booking, support, reviews (#1653) | `mail.familiarisenow.com` |
| `finance@`       | Finance-facing notices                                              | `mail.familiarisenow.com` |
| `dpdp@`          | DPDP compliance alerts                                              | `mail.familiarisenow.com` |
| `noreply@`       | Data-export notice (the worker falls back to `onboarding@`)         | `mail.familiarisenow.com` |
| `system` (bare)  | Internal requester id, not a `From` header                          | `mail.familiarisenow.com` |
| `newsletter@`    | Waitlist opt-in + broadcast                                         | `news.familiarisenow.com` |

---

## Novu Layer

### Client Architecture

```mermaid
graph TD
    subgraph "Server Side"
        C[lib/novu/client.ts] -->|Singleton| N[Novu Instance]
        S[lib/novu/service.ts] -->|Uses| C
        S -->|Imports| W[lib/novu/workflows.ts]
        SUB[lib/novu/subscriber.ts] -->|Uses| C
    end

    subgraph "Client Side"
        P[providers/NovuProvider.tsx] -->|Wraps app| SDK[Novu React SDK]
        H[hooks/useNovuSubscriberSync.ts] -->|Calls| API["/api/novu/subscriber"]
        API -->|Calls| SUB
    end

    subgraph "Novu Cloud"
        N -->|API calls| NC[Novu Dashboard]
        SDK -->|WebSocket| NC
    end
```

### Server-Side Client (`lib/novu/client.ts`)

Singleton pattern matching `lib/stream-client.ts`:

- `isNovuConfigured()` -- checks whether the secret key for the detected Novu environment is set: `NOVU_PRODUCTION_KEY` when `NEXT_PUBLIC_SENTRY_ENVIRONMENT=production`, otherwise `NOVU_DEVELOPMENT_KEY` (`lib/novu/secret-key.ts`)
- `validateNovuConfig()` -- throws if not configured (used by `getNovuClient`)
- `getNovuClient()` -- returns singleton `Novu` instance
- `resetNovuClient()` -- clears singleton (for testing)

### Core Trigger Functions (`lib/novu/service.ts`)

Three trigger patterns handle all notification scenarios, and since #1654 all three are outbox-first: `lib/novu/outbox.ts` stages a `NotificationOutbox` row, attempts the wire call inline under the client's five-second timeout, and leaves anything unsettled for the drain.

```mermaid
graph TD
    A[Business Event] --> B{How many recipients?}
    B -->|Single user| C[triggerWorkflow]
    B -->|Multiple users| D[triggerForMultiple]
    B -->|All subscribers| E[triggerBroadcastWorkflow]

    C --> S[stageTrigger -- NotificationOutbox row, transactionId derived here]
    D -->|Batches of 100| S
    E --> S
    S --> T[attemptTrigger -- inline, 5 s client timeout]
    T -->|SINGLE / MULTI| F[novu.trigger]
    T -->|BROADCAST| G[novu.triggerBroadcast]
    T -->|timeout, 5xx, network| R[row stays PENDING -- drain-notification-outbox]
    R --> F

    F --> H[Novu Cloud]
    G --> H
    H -->|Per workflow config| I[In-App]
```

The table below lists the three core functions; each accepts an optional trailing `{ tx?, entityRef? }`. The seventeen organisation helpers in `lib/novu/org-workflows.ts` (`notifyOrgInviteSent`, `notifyOrgPayoutFailed`, `notifyOrgWalletLow` and the rest) are thin wrappers over `triggerWorkflow`, `triggerForMultiple` and `triggerForMultipleZoned` since #1669, so they stage, attempt and dead-letter exactly as the B2C helpers do and accept the same `{ tx, entityRef }` option; the only difference is that they resolve the recipient roster from `Membership` first, and when `tx` is passed that roster read goes through the transaction too, because a global-client read while a transaction holds the single pooled connection deadlocks on Netlify (`PG_POOL_MAX=1`).

| Function                                                                | Use Case                                            | Batching             |
| ----------------------------------------------------------------------- | --------------------------------------------------- | -------------------- |
| `triggerWorkflow(workflowId, subscriberId, payload, dedupeKey?, opts?)` | Single recipient (payment success, booking request) | N/A                  |
| `triggerForMultiple(workflowId, userIds, payload, dedupeKey?, opts?)`   | Both parties or staff group                         | 100 per API call     |
| `triggerBroadcastWorkflow(workflowId, payload, opts?)`                  | System announcements to all users                   | Novu handles fan-out |

All three follow the same sequence:

```
1. stageTrigger() -- upsert the NotificationOutbox row on its transactionId (PENDING, entityRef, notBefore)
2. If Novu is not configured: report, return {success: false} -- the row waits for the relay
3. If a tx was passed: return {success: true, staged} -- the caller runs attemptTrigger(staged) after commit
4. attemptTrigger(): novu.trigger() / novu.triggerBroadcast() under the same transactionId
5. On success (or a 2xx the SDK could not parse): row SENT, return {success: true}
6. On a terminal 4xx: row DEAD_LETTER, Sentry error fingerprint ["novu-trigger-terminal", reason]
7. On a timeout, 5xx or connection failure: row stays PENDING with lastError, return {success: false}
```

`transactionId` is derived when the row is staged, by `deriveTransactionId()` in `lib/novu/outbox.ts`, from the event id, the sorted recipient ids and the canonical payload (or an explicit `dedupeKey`); the sort is a code-point comparator, never `localeCompare`, because a collation-dependent sort produced different ids for the same mixed-case recipients on different runtimes. Novu deduplicates on that id, so a relay that triggers, dies before marking the row `SENT`, and triggers again rings the bell once. Staging is an upsert with an empty update on the same key, so a replayed webhook or a re-run job that stages the same notification twice gets the existing row back rather than a unique violation that would roll back its transaction. The zoned variants (`triggerWorkflowZoned`, `triggerForMultipleZoned`) only shape the rendered payload per recipient timezone; they do not defer the send, so the row's `notBefore` stays null today and the column waits for the quiet-hours work.

When Novu is not configured the row is still staged, so notifications raised before the key is set are delivered by the drain once it is; the warning that used to say "dropped" now says "staged".

#### Staging a trigger inside a transaction

A caller inside a `$transaction` passes `{ tx, entityRef }` as the trailing option of the `notify*` helper; the helper stages only and returns `{ success: true, staged }`, and the caller runs `attemptTrigger(staged)` from `lib/novu` after the commit. Six call sites are inside transactions: `notifyPaymentFailed` in `lib/payments/webhooks/handlers.ts`; `notifyRefundProcessed`, `notifyDisputeCreated` and `notifyDisputeResolved` in `app/api/webhooks/utils.ts`; and, since #1669, `notifyOrgPayoutFailed` at both payout sites in `lib/payments/payouts/org-payout-service.ts` (`markOrgPayoutFailed` and the completed-then-reversed branch of `markOrgPayoutReversed`), where the bell is staged inside the claim transaction under `entityRef: orgPayout:<id>` and attempted after the commit. The organisation helpers return the list of staged rows rather than a single result, because a roster may be split across timezone batches; the list is empty when the helper attempted inline. Every other `notify*` call site that used to be `void` is now awaited, because an un-awaited trigger is dropped when the Netlify instance freezes after the response (#1616, #691 NTF-1).

The figures that circulated before #1664 ("32 triggers are `void`-fired, 40 run in `after()`") described the pre-#1664 tree and are retired. A repo-wide grep after #1664 and #1669 finds no remaining `void notify*` call. Four sites still hand the call to `after()` — `notifyDocumentUploaded` in the two document-upload routes, `notifyDocumentReviewed` in the document-review route, and `notifyRecordingAvailable` in `lib/stream/recording-handlers.ts` — and on those the staging itself runs inside `after()`, so they remain the last NTF-1 residue; every other call is awaited or staged.

### The Novu relay

`jobs/notifications/drain-notification-outbox.ts` drains `NotificationOutbox` rows whose status is `PENDING`, or `RETRY` with a `nextRetryAt` that has passed, and whose `notBefore` is null or in the past, fifty per tick, through `attemptTrigger(row, { relay: true })`. In relay mode an attempt counts against the row's five, a transient failure schedules `RETRY` on the ladder in `lib/retry/backoff.ts`, and the fifth failure dead-letters. The inline attempt spends none of those five, so the ladder starts from the relay's first try. It runs under the fail-closed cron lock `drain-notification-outbox`, has the CRON_SECRET twin `/api/cleanup/drain-notification-outbox`, and the Netlify ticker posts it with `?limit=20` on every five-minute tick.

### 20+ Exported Trigger Functions

Each exported function in `lib/novu/service.ts` is a thin wrapper over the core triggers with the correct workflow ID:

```
notifyAppointmentBooked(userIds[], payload)      -> triggerForMultiple
notifyAppointmentCancelled(userIds[], payload)    -> triggerForMultiple
notifyAppointmentRescheduled(userIds[], payload)  -> triggerForMultiple
notifyAppointmentCompleted(userIds[], payload)    -> triggerForMultiple
notifyPaymentSuccess(userId, payload)             -> triggerWorkflow
notifyPaymentFailed(userId, payload)              -> triggerWorkflow
notifyRefundProcessed(userId, payload)            -> triggerWorkflow
notifyRefundRequested(adminUserIds[], payload)    -> triggerForMultiple
notifySupportTicketCreated(staffUserIds[], payload)   -> triggerForMultiple
notifySupportTicketUpdate(userId, payload)            -> triggerWorkflow
notifySupportTicketResponse(userId, payload)          -> triggerWorkflow
notifyFeedbackReceived(adminUserIds[], payload)   -> triggerForMultiple
notifyNewReview(consultantUserId, payload)        -> triggerWorkflow
notifyTrialRequested(consultantUserId, payload)  -> triggerWorkflow
notifyTrialScheduled(consulteeUserId, payload)   -> triggerWorkflow
notifyTrialCompleted(userIds[], payload)         -> triggerForMultiple
notifyTrialCancelled(userIds[], payload)         -> triggerForMultiple
notifySubscriptionStarted(userId, payload)        -> triggerWorkflow
notifySubscriptionCancelled(userIds[], payload)   -> triggerForMultiple
notifySubscriptionRenewed(userId, payload)        -> triggerWorkflow
notifyNewBookingRequest(consultantUserId, payload)          -> triggerWorkflow
notifyVerificationStatusChanged(consultantUserId, payload)  -> triggerWorkflow
notifyPayoutProcessed(consultantUserId, payload)            -> triggerWorkflow
notifyPayoutFailed(consultantUserId, payload)               -> triggerWorkflow (deferrable: false)
notifyGeneralAnnouncement(payload)                -> triggerBroadcastWorkflow
notifyNewConsultantApplication(adminUserIds[], payload)  -> triggerForMultiple
notifyDisputeCreated(userIds[], payload)          -> triggerForMultiple
notifyDisputeResolved(userIds[], payload)         -> triggerForMultiple
notifyRecordingAvailable(userIds[], payload)      -> triggerForMultiple
```

---

## Subscriber Management

### Subscriber Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Registered: User signs up
    Registered --> Synced: Registration API calls syncSubscriber()
    Synced --> DashboardSync: useNovuSubscriberSync hook (30-min staleTime)
    DashboardSync --> Synced: Re-sync on dashboard mount
    Synced --> PrefsUpdated: PUT /api/novu/preferences
    PrefsUpdated --> Synced: Channel prefs synced to Novu
    Synced --> Deleted: Account deletion calls deleteSubscriber()
    Deleted --> [*]
```

### Server-Side Sync (`lib/novu/subscriber.ts`)

| Function                                     | Purpose                                   | Called When                                   |
| -------------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| `syncSubscriber(data)`                       | Creates or updates Novu subscriber        | Registration, dashboard mount, profile update |
| `updateSubscriberPreferences(userId, prefs)` | Syncs channel toggles to Novu custom data | Preference update via API                     |
| `deleteSubscriber(userId)`                   | Removes subscriber from Novu              | Account deletion                              |

Subscriber data mapped from User model:

| Novu Field     | Source                         |
| -------------- | ------------------------------ |
| `subscriberId` | `User.id`                      |
| `firstName`    | First word of `User.name`      |
| `lastName`     | Remaining words of `User.name` |
| `email`        | `User.email`                   |
| `phone`        | `User.phone`                   |
| `avatar`       | `User.image`                   |
| `locale`       | `"en"` (hardcoded)             |

### Client-Side Sync (`hooks/useNovuSubscriberSync.ts`)

Uses React Query with aggressive caching to avoid redundant API calls:

```
useQuery({
  queryKey: ["novu-subscriber-sync", session?.user?.id],
  queryFn: () => fetch("/api/novu/subscriber", {method: "POST"}),
  enabled: !!session?.user?.id && !!process.env.NEXT_PUBLIC_NOVU_APP_ID,
  staleTime: 30 * 60 * 1000,     // 30 minutes
  gcTime: 60 * 60 * 1000,        // 1 hour
  retry: 1,
  refetchOnWindowFocus: false,
  refetchOnMount: false,
})
```

### Client-Side Provider (`providers/NovuProvider.tsx`)

Wraps the app with Novu's React SDK. Only renders when both conditions are met:

1. User is authenticated (`session.user.id` exists)
2. `NEXT_PUBLIC_NOVU_APP_ID` env var is configured

When active, provides WebSocket connection for real-time in-app notifications (bell icon, notification center).

---

## Notification Preferences

### Schema (`schemas/user.ts`)

```
NotificationPreferenceSchema:
  allNotifications: boolean (default: true)

  Channel Preferences:
    inAppEnabled: boolean (default: true)
    emailEnabled: boolean (default: true)
    pushEnabled: boolean (default: false)

  Legacy (backward compatibility):
    mentions: boolean (default: false)
    directMessages: boolean (default: false)
    updates: boolean (default: false)

  Category Preferences:
    appointmentReminders: boolean (default: true)
    paymentNotifications: boolean (default: true)
    supportUpdates: boolean (default: true)
    feedbackAlerts: boolean (default: true)
    trialNotifications: boolean (default: true)
    subscriptionAlerts: boolean (default: true)
    marketingEmails: boolean (default: false)

  Quiet Hours:
    quietHoursEnabled: boolean (default: false)
    quietHoursStart: string | null
    quietHoursEnd: string | null
    quietHoursTimezone: string | null
```

### Preference Update Flow

```mermaid
sequenceDiagram
    participant UI as Settings UI
    participant API as PUT /api/novu/preferences
    participant DB as Prisma (NotificationPreference)
    participant Novu as Novu Subscriber API

    UI->>API: PUT {emailEnabled: false, appointmentReminders: false}
    API->>API: Validate with NotificationPreferenceUpdateSchema
    API->>DB: prisma.notificationPreference.upsert()
    DB-->>API: Updated preferences
    alt Channel preference changed
        API->>Novu: updateSubscriberPreferences(userId, {email: false})
        Novu-->>API: OK
    end
    API-->>UI: 200 Updated preferences JSON
```

When no preferences exist yet, `GET /api/novu/preferences` returns hardcoded defaults (all enabled except push and marketing).

### Email gating and one-click unsubscribe

Since #1653 every lifecycle email is gated by `NotificationPreference` at send time. `loadEmailRecipients(userIds, category)` in `lib/email/preferences.ts` reads the recipients' rows in one query and returns an `EmailRecipient` per user with `allowed` already decided, the IANA zone the message should render times in (`User.timezone`, else `Asia/Kolkata`), and a signed unsubscribe URL. The gate reads the database row and not Novu's copy of the flags, because Novu is in-app only and its copy is a mirror written after the fact by `updateSubscriberPreferences()`. A user with no row has never changed anything and gets the defaults, which allow every category. A recipient is allowed when `allNotifications` and `emailEnabled` are both true and the category's own column is not false. The table below lists which column each category reads; the same map, `EMAIL_CATEGORY_COLUMN`, is what `lib/novu/subscriber.ts` uses to write the `category*` flags onto the Novu subscriber, so the two cannot drift.

| Category        | `NotificationPreference` column |
| --------------- | ------------------------------- |
| `appointments`  | `appointmentReminders`          |
| `payments`      | `paymentNotifications`          |
| `subscriptions` | `subscriptionAlerts`            |
| `trials`        | `trialNotifications`            |
| `support`       | `supportUpdates`                |
| `feedback`      | `feedbackAlerts`                |
| `orgBilling`    | `orgBillingAlerts`              |
| `orgMembership` | `orgMembershipAlerts`           |
| `orgProgram`    | `orgProgramAlerts`              |

A `null` category is a required account notice and bypasses the gate entirely: the recipient is always allowed and carries no unsubscribe URL, and the footer says the notice cannot be turned off. Four notices are never gated: an account suspension (`sendAccountSuspendedEmail()`), a ban (`sendAccountBannedEmail()`), an organisation invitation (`sendOrgInvitationEmail()`, whose invitee has no preference row to read) and an SSO certificate expiry (`sendOrgSsoCertExpiringEmail()`), because the reader must act on each of them whether or not they want mail.

One-click unsubscribe follows RFC 8058. `sendToRecipients()` (`lib/email/send-to-recipients.ts`) attaches `List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` to every gated message, so Gmail and Yahoo render their own unsubscribe button and POST to the URL without a click-through. The URL is `/api/notifications/unsubscribe?u=<userId>&t=<token>`, where the token is an HMAC over the user id under the same `WAITLIST_HMAC_SECRET` the newsletter links use (`lib/waitlist/tokens.ts`), bound to its own purpose so a newsletter token cannot be replayed against an account. The token is timeless because an unsubscribe link in a year-old email must still work. `POST` verifies the token, upserts `NotificationPreference` with `emailEnabled = false`, mirrors the flags to Novu the way `PUT /api/novu/preferences` does, and answers `{ ok: true }`; a bad token answers 400 and an id with no user answers 200 all the same, so the route is not an oracle. `GET` is the footer link a human clicks: it verifies the token and redirects to `/email/unsubscribe`, which shows a form that POSTs to the same route, and it flips nothing on its own because link scanners prefetch. One-click turns off the email channel only and leaves the category columns and the in-app bell untouched, because the category columns are shared across channels: the complaint was the inbox, not the bell, and turning off `appointmentReminders` would also silence the in-app reminder. The relay's resend of a staged `FailedEmail` row carries no `List-Unsubscribe` headers, because `stage()` does not persist them; the footer link in the body still works, and the headers return on every inline send.

---

## Side Effects and the Essential Path

Notifications must never fail, roll back or slow down the business change that caused them, and since #1654 the mechanism for that is the outbox rather than fire-and-forget. Example from the payment webhook handler:

```
// In lib/payments/webhooks/handlers.ts
const txResult = await prisma.$transaction(async (tx) => {
  // ... confirm the payment, confirm the appointment ...
  const successEmail = await stagePaymentSuccessEmail(tx, payment, appointment.id, type);
  return { ..., successEmail };
});

// AFTER the transaction commits:
if (txResult.successEmail) {
  await attemptEmail(txResult.successEmail.staged, txResult.successEmail.message, "PAYMENT_SUCCESS", { budgetMs: EMAIL_BUDGET_MS.WEBHOOK });
}
```

This shape guarantees three things:

1. Core business operations (payments, bookings) always succeed even if Resend or Novu is down, because the only thing inside the transaction is a row insert.
2. A rollback takes the outbox row with it, so no email or bell describes a change that never happened.
3. A crash or freeze between the commit and the send cannot lose the message, because the row already exists and the relay finishes it.

Before #1654 the shape was send-first with a dead-letter safety net: `deliver()` awaited one Resend call with no timeout and wrote a `FailedEmail` row only when the call failed, so a slow provider could hold a signup to Netlify's ceiling and a freeze between the commit and the insert lost the email with no trace; Novu triggers were fired without awaiting and simply forgotten on failure (#691 NTF-1). The retry ladder is unchanged: a transient failure is retried by `jobs/email/retry-failed-emails.ts` on the shared schedule of one minute, five minutes, thirty minutes, two hours and eight hours, replaying the same content-hash Idempotency-Key so a Resend-side success that never reached the caller is not re-sent as a duplicate; a terminal failure (dead key, unverified domain, rejected body) is dead-lettered on the first attempt and pages through Sentry at level `"error"`; an `EMAIL_VERIFICATION` row older than 60 minutes or a `PASSWORD_RESET` row older than 30 minutes is dead-lettered without a send, because a stale link is no longer useful to the recipient.

`lib/auth.ts` awaits its senders inside a try/catch, and every `notify*` call site is awaited, because a Netlify instance that freezes immediately after the response is sent drops an un-awaited call before it reaches the provider, which is the same failure class as #1616. The await costs at most the caller's budget, and a budget that runs out leaves a row the relay sends.

The tables behind this shape (the `FailedEmail` provider id and business anchor, `FailedEmailBatch`, the `NotificationOutbox` for Novu triggers) and the Resend webhook tables of #1647 (`EmailEvent`, `EmailSuppression`) are documented column by column in [07-schema-reference.md](07-schema-reference.md); the design rationale and the options that were ruled out are in issue #1654.

---

## Environment Variables

| Variable                             | Side   | Required                                                    | Purpose                                                                                                   |
| ------------------------------------ | ------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`                     | Server | Yes (for emails)                                            | Resend API key for email delivery                                                                         |
| `RESEND_WEBHOOK_SECRET`              | Server | Yes (production only)                                       | Signing secret of the Resend webhook endpoint, verified by `/api/webhooks/resend` (#1647)                 |
| `EMAIL_TRANSACTIONAL_DOMAIN`         | Server | No (defaults to `mail.familiarisenow.com`)                  | Domain for transactional senders (onboarding/security/payments/notifications/finance/dpdp/noreply/system) |
| `EMAIL_NEWSLETTER_DOMAIN`            | Server | No (defaults to `news.familiarisenow.com`)                  | Domain for the waitlist/newsletter sender                                                                 |
| `NEXT_PUBLIC_SUPPORT_EMAIL`          | Both   | No (defaults to `support@familiarisenow.com`)               | Public support mailbox; also the default Reply-To on every send                                           |
| `CONTACT_INBOX_ADDRESS`              | Server | No (defaults to `supportEmail()`)                           | Where `/contactus` inquiries are delivered                                                                |
| `BILLING_EMAIL`                      | Server | No (defaults to `supportEmail()`)                           | Supplier contact printed on tax invoices                                                                  |
| `NEXT_PUBLIC_COMPANY_POSTAL_ADDRESS` | Both   | No (line omitted when unset)                                | Optional postal line in `EmailFooter`                                                                     |
| `NOVU_DEVELOPMENT_KEY`               | Server | Yes (for notifications)                                     | Novu secret key, Development environment                                                                  |
| `NOVU_PRODUCTION_KEY`                | Server | Yes (production only)                                       | Novu secret key, Production environment                                                                   |
| `NEXT_PUBLIC_NOVU_APP_ID`            | Client | Yes (for in-app)                                            | Novu application identifier for React SDK                                                                 |
| `NEXT_PUBLIC_APP_URL`                | Both   | Yes in production; local dev falls back to `localhost:3000` | Base URL for email links (`lib/url.ts` also honours Netlify `DEPLOY_PRIME_URL` / `URL`)                   |

### NPM Packages

| Package        | Version | Purpose                                                                                                        |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `resend`       | ^6.28.0 | Resend Node.js SDK                                                                                             |
| `react-email`  | 6.9.5   | Server-side React Email rendering; replaces the deprecated `@react-email/components` and `@react-email/render` |
| `@novu/api`    | 3.13.0  | Novu server-side SDK                                                                                           |
| `@novu/nextjs` | 3.13.0  | Novu Next.js integration (provider)                                                                            |
| `@novu/react`  | 3.13.0  | Novu React SDK (notification center)                                                                           |
