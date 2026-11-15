# Pre-Production Checklist — Email, Notifications & Newsletter

> Production readiness runbook for outbound email (`lib/email/`), Novu in-app feed notifications (`lib/novu/`), DMARC/SPF/DKIM alignment, scheduled outbox relays, and environment variables.

**Last Updated**: 2026-11-06
**Live Domain**: `familiarisenow.com` (Netlify DNS)

---

## Table of Contents

- [Sending Domains & DMARC Architecture](#sending-domains--dmarc-architecture)
- [Service Free Tier Limits & Quotas](#service-free-tier-limits--quotas)
- [Pre-Launch Checklist (Free Tier, \$0/month)](#pre-launch-checklist-free-tier-0month)
  - [Step 7: Outbox Cutover Recount (no backfill)](#step-7-outbox-cutover-recount-no-backfill)
- [DNS Setup for Resend & DMARC](#dns-setup-for-resend--dmarc)
- [Novu Environment & Workflow Configuration](#novu-environment--workflow-configuration)
- [Scheduled Outbox Drains & Sweep Cadences](#scheduled-outbox-drains--sweep-cadences)
- [Environment Variables](#environment-variables)
- [Owner Runbook: Rotating `RESEND_API_KEY`](#owner-runbook-rotating-resend_api_key)
- [When You'll Need to Upgrade](#when-youll-need-to-upgrade)
- [Cost Projection Timeline](#cost-projection-timeline)
- [Deferred Services (Post-Launch)](#deferred-services-post-launch)
- [Deprecated & Superseded Approaches](#deprecated--superseded-approaches)

---

## Sending Domains & DMARC Architecture

Outbound mail splits sender reputations across two dedicated Resend subdomains on `familiarisenow.com` (dispatched from Resend region `ap-northeast-1` Tokyo), while `familiarisenow.com` itself is send-only (it publishes a null MX) and every inbound address is `connect@practitionist.com` (`SUPPORT_EMAIL`):

```text
Outbound Transactional & Ops (@mail.familiarisenow.com):
  onboarding@mail.familiarisenow.com     -- Welcome & email verification
  security@mail.familiarisenow.com       -- Password reset/changed, 2FA, SSO, account suspension/ban
  payments@mail.familiarisenow.com       -- Payment links, receipts, failures, refunds, payouts, disputes
  notifications@mail.familiarisenow.com  -- Bookings, reminders, org invites, support replies, reviews
  finance@mail.familiarisenow.com        -- Org billing receipts, invoices, wallet low, overage due
  dpdp@mail.familiarisenow.com           -- DPDP compliance & data-export notifications
  noreply@mail.familiarisenow.com        -- Automated system notifications
  system@mail.familiarisenow.com         -- Familiarise Ops alerts (Reply-To: connect@practitionist.com)

Outbound Bulk / Newsletter (@news.familiarisenow.com):
  newsletter@news.familiarisenow.com     -- Newsletter confirmation, welcome & broadcasts

Inbound (practitionist.com):
  connect@practitionist.com              -- The one live mailbox (SUPPORT_EMAIL): Reply-To, support, contact, billing, grievance and compliance alerts
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
- Newsletter broadcasts count toward the daily limit and use `FailedEmailBatch` chunking with `EmailSuppression` pre-filtering.
- Delivery events (`email.bounced`, `email.complained`, `email.suppressed`, `contact.*`, `domain.*`) stream continuously on the free tier via `POST /api/webhooks/resend` into `EmailEvent`, `EmailSuppression`, `NewsletterSubscriber`, and `SystemEvent`.

### Novu (In-App Feed Orchestration)

| Feature                     | Free                                     | Pro (~\$25–30/mo) |
| --------------------------- | ---------------------------------------- | ----------------- |
| Workflow runs/month         | 10,000, one run per bell recipient       | Higher            |
| In-app feed + WebSocket     | Yes (HMAC subscriber hash secured)       | Yes               |
| Email channel               | Unused — all 16 families are in-app only | Unused            |
| Activity feed retention     | 24 hours                                 | Longer            |
| Subscribers                 | Unlimited                                | Unlimited         |
| Active workflows per tenant | 20 (16 families deployed)                | 20 (100 on Team)  |

**Development vs. Production Tenants:**

- Novu's Development and Production environments are separate tenants with distinct workflows, subscribers, and secret keys, but the monthly workflow-run quota is counted across both, so Development testing spends the same 10,000 runs. Keep it small. The plan limits are recorded in `.claude/skills/billing-guardrails/references/novu.md`.
- `lib/novu/secret-key.ts` selects `NOVU_PRODUCTION_KEY` when `NEXT_PUBLIC_SENTRY_ENVIRONMENT=production` (Netlify production deploys, including the ticker-run crons) and `NOVU_DEVELOPMENT_KEY` everywhere else.
- `/api/novu/subscriber` authenticates subscribers via deterministic HMAC-SHA256 hashes (`computeSubscriberHash(subscriberId)` in `lib/novu/subscriber.ts`).

---

## Pre-Launch Checklist (Free Tier, \$0/month)

### Step 1: Domain & Inbound Forwarding

- [x] Subdomain architecture active in `lib/email/config.ts`: `mail.familiarisenow.com` (transactional/ops) and `news.familiarisenow.com` (newsletter)
- [x] `familiarisenow.com` is send-only: its null MX (`0 .`) is live, and all inbound mail goes to `connect@practitionist.com`
- [x] Root SPF `v=spf1 -all` and DMARC `p=none` with `rua=mailto:connect@practitionist.com` are live (verified 2026-10-28)
- [ ] Owner: add TXT `familiarisenow.com._report._dmarc` = `v=DMARC1` in the `practitionist.com` zone at GoDaddy, and confirm auto-renew on both domains (see [Domains and DNS records](../deployment/README.md#domains-and-dns-records))
- [ ] After about two weeks of clean reports, raise DMARC to `quarantine`, then `reject`

### Step 2: Resend Subdomain Verification & Webhook Registration

- [ ] Verify both `mail.familiarisenow.com` and `news.familiarisenow.com` in Resend (`ap-northeast-1` Tokyo)
- [ ] Register Svix webhook endpoint `https://familiarisenow.com/api/webhooks/resend` for `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.suppressed`, `email.failed`, `contact.*`, and `domain.*`
- [ ] Store signing secret `whsec_...` in Netlify production `RESEND_WEBHOOK_SECRET`

### Step 3: Novu Tenant Sync & Subscriber HMAC

Done on 2026-11-08 for Production, in the window of the production release promotion that carried the single-preference-owner change (an earlier Production sync would have fought the old production code, which still wrote subscriber preferences).

- [x] Development: `npm run novu:sync -- --dry-run` followed by `npm run novu:sync`, to sync all 16 workflow families
- [x] Production: the same sequence with `--env production`; all 16 families applied on 2026-11-08. The native-mute reset found 0 mutes across 86 subscribers, and the profile-data scrub cleared 24 of 86 subscribers, with a follow-up dry run of 0
- [x] After the domain-notices change (decision 17), `npm run novu:sync` ran in Development and, at the release, with `--env production`, so `payout-clawback`, `org-payout-clawback` and the new referral copy reached the `payout`, `org-billing`, `referral` and `payment` families
- [ ] After the required-notices change ([the 2026-11-15 record](../decisions/2026-11-15-required-notices-and-deadline-alerts.md)) merges, the owner runs `npm run novu:sync -- --dry-run`, `npm run novu:sync` and two clean `npm run novu:check` runs five minutes apart in Development, and the same with `--env production` at the release promotion. The sync rewrites the `trial` family (the unsent `trial-session-requested` branch removed, the corrected `trial-refunded` description, the "Continue with {expert}" copy of `trial-session-completed`) and the `appointment` family (the request-expiring and refund-time copy of `new-booking-request`, the answer-by and moved-sessions copy of `appointment-rescheduled`)
- [x] `npm run novu:check -- --env production` exited `0` with zero drift on two runs (08:29 and 08:34 UTC). Novu's read API serves stale workflows for about three minutes after a sync, so wait five minutes and expect two clean runs in a row after any future sync.
- [x] HMAC encryption is enabled on the Production In-App integration (Novu Dashboard, In-App Integration settings) to pair with `computeSubscriberHash(subscriberId)`, and verified by behaviour on 2026-11-08: an inbox session with no hash or a wrong hash gets 400 "Please provide a valid HMAC hash", and the correct hash gets 201

### Step 4: Database Schema & SQL Sidecars

- [ ] Confirm zero schema drift via `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
- [ ] Have an operator deliberately apply `prisma/sql/check-constraints.sql` against the target environment (`FailedEmail_active_outbox_idx`, `FailedEmailBatch_active_outbox_idx`, `NotificationOutbox_active_outbox_idx`, `FailedEmail_sent_unscrubbed_updatedAt_idx`, `SystemJobExecution_running_jobName_key`) — never execute autonomously against the shared database

### Step 5: Environment Variables & Pre-Launch Delivery Guard Cutover

- [ ] Confirm all required environment variables are configured in Netlify Dashboard and GitHub Actions secrets
- [ ] Move Resend from Free to Pro on the first purchase trigger (the first marketing batch, daily volume approaching the Free cap, or go-live with more than a handful of active experts; the triggers are kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend)): Free stops sending at 100 emails a day (see [Resend billing guardrails](../../.claude/skills/billing-guardrails/references/resend.md#5-when-to-move-to-pro))
- [ ] **Launch Cutover Gate**: Flip `EMAIL_DELIVERY_MODE=live` in the production env vars of the active application host and of the standby Netlify site (every scheduled job that sends mail runs on the Netlify ticker, so no Actions variable is read by a cron job) when opening public traffic (while unset or `allowlist`, external recipients are held safely as `DEAD_LETTER` `held:pre-launch` in `FailedEmail`)

### Step 6: Smoke Test Verification

- [ ] Sign up with a real mailbox or Resend test address (`delivered@resend.dev`) — never `example.com` (immediately dead-lettered by `terminalSendReason` on attempt 1)
- [ ] Confirm welcome email arrives with valid DKIM/SPF/DMARC pass headers
- [ ] Confirm lifecycle email footer link (`GET /api/notifications/unsubscribe`) renders confirmation UI without mutating DB, and one-click `POST` disables email while preserving in-app notifications
- [ ] Confirm newsletter footer link (`GET /api/newsletter/unsubscribe`) renders confirmation form without mutating DB, and `POST` unsubscribes immediately and withdraws the `MARKETING_COMMS` consent artifact
- [ ] Trigger a test booking event and verify `flushNotificationsAfter` delivers both the Novu bell and Resend email

### Step 7: Outbox Cutover Recount (no backfill)

Done on 2026-11-08. The earlier bell sender keyed a whole `NotificationOutbox` row by its `transactionId`; the current one keys each recipient's event by `<transactionId>:<recipient hash>` under generation-scoped Idempotency-Keys. A row the earlier sender had attempted but never settled might already have been accepted by Novu, so the relay carried two temporary dead-letter guards (`review:legacy_delivery_format` and `review:legacy_broadcast`) until the recount proved no such row existed. They are now deleted. The current relay claims the `firstAttemptAt` anchor with a conditional update before any Novu request and resets it together with `lastError`, so a row with an error but no anchor was never sent and sends normally.

No `firstAttemptAt` backfill was needed: on 2026-11-06 and again on 2026-11-08 the live database held zero `PENDING` or `RETRY` rows in `FailedEmail`, `FailedEmailBatch` and `NotificationOutbox`.

- [x] Recount read-only on the production database (an operator query, never an agent write); keep it for any future cutover:

  ```sql
  SELECT 'FailedEmail' AS tbl, status, count(*) FROM "FailedEmail"
    WHERE status IN ('PENDING', 'RETRY') GROUP BY status
  UNION ALL
  SELECT 'FailedEmailBatch', status, count(*) FROM "FailedEmailBatch"
    WHERE status IN ('PENDING', 'RETRY') GROUP BY status
  UNION ALL
  SELECT 'NotificationOutbox', status, count(*) FROM "NotificationOutbox"
    WHERE status IN ('PENDING', 'RETRY') GROUP BY status;
  ```

- [x] All three counts were zero, so the release went ahead and the cleanup PR deleted `LEGACY_DELIVERY_FORMAT` and `LEGACY_BROADCAST` in `lib/novu/outbox.ts`, the `clear-native-mutes` script and the `scrub-subscriber-pii` script.

---

## DNS Setup for Resend & DMARC

All records are live in **Netlify DNS** (`familiarisenow.com` zone); the authoritative list is in [Domains and DNS records](../deployment/README.md#domains-and-dns-records). Per sending subdomain (`mail` and `news`) the zone holds:

| Type  | Host                      | Value                                             | Purpose                       |
| ----- | ------------------------- | ------------------------------------------------- | ----------------------------- |
| TXT   | `resend._domainkey.<sub>` | DKIM public key (from the Resend dashboard)       | Signs mail from the subdomain |
| MX    | `send.<sub>`              | `feedback-smtp.ap-northeast-1.amazonses.com` (10) | Return-Path bounce handling   |
| TXT   | `send.<sub>`              | `v=spf1 include:amazonses.com ~all`               | SPF for the envelope sender   |
| CNAME | `rsend.<sub>`             | `send.forge.rmta.net`                             | Resend tracking host          |

The apex carries SPF `v=spf1 -all`, a null MX `0 .`, and `_dmarc` is `v=DMARC1; p=none; rua=mailto:connect@practitionist.com; fo=1`.

---

## Novu Environment & Workflow Configuration

1. **In-App Only Topology**: All 16 Novu workflow families contain only an in-app step (`lib/novu/templates/`). Do not configure an email integration inside Novu.
2. **Declarative Sync & Drift Guard**:
   - `npm run novu:sync -- --dry-run`: Previews workflow updates.
   - `npm run novu:sync`: Syncs `lib/novu/templates/` to Development (`--env production` writes Production, at the release promotion).
   - `npm run novu:check`: Verifies live Novu workflows match code manifests in CI.
3. **Server-Side Preference Gating (Postgres is the only owner)**:
   - **Stage and attempt gates (`stageBell`, `currentBellRecipients`)**: Filter out `allNotifications: false`, `inAppEnabled: false`, erased users and muted category columns before inserting into `NotificationOutbox`, and again at the first attempt, which freezes the allowed set.
   - **Novu holds no preference state**: families sync always-on and read-only with no step conditions. The sync makes the families read-only. Native mutes saved on Novu's old preference page were reset once per environment before that (see Deprecated & Superseded Approaches); Production had none.

---

## Scheduled Outbox Drains & Sweep Cadences

Sub-hourly latency-sensitive relays run on the phase-staggered Netlify scheduled function (`netlify/functions/cron-tick.mts`, `*/5 * * * *`), and so do the daily and weekly batch maintenance jobs: no GitHub Actions workflow schedules a registry job:

| Job Target                    | Driver          | Cadence & Offset                                      | Batch / Timeout        | Purpose                                                            |
| ----------------------------- | --------------- | ----------------------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `drain-notification-outbox`   | `cron-tick.mts` | Every **10m** at offset **`:05`**                     | `limit=100`, `24s` cap | Replays due `NotificationOutbox` rows (`notBefore <= now`)         |
| `retry-failed-emails`         | `cron-tick.mts` | Every **15m** at offset **`:05`**                     | `limit=20`, `20s` cap  | Replays due `FailedEmail` & `FailedEmailBatch` with RFC 8058 hdrs  |
| `novu-step-failure-probe`     | `cron-tick.mts` | Every **2h** at offset **`:10`**, 4 h window          | 10 pages, `20s` cap    | Dead-letters in-app steps that failed inside Novu after acceptance |
| `appointment-reminders`       | `cron-tick.mts` | Every **15m** at offset **`:10`**                     | `limit=25`, `20s` cap  | Dispatches pre-session email & in-app appointment reminders        |
| `auto-complete-appointments`  | `cron-tick.mts` | Every **30m** at offset **`:15`**                     | `limit=25`, `24s` cap  | Auto-completes past sessions and triggers post-session flows       |
| `prune-system-job-executions` | `cron-tick.mts` | Every **30m** at offset **`:25`**, 20:00 to 23:30 UTC | `limit=500`, `24s` cap | Scrubs `SENT` email HTML/text after 7d; prunes terminal rows       |

Every target routes through `/api/cleanup/[job]`, authenticates via `CRON_SECRET`, and acquires an atomic Postgres lease on `SystemJobExecution` (`withCronLock`).

---

## Environment Variables

Set these in **Netlify Dashboard → Site → Environment Variables** (and matching GitHub Actions secrets/variables where noted):

| Variable                    | Value / Source                                                                              | Required                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`       | `https://familiarisenow.com`                                                                | Yes                                                      |
| `EMAIL_DELIVERY_MODE`       | `live` at launch (defaults to `allowlist` pre-launch)                                       | Yes (Netlify + GitHub Actions variables)                 |
| `EMAIL_ALLOWLIST`           | Comma-separated emails/`@domains` allowed pre-launch (includes `connect@practitionist.com`) | Optional (used when `EMAIL_DELIVERY_MODE != live`)       |
| `RESEND_API_KEY`            | Resend API key (`re_...`)                                                                   | Yes (Netlify + GitHub Actions secrets)                   |
| `RESEND_WEBHOOK_SECRET`     | Svix signing secret (`whsec_...`)                                                           | Yes (Netlify production context)                         |
| `OBSERVABILITY_ALERT_EMAIL` | Ops recipient for Sentry canary/quota alerts                                                | Optional (fallback: `supportEmail()`)                    |
| `SLACK_OPS_WEBHOOK_URL`     | Slack incoming webhook for dead-letter & ops fallback alerts                                | Optional (recommended)                                   |
| `NOVU_DEVELOPMENT_KEY`      | Novu Development secret key                                                                 | Yes                                                      |
| `NOVU_PRODUCTION_KEY`       | Novu Production secret key                                                                  | Yes (Netlify production + GitHub Actions secrets)        |
| `NEXT_PUBLIC_NOVU_APP_ID`   | Novu Application Identifier                                                                 | Yes                                                      |
| `CRON_SECRET`               | `openssl rand -hex 32`                                                                      | Yes (Netlify + GitHub Actions secrets)                   |
| `BETTER_AUTH_SECRET`        | Already set for sign-in; it also derives the key that signs every emailed link              | Yes (rotating it voids newsletter and unsubscribe links) |

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

- **Resend Free → Pro (\$20/mo)**: On the owner's purchase triggers (kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend)): typically daily volume approaching the Free cap of 100 emails a day, a newsletter broadcast larger than the Free plan allows, or a need for native Resend open/click analytics.
- **Novu Free → Pro (~\$25–30/mo)**: When monthly workflow runs (one per bell recipient, Development and Production together) pass the upgrade trigger kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend), or when activity history beyond the Free plan's 24 hours is required.
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

- **Sending From Unowned `@familiarise.com` & Unrouted Root Mailboxes**: Replaced by `mail.familiarisenow.com` and `news.familiarisenow.com` verified in Resend (`ap-northeast-1`), with the live `_dmarc` policy at `p=none`.
- **Standalone Sub-Hourly GitHub Actions Workflows (`cron-notifications.yml`, `cron-auto-complete.yml`)**: Superseded by phase-staggered dispatch in `netlify/functions/cron-tick.mts` (`drain-notification-outbox` every 10m at `:05`, `retry-failed-emails` every 15m at `:05`, `appointment-reminders` every 15m at `:10`, `auto-complete-appointments` every 30m at `:15`), avoiding GitHub Actions sub-hourly scheduling lag and duplicate cron workflows.
- **Replaying 422 Invalid-Domain Sends Across Backoff**: Superseded by `terminalSendReason()` dead-lettering 422 validation errors immediately on attempt 1.
- **Env-driven sender domains and contact addresses**: `EMAIL_TRANSACTIONAL_DOMAIN`, `EMAIL_NEWSLETTER_DOMAIN`, `NEXT_PUBLIC_SUPPORT_EMAIL`, `CONTACT_INBOX_ADDRESS`, `BILLING_EMAIL` and `NEXT_PUBLIC_COMPANY_POSTAL_ADDRESS` were replaced by constants in `lib/company.ts`. The footer and newsletters always print the registered-office postal line, and the broadcast route no longer refuses with 412 when it is missing. Remove any leftover copies from Netlify.
- **Inbound forwarding via ImprovMX (planned, never configured)**: role addresses on `familiarisenow.com` were to be forwarded through ImprovMX MX records. The records were never created, and the apex now publishes a null MX; all inbound mail goes to `connect@practitionist.com`.
- **Personal-inbox DMARC reports and an unpublished root SPF**: replaced on 2026-10-28 by the live records above.
- **One-time Novu cutover tools (deleted 2026-11-08)**: the `clear-native-mutes` script reset stray native mutes before the first read-only sync, and the `scrub-subscriber-pii` script nulled the profile data the old mirror copied onto subscribers. The relay's `review:legacy_delivery_format` and `review:legacy_broadcast` dead letters guarded rows attempted under the earlier row-wide Novu identity. All three ran their course once the Production recount read zero; the dead-letter reasons no longer exist.
