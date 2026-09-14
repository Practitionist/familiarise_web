# Pre-Production Checklist — Email, Notifications & Newsletter

> Everything needed before going live. Current state, free tier limits, when to pay, and the exact setup steps.

**Last Updated**: 2026-09-14
**Live Domain**: `familiarisenow.com` (Netlify)

---

## Table of Contents

- [Decision (2026-09-14): Sending Domain](#decision-2026-09-14-sending-domain)
- [Service Free Tier Limits](#service-free-tier-limits)
- [Pre-Launch Checklist (Free, $0/month)](#pre-launch-checklist-free-0month)
- [DNS Setup for Resend (Step-by-Step)](#dns-setup-for-resend-step-by-step)
- [Novu Dashboard Configuration](#novu-dashboard-configuration)
- [Cron Job Scheduling](#cron-job-scheduling)
- [Environment Variables](#environment-variables)
- [When You'll Need to Pay](#when-youll-need-to-pay)
- [Deferred Services (Post-Launch)](#deferred-services-post-launch)
- [Cost Projection Timeline](#cost-projection-timeline)
- [Sources](#sources)

---

## Decision (2026-09-14): Sending Domain

The prod outage tracked as #1298 had three causes: the `RESEND_API_KEY` deployed to Netlify prod, the GitHub Actions secret, `.env` and `.mcp.json` was invalid (Resend returned 400 "API key is invalid" on every send); every `from:` address was `@familiarise.com`, a domain the company has never owned (it sits parked at NameBright/HugeDomains with SPF `-all`, which tells receiving servers to reject mail claiming to be from it); and `familiarisenow.com`, the domain the company does own and the live site runs on, had no DKIM/SPF/DMARC records — its DNS is Netlify DNS (nameservers at NS1), not the registrar.

`familiarise.com` was never a real option: the company does not control its DNS, so Resend cannot verify it, and buying it back does not fix the second and third causes.

The owner decided to send from `familiarisenow.com` through two subdomains, splitting reputations so a newsletter bounce spike cannot affect transactional deliverability:

```
onboarding@mail.familiarisenow.com
security@mail.familiarisenow.com
payments@mail.familiarisenow.com
notifications@mail.familiarisenow.com
finance@mail.familiarisenow.com
dpdp@mail.familiarisenow.com
noreply@mail.familiarisenow.com
system@mail.familiarisenow.com   (bare requester id, not a From header)
newsletter@news.familiarisenow.com
```

The region is Tokyo (`ap-northeast-1`). Resend offers four regions (`us-east-1`, `eu-west-1`, `sa-east-1`, `ap-northeast-1`); the region controls where Resend dispatches mail from, not where account data is stored, which stays in the US regardless of the region chosen.

Support and contact mail still goes to a real mailbox through `NEXT_PUBLIC_SUPPORT_EMAIL` / `CONTACT_INBOX_ADDRESS`, because `familiarisenow.com` has no MX record yet and cannot receive mail.

**Files using these `from:` addresses:**

- `lib/email/index.ts` — 11 sender functions, all reading `SENDERS` from `lib/email/config.ts`
- `app/api/admin/waitlist/broadcast/route.ts` — the newsletter broadcast, `SENDERS.newsletter`

## Service Free Tier Limits

### Resend (Email Delivery)

| Feature                  | Free        | Pro ($20/mo)           | Scale ($90/mo)         |
| ------------------------ | ----------- | ---------------------- | ---------------------- |
| Emails/month             | 3,000       | 50,000                 | 100,000                |
| **Daily limit**          | **100/day** | No limit               | No limit               |
| Custom domain            | Yes         | Yes                    | Yes                    |
| Analytics (opens/clicks) | **No**      | Yes                    | Yes                    |
| API keys                 | 1           | Multiple               | Multiple               |
| Overage                  | Blocked     | Pay-as-you-go (5x cap) | Pay-as-you-go (5x cap) |

**What 100/day means in practice:**

- Each booking typically fires 2 emails (confirmation to both parties)
- 100/day = ~50 bookings/day, or ~50 unique user actions triggering emails
- Newsletter sends count against this — a blast to 200 subscribers = 200 emails = 2 days of quota
- **Workaround for newsletters:** Send admin newsletter blasts during off-peak hours, batch across days if >100 subscribers

**What you lose without analytics:**

- No open rate tracking
- No click tracking
- No bounce/complaint monitoring
- You're flying blind on deliverability until you upgrade

### Novu (Notification Orchestration)

| Feature                 | Free                                       | Pro (~$25-30/mo) |
| ----------------------- | ------------------------------------------ | ---------------- |
| Events/month            | ~10,000                                    | 30,000           |
| In-app notifications    | Yes                                        | Yes              |
| Email channel           | Not used — all 16 families are in-app only | Not used         |
| Digest/batching         | Limited                                    | Full             |
| Activity feed retention | 7 days                                     | 30 days          |
| Subscribers             | Unlimited                                  | Unlimited        |
| Workflows               | 20                                         | 20 (100 on Team) |

**What an "event" is:**

- 1 trigger call to 1 subscriber = 1 event
- `notifyAppointmentBooked([consultantId, consulteeId], payload)` = **2 events** (one per recipient)
- `notifyGeneralAnnouncement(payload)` (broadcast to 500 users) = **500 events**

**Capacity math:**

- 10K events/month = ~166 events/day
- At 2 recipients per notification, that's ~83 notification triggers/day
- Comfortable for the first few hundred active users

### Kit / ConvertKit (Newsletter — Deferred)

| Feature          | Free Newsletter | Creator ($39/mo)           |
| ---------------- | --------------- | -------------------------- |
| Subscribers      | **10,000**      | 1,000+ (scales with price) |
| Email sends      | Unlimited       | Unlimited                  |
| Automations      | 1               | Unlimited                  |
| Sequences (drip) | **No**          | Yes                        |
| Landing pages    | Yes             | Yes                        |
| Tags/segments    | Yes             | Yes                        |

**The free tier is very generous.** 10K subscribers with unlimited sends covers you well past launch. You only need Creator when you want automated drip sequences (welcome series, onboarding flows, re-engagement).

### Directus CMS (Blog — Deferred)

| Feature           | Self-Hosted          | Cloud ($25/mo) |
| ----------------- | -------------------- | -------------- |
| Cost              | Free (your infra)    | $25/mo         |
| Setup complexity  | Docker, VPS, backups | Managed        |
| Content API       | Full                 | Full           |
| Media storage     | Your S3/Supabase     | Included       |
| Revenue threshold | Free under $5M/yr    | No limit       |

**Recommendation:** Use Directus Cloud at $25/mo when ready for the blog. Skip self-hosting complexity at this stage.

---

## Pre-Launch Checklist (Free, $0/month)

### Step 1: Domain Decision

- [x] Decided 2026-09-14: send from `familiarisenow.com` through `mail.familiarisenow.com` (transactional) and `news.familiarisenow.com` (newsletter); see [Decision (2026-09-14): Sending Domain](#decision-2026-09-14-sending-domain)
- [ ] Add both subdomains in the Resend dashboard and verify (see [DNS Setup](#dns-setup-for-resend-step-by-step) below)

### Step 2: Resend Setup

- [ ] Create account at [resend.com](https://resend.com)
- [ ] Add both sending domains (see [DNS Setup](#dns-setup-for-resend-step-by-step) below)
- [ ] Verify both domains (DKIM + SPF)
- [ ] Copy API key → save for Step 5

### Step 3: Novu Setup

- [ ] Create account at [novu.co](https://novu.co)
- [ ] Sync the workflows (see [Novu Dashboard Configuration](#novu-dashboard-configuration)) — no Resend email provider to add, every family is in-app only
- [ ] Copy Secret Key + App ID → save for Step 5

### Step 4: Prisma Schema

- [x] The `Waitlist` model (status, confirmedAt, unsubscribedAt, consent proof) is already in `prisma/schema.prisma`; no migration is needed for the newsletter

### Step 5: Environment Variables

- [ ] Set all required env vars in Netlify dashboard (see [Environment Variables](#environment-variables))

### Step 6: Cron Jobs

- [ ] Set up GitHub Actions for appointment-reminders (every 15 min)
- [ ] Set up GitHub Actions for auto-complete-appointments (hourly)
- [ ] Verify both with manual trigger

### Step 7: Smoke Test

- [ ] Sign up as new user → verify welcome email arrives
- [ ] Subscribe to newsletter → verify DB record
- [ ] Unsubscribe via link → verify `unsubscribed = true`
- [ ] Trigger a test Novu workflow → verify in-app bell notification appears
- [ ] Check Resend dashboard → verify domain shows "Verified"

---

## DNS Setup for Resend (Step-by-Step)

Two domains need to be added and verified, because transactional and newsletter mail are split to keep their sender reputations apart.

1. Log into [Resend Dashboard → Domains](https://resend.com/domains)
2. Click **"+ Add Domain"** and enter `mail.familiarisenow.com`; repeat for `news.familiarisenow.com`
3. Select region **ap-northeast-1 (Tokyo)** for both — the region controls where Resend dispatches mail from, not where account data lives, which stays in the US
4. Resend displays the DNS records each domain needs once it is added:

| Type | Name                                        | Value                                               | Purpose                       |
| ---- | ------------------------------------------- | --------------------------------------------------- | ----------------------------- |
| TXT  | `resend._domainkey.mail.familiarisenow.com` | `p=MIGfMA0GCSq...` (read from the Resend dashboard) | DKIM signature                |
| TXT  | `send.mail.familiarisenow.com`              | `v=spf1 include:amazonses.com ~all`                 | SPF authorization             |
| MX   | `send.mail.familiarisenow.com`              | `feedback-smtp.ap-northeast-1.amazonses.com`        | Return-path / bounce handling |
| TXT  | `_dmarc.mail.familiarisenow.com`            | `v=DMARC1; p=none; ...` (optional)                  | DMARC policy                  |

The exact record names and values are read from the Resend dashboard after each domain is added, not copied from this table — Resend generates the DKIM key per domain. The same four records are added again for `news.familiarisenow.com`.

5. Add the records in **Netlify DNS**, which is where the `familiarisenow.com` zone lives (nameservers point at NS1, not the domain registrar): `netlify api createDnsRecord --data '{...}'` against the zone, or through the Netlify dashboard's DNS panel
6. Back in Resend, click **"Verify DNS"** for each domain
7. Wait for verification (minutes to 48 hours for DNS propagation)
8. Status should change to **"Verified"** with a green checkmark for both `mail.familiarisenow.com` and `news.familiarisenow.com`

**Important:** Netlify DNS records are not proxied, so there is no orange-cloud/gray-cloud distinction to worry about here (that concern is specific to Cloudflare DNS, which this repository does not use for `familiarisenow.com`).

---

## Novu Dashboard Configuration

Use the template specs at `docs/notifications/03-novu-template-specs.md` for copy-paste-ready content.

### 1. Add Resend Email Provider — not needed

All sixteen Novu workflow families are in-app only; none has an email step, so there is no Resend integration to add in Novu → Integrations. Novu's own "email" integration option is its demo provider and is not used here. Email for a Novu-triggered event, if ever wanted, is a product decision tracked separately and is not part of this checklist.

### 2. Sync the workflows

The workflows are no longer created by hand. `lib/novu/templates/` is the source of truth, and `scripts/novu/sync-workflows.ts` writes it to the Novu environment with three commands:

- `npm run novu:sync -- --dry-run` prints the plan without writing anything.
- `npm run novu:sync` applies the plan. It retires the 19 legacy workflows first, because the environment's 20-workflow cap counts live workflows and a create on a full environment fails. This apply is a production operation: local development and production both point at the same Development environment, so running it writes to what customers see. Run it by hand after a merge, never from CI.
- `npm run novu:check` exits 1 if the live environment has drifted from the manifest. This is the drift guard CI runs on every pull request.

### 3. Preference categories and step conditions

Nothing to configure by hand. Each family carries its opt-out category as a tag and as a step condition (`subscriber.data.<categoryFlag> != false`, plus `routingBell != false`), both written by the sync from `FAMILIES` and `inAppSkipRule` in `lib/novu/templates/`. The family-to-category map is the table in `03-novu-template-specs.md`, and the runbook in `docs/enterprise/50-operations/09-novu-console-conditions.md` describes what the sync writes and how to verify it.

### 4. Gate the production deploy on the sync

The `prod` branch deploys on merge, and the code it carries triggers family ids. Before merging `dev` into `prod` after any change under `lib/novu/templates/`, run `npm run novu:sync` and then `npm run novu:check` and confirm it reports nothing to change; a deploy that lands before the sync drops every notification of a missing family silently. The same order applies in reverse for the first migration: merge, sync, then verify one event per changed family in an inbox.

---

## Owner Runbook: Rotating `RESEND_API_KEY`

The key that caused #1298 was the same invalid value in four places; all four need the new key, in this order, because a partial rotation leaves some paths sending and others silently dead-lettering:

1. **Netlify production** — Site settings → Environment variables → `RESEND_API_KEY`, scoped to the production context.
2. **GitHub Actions secret** — `gh secret set RESEND_API_KEY`, so the retry worker cron (`5-59/15 * * * *`) and any CI-side email test use the same key.
3. **`.env`** — local development.
4. **`.mcp.json`** — the Resend MCP server configuration used for live verification.

Then, before the first send:

5. Add `mail.familiarisenow.com` and `news.familiarisenow.com` as domains in the Resend dashboard (see [DNS Setup](#dns-setup-for-resend-step-by-step)) and add the DNS records in Netlify DNS.
6. Set `EMAIL_TRANSACTIONAL_DOMAIN`, `EMAIL_NEWSLETTER_DOMAIN`, `NEXT_PUBLIC_SUPPORT_EMAIL`, `CONTACT_INBOX_ADDRESS`, `BILLING_EMAIL` and `NEXT_PUBLIC_COMPANY_POSTAL_ADDRESS` per [.env.sample](../../.env.sample) if a non-default value is wanted.
7. Redeploy so Netlify picks up the new environment variables.
8. Smoke test: sign up a test user and confirm the welcome email arrives; check the Resend dashboard shows both domains "Verified"; check the `FailedEmail` table has no new `PENDING` rows after the smoke test.
9. Resolve the open Sentry issues fingerprinted `["email-send-terminal", ...]` that were paging during the outage, once sends succeed again.

---

## Cron Job Scheduling

### GitHub Actions Workflow

Create `.github/workflows/cron-notifications.yml`:

```yaml
name: Notification Cron Jobs

on:
  schedule:
    # Appointment reminders - every 15 minutes
    - cron: "*/15 * * * *"
  workflow_dispatch: # Allow manual trigger

jobs:
  appointment-reminders:
    runs-on: ubuntu-latest
    steps:
      - name: Send appointment reminders
        run: |
          curl -s -f -X GET \
            "${{ secrets.APP_URL }}/api/cleanup/appointment-reminders" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            -H "Content-Type: application/json"
```

Create `.github/workflows/cron-auto-complete.yml`:

```yaml
name: Auto-Complete Appointments

on:
  schedule:
    # Hourly
    - cron: "0 * * * *"
  workflow_dispatch:

jobs:
  auto-complete:
    runs-on: ubuntu-latest
    steps:
      - name: Auto-complete expired appointments
        run: |
          curl -s -f -X GET \
            "${{ secrets.APP_URL }}/api/cleanup/auto-complete-appointments" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            -H "Content-Type: application/json"
```

**GitHub Secrets needed:**

- `APP_URL` = `https://familiarisenow.com`
- `CRON_SECRET` = same value as in Netlify env vars

---

## Environment Variables

Set these in **Netlify Dashboard → Site → Environment Variables**:

| Variable                             | Value                                     | Required                                       |
| ------------------------------------ | ----------------------------------------- | ---------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`                | `https://familiarisenow.com`              | Yes                                            |
| `RESEND_API_KEY`                     | From Resend dashboard                     | Yes                                            |
| `EMAIL_TRANSACTIONAL_DOMAIN`         | `mail.familiarisenow.com`                 | No (this is the default)                       |
| `EMAIL_NEWSLETTER_DOMAIN`            | `news.familiarisenow.com`                 | No (this is the default)                       |
| `NEXT_PUBLIC_SUPPORT_EMAIL`          | `support@familiarisenow.com`              | No (this is the default)                       |
| `CONTACT_INBOX_ADDRESS`              | Defaults to `NEXT_PUBLIC_SUPPORT_EMAIL`   | No                                             |
| `BILLING_EMAIL`                      | Defaults to `NEXT_PUBLIC_SUPPORT_EMAIL`   | No                                             |
| `NEXT_PUBLIC_COMPANY_POSTAL_ADDRESS` | Omitted from the footer when unset        | No                                             |
| `NOVU_SECRET_KEY`                    | From Novu dashboard → Settings → API Keys | Yes                                            |
| `NEXT_PUBLIC_NOVU_APP_ID`            | From Novu dashboard → Settings → API Keys | Yes                                            |
| `CRON_SECRET`                        | Generate: `openssl rand -hex 32`          | Yes                                            |
| `WAITLIST_HMAC_SECRET`               | Generate: `openssl rand -hex 32`          | Yes (there is no fallback to `RESEND_API_KEY`) |
| `STREAM_WEBHOOK_SECRET`              | From Stream.io dashboard                  | Yes (for recording notifications)              |

**Generate secrets locally:**

```bash
# Run these and copy the output
openssl rand -hex 32  # → CRON_SECRET
openssl rand -hex 32  # → WAITLIST_HMAC_SECRET
```

---

## When You'll Need to Pay

### Resend: Free → Pro ($20/mo)

**Upgrade trigger:** Any of these:

- Consistently sending >80 emails/day
- Need open/click analytics for deliverability monitoring
- Planning a newsletter blast to >100 subscribers (daily limit)
- Getting "rate limit" errors in logs

**Expected timeline:** Month 2-3 post-launch

### Novu: Free → Pro (~$25-30/mo)

**Upgrade trigger:** Any of these:

- Exceeding 10K events/month
- Need activity feed retention >7 days
- Need advanced digest/batching rules

Note that Pro keeps the 20-workflow cap; only Team ($250/month) raises it to 100. The 16 workflow families exist so that the cap is not the reason to upgrade.

**Expected timeline:** Month 3-6 post-launch (when you have ~100+ DAU)

**Self-hosting alternative:** Novu is open-source. You can self-host for unlimited events if you want to avoid the cost, but it adds DevOps overhead.

### Kit (ConvertKit): Free → Creator ($39/mo)

**Upgrade trigger:**

- Need automated drip sequences (welcome series, onboarding flows)
- Need more than 1 automation rule
- The free tier supports 10K subscribers, so subscriber count won't be the trigger

**Expected timeline:** 6+ months post-launch

### Directus CMS: $0 → Cloud ($25/mo)

**Upgrade trigger:**

- Ready to launch the blog for SEO/content marketing
- Need a content management system for the team

**Expected timeline:** When content strategy kicks in (post-launch, when you have traction)

---

## Cost Projection Timeline

| Phase                               | Resend | Novu   | Kit  | Directus | Total           |
| ----------------------------------- | ------ | ------ | ---- | -------- | --------------- |
| **Launch (Month 1)**                | $0     | $0     | $0   | $0       | **$0/mo**       |
| **Early Growth (Month 2-3)**        | $20    | $0     | $0   | $0       | **$20/mo**      |
| **Active Users (Month 3-6)**        | $20    | $25    | $0   | $0       | **$45/mo**      |
| **Content + Newsletter (Month 6+)** | $20    | $25    | $0\* | $25      | **$70/mo**      |
| **Full Scale (Month 12+)**          | $20-90 | $25-50 | $39  | $25      | **$109-204/mo** |

_Kit free tier covers 10K subscribers. Creator ($39/mo) only needed for drip sequences._

**Note:** These costs are separate from your existing SaaS stack (Supabase, Stream.io, Upstash, etc.). See `docs/finances/08-saas-expenditures.md` for the full breakdown.

---

## Deferred Services (Post-Launch)

### ConvertKit (Kit) — Newsletter

**Current state:** Stubs in `lib/newsletter/convertkit.ts`. Newsletter subscribe/unsubscribe routes work via Resend batch API as interim.

**When to integrate:**

- 500+ newsletter subscribers
- Ready for drip sequences (welcome, onboarding, re-engagement)
- Blog is live and you want automated "new post" broadcasts

**What to do:**

1. Sign up at [kit.com](https://kit.com) (free tier)
2. Get API key + form ID
3. Set `CONVERTKIT_API_KEY` and `CONVERTKIT_FORM_ID` env vars
4. Replace stub functions in `lib/newsletter/convertkit.ts` with real API calls
5. Set up subscriber tags (consultant, consultee, tech, career, business)
6. Wire Directus webhook → `createBroadcast()` for blog post notifications

### Directus CMS — Blog & Community

**Current state:** Webhook stub at `app/api/webhooks/directus/route.ts`. Database schema isolation designed (`public` vs `cms` schema).

**When to integrate:**

- Ready for SEO-driven content marketing
- Have someone to write content (you, team member, or AI-assisted)

**What to do:**

1. Sign up for [Directus Cloud](https://directus.io/pricing/cloud) ($25/mo) or self-host
2. Point at your Supabase PostgreSQL database
3. Configure `DB_SCHEMA=cms` for isolation
4. Create content tables: `cms_posts`, `cms_categories`
5. Set up webhook to fire on `items.create` for `cms_posts`
6. Update `app/api/webhooks/directus/route.ts` to handle real events
7. Build blog frontend pages in Next.js

**Architecture docs:** the Directus CMS design was deleted with `docs/roadmap/` in #1535; the live question is tracked in #767.

---

## Sources

- [Resend Pricing](https://resend.com/pricing)
- [Resend Account Quotas and Limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits)
- [Resend Domain Setup Guide](https://resend.com/docs/dashboard/domains/introduction)
- [Resend New Free Tier Announcement](https://resend.com/blog/new-free-tier)
- [Novu Pricing](https://novu.co/pricing/)
- [Novu Pro Tier Announcement](https://novu.co/blog/from-builders-for-builders-introducing-new-novu-pro-tier/)
- [Novu Free Tier Events Discussion](https://www.answeroverflow.com/m/1121163999606734989)
- [Directus Pricing (Self-hosting and Cloud)](https://directus.io/pricing)
- [Kit (ConvertKit) Pricing](https://kit.com/pricing)
- [Kit Pricing Analysis 2026](https://www.emailtooltester.com/en/reviews/convertkit/pricing/)
- [Resend SPF/DKIM/DMARC Setup Guide](https://dmarcdkim.com/setup/how-to-setup-resend-spf-dkim-and-dmarc-records)
