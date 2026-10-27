# Pre-Production Checklist — Email, Notifications & Newsletter

> Production readiness runbook for outbound email (`lib/email/`), Novu in-app feed notifications (`lib/novu/`), ImprovMX inbound routing, DMARC/SPF/DKIM alignment, scheduled outbox relays, and environment variables.

**Last Updated**: 2026-10-11
**Live Domain**: `familiarisenow.com` (Netlify DNS)

---

## Table of Contents

- [Sending Domains, Inbound Routing & DMARC Architecture](#sending-domains-inbound-routing--dmarc-architecture)
- [Service Free Tier Limits & Quotas](#service-free-tier-limits--quotas)
- [Pre-Launch Checklist (Free Tier, \$0/month)](#pre-launch-checklist-free-tier-0month)
- [DNS Setup for Resend, ImprovMX & DMARC](#dns-setup-for-resend-improvmx--dmarc)
- [Novu Environment & Workflow Configuration](#novu-environment--workflow-configuration)
- [Scheduled Outbox Drains & Sweep Cadences](#scheduled-outbox-drains--sweep-cadences)
- [Environment Variables](#environment-variables)
- [Owner Runbook: Rotating `RESEND_API_KEY`](#owner-runbook-rotating-resend_api_key)
- [When You'll Need to Upgrade](#when-youll-need-to-upgrade)
- [Cost Projection Timeline](#cost-projection-timeline)
- [Deferred Services (Post-Launch)](#deferred-services-post-launch)
- [Deprecated & Superseded Approaches](#deprecated--superseded-approaches)

---

## Sending Domains, Inbound Routing & DMARC Architecture

Outbound mail splits sender reputations across two dedicated Resend subdomains on `familiarisenow.com` (dispatched from Resend region `ap-northeast-1` Tokyo), while inbound operator mailboxes route through ImprovMX on the root apex `@`:

```text
Outbound Transactional & Ops (@mail.familiarisenow.com):
  onboarding@mail.familiarisenow.com     -- Welcome & email verification
  security@mail.familiarisenow.com       -- Password reset/changed, 2FA, SSO, account suspension/ban
  payments@mail.familiarisenow.com       -- Payment links, receipts, failures, refunds, payouts, disputes
  notifications@mail.familiarisenow.com  -- Bookings, reminders, org invites, support replies, reviews
  finance@mail.familiarisenow.com        -- Org billing receipts, invoices, wallet low, overage due
  dpdp@mail.familiarisenow.com           -- DPDP compliance & data-export notifications
  noreply@mail.familiarisenow.com        -- Automated system notifications
  system@mail.familiarisenow.com         -- Familiarise Ops alerts (Reply-To: ops@familiarisenow.com)

Outbound Bulk / Waitlist (@news.familiarisenow.com):
  newsletter@news.familiarisenow.com     -- Waitlist confirmation, welcome & broadcasts

Inbound Operator Mailboxes (@familiarisenow.com via ImprovMX):
  support@familiarisenow.com             -- Default Reply-To & customer support inbox
  ops@familiarisenow.com                 -- Reply-To for ops/canary/quota/compliance alerts (OPS_EMAIL)
  dpdp@familiarisenow.com                -- Privacy & DPDP statutory contact
  billing@familiarisenow.com             -- Supplier invoice & finance contact
  dmarc@familiarisenow.com               -- Aggregate DMARC reports (rua=mailto:dmarc@familiarisenow.com)
```

---

## Service Free Tier Limits & Quotas

### Resend (Email Delivery)

| Feature                       | Free        | Pro (\$20/mo)          | Scale (\$90/mo)        |
| ----------------------------- | ----------- | ---------------------- | ---------------------- |
| Emails/month                  | 3,000       | 50,000                 | 100,000                |
| **Daily limit**               | **100/day** | No limit               | No limit               |
| Custom verified subdomains    | Yes         | Yes                    | Yes                    |
| Svix delivery/bounce webhooks | Yes         | Yes                    | Yes                    |
| Analytics UI (opens/clicks)   | No          | Yes                    | Yes                    |
| Overage                       | Blocked     | Pay-as-you-go (5x cap) | Pay-as-you-go (5x cap) |

**Operational notes on the 100/day free cap:**

- Each booking triggers confirmation emails to active participants plus pre-session reminders.
- Waitlist broadcasts count toward the daily limit and use `FailedEmailBatch` chunking with `EmailSuppression` pre-filtering.
- Delivery events (`email.bounced`, `email.complained`, `email.suppressed`, `contact.*`, `domain.*`) stream continuously on the free tier via `POST /api/webhooks/resend` into `EmailEvent`, `EmailSuppression`, `Waitlist`, and `SystemEvent`.

### Novu (In-App Feed Orchestration)

| Feature                     | Free                                     | Pro (~\$25–30/mo) |
| --------------------------- | ---------------------------------------- | ----------------- |
| Events/month                | ~10,000                                  | 30,000            |
| In-app feed + WebSocket     | Yes (HMAC subscriber hash secured)       | Yes               |
| Email channel               | Unused — all 16 families are in-app only | Unused            |
| Activity feed retention     | 7 days                                   | 30 days           |
| Subscribers                 | Unlimited                                | Unlimited         |
| Active workflows per tenant | 20 (16 families deployed)                | 20 (100 on Team)  |

**Development vs. Production Tenants:**

- Novu's Development and Production environments are fully isolated tenants with distinct workflows, subscribers, and secret keys.
- `lib/novu/secret-key.ts` selects `NOVU_PRODUCTION_KEY` when `NEXT_PUBLIC_SENTRY_ENVIRONMENT=production` (Netlify production deploys and GitHub Actions crons) and `NOVU_DEVELOPMENT_KEY` everywhere else.
- `/api/novu/subscriber` authenticates subscribers via deterministic HMAC-SHA256 hashes (`computeSubscriberHash(subscriberId)` in `lib/novu/subscriber.ts`).

---

## Pre-Launch Checklist (Free Tier, \$0/month)

### Step 1: Domain & Inbound Forwarding

- [x] Subdomain architecture active in `lib/email/config.ts`: `mail.familiarisenow.com` (transactional/ops) and `news.familiarisenow.com` (newsletter)
- [ ] Configure ImprovMX forwarding for `support@`, `ops@`, `dpdp@`, `billing@`, and `dmarc@` on `familiarisenow.com`
- [ ] Publish root SPF (`v=spf1 -all`) and DMARC (`v=DMARC1; p=quarantine; rua=mailto:dmarc@familiarisenow.com`) TXT records in Netlify DNS

### Step 2: Resend Subdomain Verification & Webhook Registration

- [ ] Verify both `mail.familiarisenow.com` and `news.familiarisenow.com` in Resend (`ap-northeast-1` Tokyo)
- [ ] Register Svix webhook endpoint `https://familiarisenow.com/api/webhooks/resend` for `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.suppressed`, `email.failed`, `contact.*`, and `domain.*`
- [ ] Store signing secret `whsec_...` in Netlify production `RESEND_WEBHOOK_SECRET`

### Step 3: Novu Tenant Sync & Subscriber HMAC

- [ ] Run `npm run novu:sync -- --dry-run` followed by `npm run novu:sync` to sync all 16 workflow families to Development, then promote to Production (`npm run novu:sync -- --env production`)
- [ ] Verify `npm run novu:check` exits `0` with zero drift
- [ ] Enable HMAC encryption in Novu Dashboard → In-App Integration settings to pair with `computeSubscriberHash(subscriberId)`

### Step 4: Database Schema & SQL Sidecars

- [ ] Confirm zero schema drift via `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
- [ ] Have an operator deliberately apply `prisma/sql/check-constraints.sql` against the target environment (`FailedEmail_active_outbox_idx`, `FailedEmailBatch_active_outbox_idx`, `NotificationOutbox_active_outbox_idx`, `FailedEmail_sent_unscrubbed_updatedAt_idx`, `SystemJobExecution_running_jobName_key`) — never execute autonomously against the shared database

### Step 5: Environment Variables & Pre-Launch Delivery Guard Cutover

- [ ] Confirm all required environment variables are configured in Netlify Dashboard and GitHub Actions secrets
- [ ] **Launch Cutover Gate**: Flip `EMAIL_DELIVERY_MODE=live` in both Netlify production env vars and GitHub Actions repository variables (`cron-intra-day.yml`, `cron-daily.yml`) when opening public traffic (while unset or `allowlist`, external recipients are held safely as `DEAD_LETTER` `held:pre-launch` in `FailedEmail`)

### Step 6: Smoke Test Verification

- [ ] Sign up with a real mailbox or Resend test address (`delivered@resend.dev`) — never `example.com` (immediately dead-lettered by `terminalSendReason` on attempt 1)
- [ ] Confirm welcome email arrives with valid DKIM/SPF/DMARC pass headers
- [ ] Confirm lifecycle email footer link (`GET /api/notifications/unsubscribe`) renders confirmation UI without mutating DB, and one-click `POST` disables email while preserving in-app notifications
- [ ] Confirm waitlist footer link (`GET /api/waitlist/unsubscribe`) renders confirmation form without mutating DB, and `POST` unsubscribes immediately
- [ ] Trigger a test booking event and verify `flushNotificationsAfter` delivers both the Novu bell and Resend email

---

## DNS Setup for Resend, ImprovMX & DMARC

Publish all records below in **Netlify DNS** (`familiarisenow.com` zone):

| Type | Host                     | Value                                                         | Purpose                                                    |
| ---- | ------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| MX   | `@`                      | `mx1.improvmx.com` (priority 10), `mx2.improvmx.com` (20)     | Inbound forwarding (`support@`, `ops@`, `dpdp@`, `dmarc@`) |
| TXT  | `@`                      | `v=spf1 -all`                                                 | Prevents spoofing on non-sending root apex                 |
| TXT  | `_dmarc`                 | `v=DMARC1; p=quarantine; rua=mailto:dmarc@familiarisenow.com` | Enforces domain DMARC policy & aggregate reports           |
| TXT  | `resend._domainkey.mail` | `p=MIGfMA0GCSq...` (from Resend dashboard)                    | DKIM public key for transactional mail                     |
| TXT  | `send.mail`              | `v=spf1 include:amazonses.com ~all`                           | SPF authorization for transactional envelope sender        |
| MX   | `send.mail`              | `feedback-smtp.ap-northeast-1.amazonses.com` (priority 10)    | Return-Path bounce handling for transactional mail         |
| TXT  | `resend._domainkey.news` | `p=MIGfMA0GCSq...` (from Resend dashboard)                    | DKIM public key for newsletter mail                        |
| TXT  | `send.news`              | `v=spf1 include:amazonses.com ~all`                           | SPF authorization for newsletter envelope sender           |
| MX   | `send.news`              | `feedback-smtp.ap-northeast-1.amazonses.com` (priority 10)    | Return-Path bounce handling for newsletter mail            |

---

## Novu Environment & Workflow Configuration

1. **In-App Only Topology**: All 16 Novu workflow families contain only an in-app step (`lib/novu/templates/`). Do not configure an email integration inside Novu.
2. **Declarative Sync & Drift Guard**:
   - `npm run novu:sync -- --dry-run`: Previews workflow updates.
   - `npm run novu:sync`: Syncs `lib/novu/templates/` to Development (`--env production` promotes to Production).
   - `npm run novu:check`: Verifies live Novu workflows match code manifests in CI.
3. **Dual-Layer Preference Gating**:
   - **Pre-Stage Database Gate (`stageBell`)**: Filters out `EMAIL_ONLY`, `NEITHER`, `allNotifications: false`, `inAppEnabled: false`, and muted category columns before inserting into `NotificationOutbox`, while calculating quiet-hours `notBefore`.
   - **Subscriber Custom Data Gate (`buildSubscriberCustomData` & `updateSubscriberPreferences`)**: Upserts subscriber flags idempotently via `novu.subscribers.create(...)` and propagates DB errors fail-closed so transient outages never re-enable muted users.

---

## Scheduled Outbox Drains & Sweep Cadences

Sub-hourly latency-sensitive relays run on the phase-staggered Netlify scheduled function (`netlify/functions/cron-tick.mts`, `*/5 * * * *`), while batch maintenance jobs run in GitHub Actions (`.github/workflows/cron-intra-day.yml`, `cron-daily.yml`, `cron-weekly.yml`):

| Job Target                    | Driver          | Cadence & Offset                                      | Batch / Timeout        | Purpose                                                           |
| ----------------------------- | --------------- | ----------------------------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `drain-notification-outbox`   | `cron-tick.mts` | Every **10m** at offset **`:05`**                     | `limit=20`, `20s` cap  | Replays due `NotificationOutbox` rows (`notBefore <= now`)        |
| `retry-failed-emails`         | `cron-tick.mts` | Every **15m** at offset **`:00`**                     | `limit=20`, `20s` cap  | Replays due `FailedEmail` & `FailedEmailBatch` with RFC 8058 hdrs |
| `appointment-reminders`       | `cron-tick.mts` | Every **15m** at offset **`:10`**                     | `limit=25`, `20s` cap  | Dispatches pre-session email & in-app appointment reminders       |
| `auto-complete-appointments`  | `cron-tick.mts` | Every **30m** at offset **`:15`**                     | `limit=25`, `20s` cap  | Auto-completes past sessions and triggers post-session flows      |
| `prune-system-job-executions` | `cron-tick.mts` | Every **30m** at offset **`:25`**, 20:00 to 23:30 UTC | `limit=500`, `24s` cap | Scrubs `SENT` email HTML/text after 7d; prunes terminal rows      |

Every target routes through `/api/cleanup/[job]`, authenticates via `CRON_SECRET`, and acquires an atomic Postgres lease on `SystemJobExecution` (`withCronLock`).

---

## Environment Variables

Set these in **Netlify Dashboard → Site → Environment Variables** (and matching GitHub Actions secrets/variables where noted):

| Variable                     | Value / Source                                               | Required                                                 |
| ---------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`        | `https://familiarisenow.com`                                 | Yes                                                      |
| `EMAIL_DELIVERY_MODE`        | `live` at launch (defaults to `allowlist` pre-launch)        | Yes (Netlify + GitHub Actions variables)                 |
| `EMAIL_ALLOWLIST`            | Comma-separated emails/`@domains` allowed pre-launch         | Optional (used when `EMAIL_DELIVERY_MODE != live`)       |
| `RESEND_API_KEY`             | Resend API key (`re_...`)                                    | Yes (Netlify + GitHub Actions secrets)                   |
| `RESEND_WEBHOOK_SECRET`      | Svix signing secret (`whsec_...`)                            | Yes (Netlify production context)                         |
| `EMAIL_TRANSACTIONAL_DOMAIN` | `mail.familiarisenow.com`                                    | Optional (default)                                       |
| `EMAIL_NEWSLETTER_DOMAIN`    | `news.familiarisenow.com`                                    | Optional (default)                                       |
| `NEXT_PUBLIC_SUPPORT_EMAIL`  | `support@familiarisenow.com`                                 | Optional (default)                                       |
| `CONTACT_INBOX_ADDRESS`      | Defaults to `NEXT_PUBLIC_SUPPORT_EMAIL`                      | Optional                                                 |
| `BILLING_EMAIL`              | `billing@familiarisenow.com` (fallback: `supportEmail()`)    | Optional                                                 |
| `OBSERVABILITY_ALERT_EMAIL`  | Ops recipient for Sentry canary/quota alerts                 | Optional (fallback: `supportEmail()`)                    |
| `DATABREACH_ALERT_EMAIL`     | Compliance recipient for DPDP 72h alerts                     | Yes                                                      |
| `MSME_ALERT_EMAIL`           | Finance recipient for MSME Section 43B(h) alerts             | Yes                                                      |
| `SLACK_OPS_WEBHOOK_URL`      | Slack incoming webhook for dead-letter & ops fallback alerts | Optional (recommended)                                   |
| `NOVU_DEVELOPMENT_KEY`       | Novu Development secret key                                  | Yes                                                      |
| `NOVU_PRODUCTION_KEY`        | Novu Production secret key                                   | Yes (Netlify production + GitHub Actions secrets)        |
| `NEXT_PUBLIC_NOVU_APP_ID`    | Novu Application Identifier                                  | Yes                                                      |
| `CRON_SECRET`                | `openssl rand -hex 32`                                       | Yes (Netlify + GitHub Actions secrets)                   |
| `WAITLIST_HMAC_SECRET`       | `openssl rand -hex 32`                                       | Yes (signs stateless email & waitlist unsubscribe links) |

---

## Owner Runbook: Rotating `RESEND_API_KEY`

Rotate `RESEND_API_KEY` across all four locations in lockstep so no environment dead-letters messages with 401 errors:

1. **Netlify Production**: Site configuration → Environment variables → `RESEND_API_KEY`.
2. **GitHub Actions Secret**: `gh secret set RESEND_API_KEY` (used by scheduled CLI/backstop jobs).
3. **Local `.env`**: Update local developer workspace.
4. **`.mcp.json`**: Update local MCP Resend configuration.
5. **Redeploy & Verify**: Trigger a deploy on Netlify, send a test transactional email, verify zero new `DEAD_LETTER` rows in `FailedEmail`, and resolve any `["email-send-terminal", "invalid_api_key"]` Sentry alerts.

---

## When You'll Need to Upgrade

- **Resend Free → Pro (\$20/mo)**: When daily volume regularly exceeds ~80 emails/day, newsletter broadcasts exceed 100 subscribers in a single blast, or native Resend open/click analytics are required.
- **Novu Free → Pro (~\$25–30/mo)**: When monthly triggers exceed ~10,000 events/month or in-app feed history retention beyond 7 days is required.
- **Kit / Directus CMS**: Remain deferred post-launch (`lib/newsletter/convertkit.ts` and `app/api/webhooks/directus/route.ts`) until automated drip sequences or managed CMS publishing are prioritized.

---

## Cost Projection Timeline

| Phase                               | Resend  | Novu    | Kit  | Directus | Total            |
| ----------------------------------- | ------- | ------- | ---- | -------- | ---------------- |
| **Launch (Month 1)**                | \$0     | \$0     | \$0  | \$0      | **\$0/mo**       |
| **Early Growth (Month 2–3)**        | \$20    | \$0     | \$0  | \$0      | **\$20/mo**      |
| **Active Users (Month 3–6)**        | \$20    | \$25    | \$0  | \$0      | **\$45/mo**      |
| **Content + Newsletter (Month 6+)** | \$20    | \$25    | \$0  | \$25     | **\$70/mo**      |
| **Full Scale (Month 12+)**          | \$20–90 | \$25–50 | \$39 | \$25     | **\$109–204/mo** |

_Kit free tier covers 10K subscribers. Creator (\$39/mo) is only needed for automated drip sequences._

**Note:** These costs are separate from the shared platform stack (Supabase, Stream.io, Upstash, Sentry).

---

## Deprecated & Superseded Approaches

- **Sending From Unowned `@familiarise.com` & Unrouted Root Mailboxes**: Replaced by `mail.familiarisenow.com` and `news.familiarisenow.com` verified in Resend (`ap-northeast-1`), paired with ImprovMX inbound routing on `@familiarisenow.com` and `_dmarc` `p=quarantine`.
- **Standalone Sub-Hourly GitHub Actions Workflows (`cron-notifications.yml`, `cron-auto-complete.yml`)**: Superseded by phase-staggered dispatch in `netlify/functions/cron-tick.mts` (`drain-notification-outbox` every 10m at `:05`, `retry-failed-emails` every 15m at `:00`, `appointment-reminders` every 15m at `:10`, `auto-complete-appointments` every 30m at `:15`), avoiding GitHub Actions sub-hourly scheduling lag and duplicate cron workflows.
- **Replaying 422 Invalid-Domain Sends Across Backoff**: Superseded by `terminalSendReason()` dead-lettering 422 validation errors immediately on attempt 1.
