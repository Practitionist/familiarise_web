# Resend

## 1. Plan and limits

The repo assumes the Free plan until launch (`docs/notifications/05-pre-production-checklist.md`, `docs/email/README.md`). VERIFIED 2026-10-17 from [resend.com/pricing](https://resend.com/pricing): Free is 3,000 emails a month, 100 a day and 3 domains; Pro is $20 a month for 50,000 (or $35 for 100,000), no daily limit, 10 domains, overage $0.90 per 1,000; API rate limit is the same on every plan. In INR that is roughly INR 1,800 a month for Pro at INR 90 to the dollar (INFERRED rate).

## 2. What causes surprise bills or outages

- The Free plan blocks rather than bills: after 100 emails in a day, further sends fail; a newsletter broadcast or a booking surge hits this first.
- Sends that bounce or complain hurt domain reputation; suppression lists prevent repeat sends.
- Retries after a transient failure count as separate sends if the first actually went out.

## 3. Exposure in this repo

- Every send goes through `deliver()` (`lib/email/deliver.ts`), or for the newsletter broadcast through `heldRecipientDomain()` (`lib/email/delivery-guard.ts`), so QA and seed data cannot spend quota until `EMAIL_DELIVERY_MODE` is `live`. `deliver()` dead-letters a non-allowlisted recipient with `held:pre-launch`; the broadcast drops it before sending, logs `email.held_pre_launch` and reports it as `skippedHeld`, with no `FailedEmail` row.
- Failed sends are retried by the `retry-failed-emails` ticker target every 15 minutes with 20 rows per run, paced for the provider; `FailedEmail`, `FailedEmailBatch` and `EmailSuppression` carry idempotency and suppression.
- The ingest-canary and Sentry-quota alerts also send through Resend, so a capped Resend silences the alarm that reports a Sentry outage. The alert fails open.

## 4. Guardrails to set

Resend dashboard, Settings, Usage: note the 100 per day cap before any broadcast. Upgrade to Pro before enabling `EMAIL_DELIVERY_MODE=live` for real traffic. Use Batch Email API for broadcasts (up to 100 per request).

## 5. When to move to Pro (owner decision 2026-11-03)

Stay on Free until launch. Move to Pro just before launch, before the first marketing batch, or as soon as real customer volume needs it, whichever comes first. Free stops sending at 100 emails a day (3,000 a month), so a marketing batch or a booking surge on Free fails rather than bills. The reminder is also a line in the launch checklist (`docs/notifications/05-pre-production-checklist.md`, Step 5) and in the [booking v2 direction record](../../../../docs/decisions/2026-11-03-booking-v2-direction.md).

## 6. Monitor

Resend MCP `get-usage` and `get-email-metrics`; `list-emails` for recent sends.
