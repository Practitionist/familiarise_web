# Email at Familiarise

> The single map for everything that sends or receives email: the sending path, the pre-launch guard, ops alert routing, the DNS records, and the runbooks.

**Last Updated**: 2026-10-03

---

## 1. Overview

Resend sends every email the platform produces, customer-facing and operational alike. Transactional mail leaves from `mail.familiarisenow.com` and newsletter mail from `news.familiarisenow.com`, so the two reputations stay apart. Novu is in-app only and never sends email. Every send goes through `deliver()` in `lib/email/deliver.ts`, which writes a `FailedEmail` outbox row first (`stage`), attempts the send once (`attempt`), and leaves failures to the retry job in `jobs/email/retry-failed-emails.ts`. The Resend webhook at `app/api/webhooks/resend/route.ts` records every delivery event in `EmailEvent` and puts permanently bounced or complaining addresses on `EmailSuppression`. Until launch, a pre-launch guard (`EMAIL_DELIVERY_MODE`) holds every message whose recipient is outside our own domain and an explicit allowlist, because the shared database contains seeded users whose addresses are real inboxes.

## 2. Architecture diagrams

The first diagram shows the state on 2026-10-02, before the guard and the ops routing changes. The second shows the target state this change moves toward.

### Before (2026-10-02)

```
                        ┌────────────────────────── DNS LAYER ───────────────────────────┐
  GoDaddy (registrar) ──NS──►  Netlify DNS (NS1: dns1-4.p06.nsone.net) — zone familiarisenow.com
                        │   @ (apex)          A  52.74.6.109, 13.215.239.219 → Netlify     │
                        │   @ (apex)          MX ✗ none    TXT/SPF ✗ none   ← can't receive│
                        │   _dmarc            TXT v=DMARC1; p=none; rua=teetangh@gmail.com │
                        │   resend._domainkey.mail   TXT DKIM key (signs mail.)           │
                        │   send.mail         MX feedback-smtp.ap-northeast-1.amazonses   │
                        │   send.mail         TXT v=spf1 include:amazonses.com ~all       │
                        │   send.news + DKIM  same pattern for news.  (bounces → SES)     │
                        └──────────────────────────────────────────────────────────────────┘

 TRIGGERS                         NETLIFY (hosting) — Next.js app                     SUPABASE (Postgres, one DB for dev+prod)
 ─────────                        ───────────────────────────────                     ──────────────────────────────────────
 user actions (signup, book,  ──► API routes / server actions                          users (77 seed @gmail/outlook… + real)
 pay, refund, invite)              │                                                    email outbox (stage → attempt, retries)
 cron-tick (Netlify, 5 min)   ──►  ├─ booking/payment/cleanup jobs ─┐                   EmailEvent  ◄── delivery events
 GitHub Actions daily jobs    ──►  ├─ ingest canary / quota alert ──┤                   EmailSuppression ◄── bounces/complaints
                                   ├─ compliance jobs (DPDP, MSME) ─┤
                                   │                                 ▼
                                   │   lib/email: deliver() ── React Email templates ──► renders HTML
                                   │   senders: onboarding@ security@ notifications@ payments@ finance@
                                   │            noreply@ system@ (all @mail.)  ·  newsletter@news.
                                   │   (no seed/pre-launch guard — sends to anyone)
                                   ├─ Novu: in-app notifications ONLY (69 events / 16 families, no email)
                                   └─ /api/webhooks/resend ◄──────────────────────────────────────┐
                                                │ HTTPS API                                          │ webhooks
                                                ▼                                                    │ (sent/delivered/
                                   RESEND (Tokyo · Amazon SES ap-northeast-1) ───────────────────────┘  bounced/complained…)
                                   domains: mail. + news. (send-only) · suppressions: 14 · quota 37/3000
                                                │ SMTP, DKIM-signed, Return-Path send.mail.
            ┌───────────────────────────────────┼──────────────────────────────────────────┐
            ▼                                   ▼                                          ▼
 CUSTOMER MAILBOXES                    SEED ACCOUNTS @ REAL DOMAINS ⚠              OWNER GMAIL (teetangh@gmail.com)
 real signups (5)                      ~310 of 345 recent sends; 18 delivered        ops alerts (canary/quota): "delivered"
                                       to strangers, 13 bounced                       but NOT visible ⚠ · DMARC reports
                                                                                     (Google/Microsoft) · vendor mail ↓
 INBOUND: support@familiarisenow.com ──► ✗ no MX → bounces (yet shown in footers & compliance docs)

 VENDORS → owner Gmail: Sentry (~30/2d in incidents), Netlify, Supabase, Upstash, Stream, Resend, Novu, CodeRabbit
 NOT IN THE EMAIL PATH: Cloudflare (MCP only; R2 planned for recordings) · Vercel (future host, 1–2 months)
```

The boxes in the first diagram are as follows.

- **GoDaddy and Netlify DNS**: GoDaddy is only the registrar; the zone itself is served by Netlify DNS (NS1), which is why every email record lives in the Netlify dashboard.
- **Apex records**: the apex points at Netlify for the website, and had no MX and no SPF, so the domain could neither receive mail nor be protected from spoofing.
- **`_dmarc`**: a monitor-only policy whose aggregate reports go to the owner's personal Gmail.
- **`mail.` and `news.` records**: the Resend DKIM key, the SES bounce MX (`send.mail`, `send.news`) and the SPF record that make each subdomain a verified sender.
- **Triggers**: user actions, the five-minute Netlify cron tick and the daily GitHub Actions jobs all reach the same `deliver()` path.
- **`lib/email`**: renders React Email templates and picks a sender from the `SENDERS` map in `lib/email/config.ts`; the first diagram predates the guard, so it shows no refusal step.
- **Novu**: delivers in-app notifications only.
- **Supabase tables**: the outbox (`FailedEmail`, `FailedEmailBatch`), `EmailEvent` and `EmailSuppression`; one database serves development and production.
- **Resend**: sends through Amazon SES in `ap-northeast-1` and calls `/api/webhooks/resend` for every lifecycle event.
- **Recipients**: customers, seeded accounts at real public domains (the defect the guard fixes), and the owner's Gmail, which received ops alerts that Resend reported as delivered but that never became visible.
- **Inbound and vendors**: `support@` had nowhere to land, and vendor mail shared the owner's inbox with the alerts.

### Target

```
  GoDaddy ──NS──► DNS host (Netlify DNS now → Vercel DNS after migration: recreate every record below)
                  @        MX   ImprovMX mx1/mx2           ← NEW: domain can receive
                  @        TXT  v=spf1 -all                ← NEW: apex never sends; blocks spoofing
                  _dmarc   TXT  p=none → p=quarantine (~2 wks), rua=dmarc@familiarisenow.com
                  mail./news./send.* Resend DKIM+SPF+bounce MX  (unchanged)

 Next.js app ── deliver() ──► PRE-LAUNCH GUARD (EMAIL_DELIVERY_MODE=allowlist)
                               allowlisted (you, team, testers, own domain) ──► Resend ──► mailbox
                               everyone else ──► held in outbox ("held: pre-launch"), never sent
              ops alerts ──► "Familiarise Ops" <system@mail.> ──► ops@familiarisenow.com
              critical (ingest down, data breach) ──► ALSO Slack webhook (SLACK_OPS_WEBHOOK_URL)

 Resend suppressions: +77 seed addresses (2026-10-03) · DB reset re-seeds on @example.test

 INBOUND via ImprovMX (forwarding, free):
   support@ ─┐
   ops@     ─┤
   dpdp@    ─┼──► forwarded to the owner's Gmail, each auto-labelled (Gmail filters)
   billing@ ─┤
   dmarc@   ─┘   (DMARC aggregate reports)
```

The boxes in the target diagram are as follows.

- **DNS host**: the same records move to Vercel DNS when hosting moves, and the checklist in section 7 governs that move.
- **Apex MX and SPF**: ImprovMX forwarding lets the domain receive mail, and `v=spf1 -all` declares that the apex never sends.
- **`_dmarc`**: starts at `p=none`, ramps to `p=quarantine` after about two weeks of clean reports, and reports to `dmarc@familiarisenow.com`.
- **Pre-launch guard**: sits inside `deliver()` and the retry job, and holds any message with a recipient outside the allowlist.
- **Ops alerts**: leave as "Familiarise Ops" from `system@mail.familiarisenow.com` and go to `ops@familiarisenow.com`; the two critical alerts are mirrored to Slack through `SLACK_OPS_WEBHOOK_URL`.
- **Suppressions**: all 77 seeded addresses are suppressed in Resend (64 added manually on 2026-10-03, 13 earlier by hard bounces), and the database reset re-seeds users on `@example.test`, which can never be a real inbox.
- **ImprovMX aliases**: five aliases forward to the owner's Gmail, where filters label each one.

## 3. Email types

Every email the code sends is listed below, grouped by purpose. All senders are on `mail.familiarisenow.com` except the newsletter sender, and the sender names come from `SENDERS` in `lib/email/config.ts`.

The first table covers customer-facing transactional and lifecycle mail.

| Type                                                                                                                       | Trigger                                      | Sender           | Recipient                               | Channel                                   | Template and code                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------- | --------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `WELCOME`, `EMAIL_VERIFICATION`                                                                                            | Signup, email verification                   | `onboarding@`    | Customer                                | Outbox via `deliver()`                    | `emails/auth/`, `lib/email/index.ts`                                                          |
| `PASSWORD_RESET`, `ACCOUNT_LINKED`                                                                                         | Password reset, social account linked        | `security@`      | Customer                                | Outbox via `deliver()`                    | `emails/auth/`, `lib/email/index.ts`                                                          |
| `ACCOUNT_SUSPENDED`, `ACCOUNT_BANNED`                                                                                      | Back-office moderation                       | `security@`      | Customer                                | Outbox                                    | `emails/account/`, `lib/email/senders/people.ts`                                              |
| `APPOINTMENT_BOOKED`, `APPOINTMENT_CANCELLED`, `APPOINTMENT_RESCHEDULED`, `TRIAL_SESSION_SCHEDULED`, `NEW_BOOKING_REQUEST` | Booking lifecycle                            | `notifications@` | Customer or consultant                  | Outbox, staged in the booking transaction | `emails/booking/`, `lib/email/senders/booking.ts`                                             |
| `APPOINTMENT_REMINDER`, `WINDOW_OPENED`, subscription unscheduled nudge                                                    | Reminder and nudge sweeps                    | `notifications@` | Customer                                | Outbox, sent by cron                      | `emails/booking/`, `lib/email/senders/booking.ts`                                             |
| `PAYMENT_LINK`, `PAYMENT_LINK_REMINDER`, `PAYMENT_LINK_MANUAL_REMINDER`                                                    | Approved request awaiting payment, reminders | `payments@`      | Customer                                | Outbox                                    | `emails/payments/PaymentLinkEmail.tsx`, `lib/email/index.ts`, `lib/booking/remind-payment.ts` |
| `PAYMENT_SUCCESS`, `PAYMENT_FAILED`                                                                                        | Payment webhook pipeline                     | `payments@`      | Customer                                | Outbox staged in the webhook              | `emails/payments/`, `lib/payments/webhooks/staged-emails.ts`                                  |
| `REFUND_PROCESSED`, `REFUND_FAILED`                                                                                        | Refund settles or fails                      | `payments@`      | Customer                                | Outbox                                    | `emails/payments/`, `lib/email/senders/money.ts`                                              |
| `VERIFICATION_DECIDED`, `ORG_CREATED`, `ORG_WELCOME`                                                                       | Verification decision, organisation created  | `onboarding@`    | Applicant or org admin                  | Outbox                                    | `emails/verification/`, `emails/organizations/`, `lib/email/senders/onboarding.ts`            |
| `ORG_MEMBERSHIP_ROLE_CHANGED`, `ORG_MEMBERSHIP_REMOVED`, organisation invitation                                           | Membership change, invitation                | `notifications@` | Member                                  | Outbox                                    | `emails/organizations/`, `lib/email/senders/onboarding.ts`, `lib/email/index.ts`              |
| `ORG_PAYOUT_FAILED`, `ORG_INVOICE_OVERDUE`, `ORG_WALLET_LOW`, `ORG_PROGRAM_OVERAGE_DUE`                                    | Organisation finance events                  | `finance@`       | Org admin                               | Outbox                                    | `emails/orgs/`, `lib/email/senders/money.ts`                                                  |
| `SUPPORT_TICKET_RESPONSE`, `SUPPORT_TICKET_UPDATE`, `NEW_REVIEW_RECEIVED`                                                  | Support reply, ticket update, new review     | `notifications@` | Customer or consultant                  | Outbox                                    | `emails/support/`, `emails/reviews/`, `lib/email/senders/people.ts`                           |
| `SUPPORT_TICKET_RECEIVED`                                                                                                  | Ticket created or escalated                  | `notifications@` | Customer                                | `deliver()`, with an outbox bell          | `lib/support/create-ticket.ts`, `lib/email/senders/people.ts`                                 |
| `MODERATION_REPORT_OUTCOME`                                                                                                | Moderation action concludes a report         | `security@`      | Reporter                                | `deliver()`, with an outbox bell          | `app/api/staff/moderation/reports/[reportId]/action/route.ts`, `lib/email/senders/people.ts`  |
| Contact inquiry                                                                                                            | `/contactus` form                            | `notifications@` | Support inbox (`contactInboxAddress()`) | `deliver()`                               | `lib/email/index.ts`                                                                          |

The second table covers operational alerts and compliance mail, none of which a customer sees.

| Type                        | Trigger                                          | Sender                      | Recipient                                          | Channel                        | Code                                            |
| --------------------------- | ------------------------------------------------ | --------------------------- | -------------------------------------------------- | ------------------------------ | ----------------------------------------------- |
| Sentry ingest canary alert  | Canary verdict is "errors are being discarded"   | `Familiarise Ops <system@>` | `OBSERVABILITY_ALERT_EMAIL`, else `supportEmail()` | `deliver()`, then Slack mirror | `lib/observability/ingest-alert.ts`             |
| Sentry quota alert          | Accepted errors reach 70 percent of the quota    | `Familiarise Ops <system@>` | Same as the canary alert                           | `deliver()`, no Slack mirror   | `lib/observability/quota-alert.ts`              |
| DPDP breach deadline alert  | Unreported breach nears the 72-hour DPB deadline | `Familiarise Ops <system@>` | `DATABREACH_ALERT_EMAIL`                           | `deliver()`, then Slack mirror | `jobs/compliance/databreach-deadline-alerts.ts` |
| MSME payment deadline alert | Payouts approach the MSME 43B(h) deadline        | `Familiarise Ops <system@>` | `MSME_ALERT_EMAIL`                                 | `deliver()`, no Slack mirror   | `jobs/compliance/msme-payment-alerts.ts`        |

The third table covers newsletter mail, which is the only mail sent from `news.familiarisenow.com`.

| Type                              | Trigger                            | Sender        | Recipient             | Channel                                    | Code                                        |
| --------------------------------- | ---------------------------------- | ------------- | --------------------- | ------------------------------------------ | ------------------------------------------- |
| Waitlist confirmation and welcome | Double-opt-in signup, confirmation | `newsletter@` | Waitlist subscriber   | `deliver()`                                | `emails/waitlist/`, `lib/email/index.ts`    |
| `WAITLIST_BROADCAST`              | Admin broadcast                    | `newsletter@` | Confirmed subscribers | Direct Resend send, guarded per subscriber | `app/api/admin/waitlist/broadcast/route.ts` |

## 4. Pre-launch delivery guard

The guard lives in `lib/email/delivery-guard.ts` and is applied at three points: at `stage()` and `attempt()` in `lib/email/deliver.ts`, in both drain loops of `jobs/email/retry-failed-emails.ts`, and in the waitlist broadcast route.

The rules, exactly as implemented, are as follows.

- **Mode**: `EMAIL_DELIVERY_MODE=live` (case-insensitive, trimmed) disables the guard. Any other value, including unset, behaves as `allowlist`.
- **Allowed recipients**: an address is allowed when its domain is `familiarisenow.com` or any subdomain of it, or when it matches an `EMAIL_ALLOWLIST` entry. The list is comma-separated and each entry is either an exact address or a whole domain, written `@domain` or `domain`. Subdomains of an allowlisted domain are not included. Matching is case-insensitive, `Name <a@b>` reduces to the bare address, and a recipient string that is not exactly one address (a comma-separated list, for example) is always held.
- **All-recipients rule**: a message is held when any of its `to`, `cc` or `bcc` recipients is refused. One refused recipient holds the whole message, and a batch row is held when any message in it is refused.
- **Held representation**: a held message has a `FailedEmail` (or `FailedEmailBatch`) row with `status = DEAD_LETTER` and `lastError = "held:pre-launch"`. `stage()` returns `held: true`, and `attempt()` returns an `EmailHeldError` without calling Resend.
- **Never retried**: the retry job re-checks the guard first and dead-letters any pending held row, so a held row is terminal. Switching to `live` later does not release old held rows, so a held message that matters must be re-triggered by its business flow.
- **Logging**: each hold logs `event: "email.held_pre_launch"` with the email type and the recipient domain only, never the address.
- **Waitlist broadcast**: subscribers outside the allowlist are filtered out before sending and counted in the response field `skippedHeld`, next to `skippedSuppressed`.
- **GitHub Actions**: the two consolidated cron workflows that send email (`cron-intra-day.yml`, which runs `databreach-deadline-alerts`, and `cron-daily.yml`, which runs `msme-payment-alerts` and `sweep-verification`) read the repository variables `EMAIL_DELIVERY_MODE` and `EMAIL_ALLOWLIST` at job level, so every email-sending step in them is guarded. Unset variables mean allowlist mode.
- **Tests**: `jest.setup.ts` defaults `EMAIL_DELIVERY_MODE` to `live` so suites that send to example addresses are unaffected; `__tests__/email/delivery-guard.test.ts` unsets it to pin the guard.

**Launch step: set `EMAIL_DELIVERY_MODE=live` on Netlify production AND as the GitHub repository variable before opening signups.** Setting only one leaves either the website or the scheduled jobs holding mail.

## 5. Ops alerts

Ops alerts are sent as `Familiarise Ops <system@mail.familiarisenow.com>` with `Reply-To: ops@familiarisenow.com`, so a reply never loops back to the alert recipient. The display name and the stable Reply-To exist because the canary alerts of 2026-10-02 were reported by Resend as delivered yet never became visible in the owner's Gmail, which sent them as a bare address with no name.

The recipients are configured by environment variable and should all point at `ops@familiarisenow.com`.

| Variable                    | Alert                                 | If unset                          |
| --------------------------- | ------------------------------------- | --------------------------------- |
| `OBSERVABILITY_ALERT_EMAIL` | Sentry ingest canary and quota alerts | Falls back to the support address |
| `DATABREACH_ALERT_EMAIL`    | DPDP breach deadline alert            | No email; the job logs only       |
| `MSME_ALERT_EMAIL`          | MSME payment deadline alert           | The email is skipped              |

The Slack mirror is implemented in `lib/observability/ops-chat.ts` and follows these rules.

- It covers only the two critical alerts: the Sentry ingest canary (ingest is down) and the DPDP breach deadline. The quota and MSME alerts have no Slack mirror.
- It posts only after the alert email was actually sent. A held, suppressed or failed email posts nothing.
- It is best-effort: five-second timeout, never throws, and never logs the webhook URL, which is itself the credential.
- It is a no-op when `SLACK_OPS_WEBHOOK_URL` is unset. The payload is Slack format (`{ text }`).

## 6. DNS records

The registrar is GoDaddy, which only delegates nameservers. The DNS host is Netlify DNS (NS1), so every record is edited in the Netlify dashboard until hosting moves.

The records below are everything email depends on.

| Host                     | Type    | Value                                                 | Status                                                                                                                          |
| ------------------------ | ------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@` (apex)               | MX      | ImprovMX `mx1` and `mx2`                              | Planned; absent today, so the domain cannot receive mail                                                                        |
| `@` (apex)               | TXT     | `v=spf1 -all`                                         | Planned; absent today                                                                                                           |
| `_dmarc`                 | TXT     | `v=DMARC1; p=none; rua=mailto:teetangh@gmail.com`     | Live today; planned change to `rua=mailto:dmarc@familiarisenow.com`, then `p=quarantine` after about two weeks of clean reports |
| `resend._domainkey.mail` | TXT     | Resend DKIM public key                                | Live                                                                                                                            |
| `send.mail`              | MX      | `feedback-smtp.ap-northeast-1.amazonses.com`          | Live                                                                                                                            |
| `send.mail`              | TXT     | `v=spf1 include:amazonses.com ~all`                   | Live                                                                                                                            |
| `resend._domainkey.news` | TXT     | Resend DKIM public key                                | Live                                                                                                                            |
| `send.news` (MX and TXT) | MX, TXT | The same SES bounce MX and SPF pattern as `send.mail` | Live                                                                                                                            |

Copy the exact DKIM values from the Resend domain page rather than from this document, because Resend can rotate them.

## 7. Vercel migration checklist

Hosting is moving from Netlify to Vercel in one to two months. Because the DNS host changes with it, a missed record means lost mail, so the order matters. A biweekly calendar reminder exists for this checklist.

1. On the new DNS host, recreate every record in section 6 (apex MX, apex SPF, `_dmarc`, the `mail.`, `news.` and `send.*` Resend records), plus the website records.
2. Compare the new zone against the old one record by record before changing anything at GoDaddy.
3. Switch the nameservers at GoDaddy only after step 2 is clean.
4. In Resend, press verify on both domains and confirm both show verified.
5. Send a test message to `ops@` and to `support@familiarisenow.com` and confirm each arrives labelled in Gmail.
6. Confirm a DMARC aggregate report arrives at `dmarc@` within about 48 hours.
7. Re-point the Resend webhook and the environment variables, including the guard variables, at the new host if the production URL changes.

## 8. Runbooks

### An ops alert did not arrive

1. Find the message in the Resend dashboard (or `list-emails` through the Resend MCP) and read its status and message id. A `delivered` status only proves the receiving server accepted it.
2. Search the owner's Gmail with `in:anywhere` for the subject and for `from:system@mail.familiarisenow.com`, then check the spam folder and the Gmail filters that label or skip the inbox.
3. Once ImprovMX is live, check its logs to confirm the alias forwarded the message.
4. For a critical alert, check the Slack channel; the mirror only posts when the email was sent.
5. If no message exists in Resend, check the `FailedEmail` row for `lastError`; `held:pre-launch` means the recipient was outside the allowlist.

### A bounce or complaint spike

1. Open the Resend dashboard and read the bounce and complaint rates for `mail.` and `news.`.
2. Query `EmailEvent` for recent `bounced` and `complained` rows and group by recipient domain to find the source.
3. Check `EmailSuppression` to confirm the offending addresses are listed, so nothing sends to them again.
4. To pause all sending to outside recipients immediately, set `EMAIL_DELIVERY_MODE=allowlist` on Netlify and the GitHub repository variable and redeploy.

### Add a tester to the allowlist

1. Append the exact address (or `@domain`) to `EMAIL_ALLOWLIST` on Netlify production, and to the GitHub repository variable if scheduled jobs must reach the tester.
2. Redeploy so the function picks up the new value.
3. Trigger a send and confirm it is not held.

### Manage suppressions

1. List and edit suppressions in the Resend dashboard or through the API; the app mirrors permanent bounces and complaints into `EmailSuppression` through the webhook.
2. All 77 seeded addresses are suppressed in Resend as a safety net: 64 were added manually on 2026-10-03 and 13 were already suppressed by hard bounces. Leave them.
3. Never suppress a real signup. Check `User` for the address first, because a suppressed customer stops receiving verification and reset mail.

### Go live at launch

1. Confirm `ops@`, `support@`, `dpdp@` and `billing@` forward and that a DMARC report has arrived.
2. Confirm the three alert variables point at `ops@familiarisenow.com`.
3. Set `EMAIL_DELIVERY_MODE=live` on Netlify production and the GitHub repository variable.
4. Redeploy, sign up with a fresh real address, and confirm the welcome and verification mail arrives.
5. Watch the Resend bounce rate for the first day.

## 9. Known issues and open items

- Issue #1943 tracks the inbound-mail and DMARC findings (its findings 5 and 6): the domain had no MX and the DMARC reports go to a personal inbox.
- Issue #1933 tracks the Sentry error quota, which the ingest canary and quota alert protect.

Owner actions still open:

- Create the ImprovMX account and the `support@`, `ops@`, `dpdp@`, `billing@` and `dmarc@` aliases, and add the Gmail filters that label them.
- Create the Slack incoming webhook and set it as `SLACK_OPS_WEBHOOK_URL` on Netlify and in the existing GitHub secret of the same name.
- Point `OBSERVABILITY_ALERT_EMAIL`, `DATABREACH_ALERT_EMAIL` and `MSME_ALERT_EMAIL` at `ops@familiarisenow.com`.
- Run the DMARC ramp: change `rua` to `dmarc@`, then move to `p=quarantine` after about two weeks of clean reports.
- Re-seed users on `@example.test` at the database reset, then revisit the 77 seed suppressions.
