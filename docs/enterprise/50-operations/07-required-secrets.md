---
title: Required GitHub Actions secrets for the scheduled fleet
band: 50-operations
audience: sde2
status: live
last-reviewed: 2026-07-28
---

# Required secrets — the scheduled-workflow manifest

## Why this file exists

A GitHub Actions expression that references a secret which does not exist does
not fail. It silently interpolates an empty string, the job runs, and the code
takes whatever "credential missing" branch it has — usually a warning log and an
early return. The job then reports success. That failure mode is invisible from
the Actions UI, invisible from the code, and invisible from the schedule, which
is exactly why it survived two rounds of remediation.

It has already bitten this repository twice. Issue #677 PM-1 found that seven
reconciliation scripts read `RAZORPAY_KEY_SECRET` while the environment defined
`RAZORPAY_SECRET`; the application code was corrected, and the workflows were
then wired to source *both* environment names from `secrets.RAZORPAY_KEY_SECRET`,
a secret that has never existed. Payout submission, payout-status reconciliation,
payment-status reconciliation and stuck-payout handling therefore ran with empty
Razorpay credentials for months while reporting green. Separately, the money-cron
pager added in #864 has never sent a single alert, because `SLACK_OPS_WEBHOOK_URL`
was wired into all fifty-six workflows but never provisioned.

This manifest is the fix. Every `secrets.NAME` reference in `.github/workflows/`
must appear in the table below, and `scripts/ci/check-workflow-hygiene.ts` fails
the build when one does not. The table is therefore the single reviewed place
where "this workflow needs this credential, and here is what breaks without it"
is written down.

## How to use it

When you add a secret reference to a workflow, add a row here in the same commit.
When you provision a secret, change its status. When a row's status is `missing`,
the consequence column tells you what is currently silently broken, and that is
the queue an operator should work through before launch.

The status column records whether the secret is set at the **repository** level as
of the last review. It is maintained by hand — the CI guard checks that a
reference is *declared*, not that it is *provisioned*, because a workflow cannot
read the repository's secret list. Confirm the live state with `gh secret list`.

## Manifest

### Set and working

These secrets are provisioned and every workflow that references them resolves a
real value.

| Secret                                                              | Consumers                                     | What it does                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                      | all 56 scheduled workflows                    | Pooled Supabase connection string that Prisma uses for every job.                                                                                                                                                                                                    |
| `DIRECT_URL`                                                        | all 56 scheduled workflows                    | Direct (non-pooled) connection used by Prisma for schema introspection.                                                                                                                                                                                              |
| `UPSTASH_REDIS_REST_URL`                                            | all 56 scheduled workflows                    | Redis endpoint backing `withCronLock`; money jobs are fail-closed without it.                                                                                                                                                                                        |
| `UPSTASH_REDIS_REST_TOKEN`                                          | all 56 scheduled workflows                    | Auth token for the same.                                                                                                                                                                                                                                             |
| `RAZORPAY_KEY_ID`                                                   | 8 payment workflows                           | Razorpay API key id.                                                                                                                                                                                                                                                 |
| `RAZORPAY_SECRET`                                                   | 8 payment workflows                           | Razorpay API secret. This is the canonical name; `lib/payments/core/razorpay.ts` reads only this one, and workflows also export it as `RAZORPAY_KEY_SECRET` for the legacy readers in `scripts/`.                                                                    |
| `STRIPE_SECRET_KEY`                                                 | 9 workflows                                   | Stripe server key for the secondary rail and Connect transfers.                                                                                                                                                                                                      |
| `SUPABASE_SERVICE_ROLE_KEY`                                         | 4 workflows                                   | Storage and admin operations in document and recording jobs.                                                                                                                                                                                                         |
| `NEXT_PUBLIC_SUPABASE_URL`                                          | 4 workflows                                   | Supabase project URL.                                                                                                                                                                                                                                                |
| `RESEND_API_KEY`                                                    | 4 workflows                                   | Transactional email delivery.                                                                                                                                                                                                                                        |
| `STREAM_API_KEY`, `STREAM_API_SECRET`, `NEXT_PUBLIC_STREAM_API_KEY` | Stream jobs                                   | Stream.io video and chat administration.                                                                                                                                                                                                                             |
| `SENTRY_DSN`                                                        | all 56 scheduled workflows + `cron-heartbeat` | Fallback alert sink in `scripts/ci/notify-ops-failure.sh`. Because `SLACK_OPS_WEBHOOK_URL` has never been provisioned, this is currently the *only* channel by which a money-cron failure reaches anyone.                                                            |
| `REDIS_URL`                                                         | 1 workflow                                    | Legacy Redis URL retained by a single job.                                                                                                                                                                                                                           |
| `ENV_FILE`                                                          | `ci.yaml`                                     | A base64-encoded `.env` that the test-and-build job decodes so Jest and `next build` have a full environment. It duplicates several of the values above, which makes it easy to rotate one and forget the other; #866 flagged it for removal and it is still in use. |
| `CLAUDE_CODE_OAUTH_TOKEN`                                           | 2 workflows                                   | Claude Code review automation; not money-related.                                                                                                                                                                                                                    |

### Missing — money-critical

Every row here is currently silently degraded in production. These should be
provisioned before launch, in roughly this order.

| Secret                  | Consumers                                                                                                                                                                                | What is broken without it                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_OPS_WEBHOOK_URL` | all 56 scheduled workflows                                                                                                                                                               | No money-cron failure is paged anywhere. `scripts/ci/notify-ops-failure.sh` now falls back to Sentry when `SENTRY_DSN` is present, so this is no longer a total blackout, but Slack remains the intended primary channel. |
| `NOVU_SECRET_KEY`       | `dunning`, `generate-subscription-invoices`, `wallet-low-balance`, `timeout-member-overages`, `detect-consultant-no-shows`, `send-appointment-reminders`, `transfer-expiring-recordings` | Money notifications never send. Customers are not told that an invoice is overdue, that a wallet is low, or that an overage was charged, while the underlying money state changes anyway.                                 |
| `NEXT_PUBLIC_APP_URL`   | `databreach-deadline-alerts`, `detect-consultant-no-shows`, `msme-payment-alerts`, `send-appointment-reminders`                                                                          | Links inside outbound emails are built against an empty origin, so recipients receive broken URLs.                                                                                                                        |
| `MSME_ALERT_EMAIL`      | `msme-payment-alerts`                                                                                                                                                                    | The MSME 45-day payment-deadline alert has no recipient, so a statutory deadline under Section 43B(h) can pass unnoticed.                                                                                                 |

### Missing — live payouts

These are only required once `ENABLE_LIVE_PAYOUTS` is turned on. Until then their
absence is correct, because no money leaves the gateway. See
[the live-payout go-live runbook](./06-live-payout-go-live-runbook.md).

| Secret                     | Consumers                | What is broken without it                                                                                     |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `RAZORPAYX_ACCOUNT_NUMBER` | `process-payouts`        | RazorpayX cannot identify the source account, so no payout can be submitted.                                  |
| `RAZORPAYX_KEY_ID`         | payout submission        | Falls back to `RAZORPAY_KEY_ID`, which is a different product's credential.                                   |
| `RAZORPAYX_KEY_SECRET`     | payout submission        | Falls back to `RAZORPAY_SECRET`, same caveat.                                                                 |
| `RAZORPAYX_WEBHOOK_SECRET` | `/api/webhooks/razorpay` | The payout-webhook signature fallback branch cannot verify, so payout status never advances from the gateway. |

### Missing — compliance and other

These gate features that are deliberately flag-off today. They are recorded so
that turning the flag on does not become an archaeology exercise.

| Secret                                                     | Consumers                    | What is broken without it                                                                                                    |
| ---------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `CLEARTAX_API_KEY`, `CLEARTAX_GSP_TOKEN`, `CLEARTAX_GSTIN` | `irp-uploader`               | E-invoice IRN generation cannot reach the IRP. Tracked under #713; the job is flag-gated.                                    |
| `DATABREACH_ALERT_EMAIL`                                   | `databreach-deadline-alerts` | The DPDP 72-hour breach-notification alert has no recipient.                                                                 |
| `DPDP_SWEEPER_DELETE`                                      | `consent-retention-sweeper`  | Absent means the documented default of `false`, so the sweeper reports without deleting. This is intentional.                |
| `ENABLE_CONSOLIDATED_INVOICE`                              | `settle-invoice-accruals`    | Absent means off, which is the intended default.                                                                             |
| `STREAM_SYNC_EXCLUDED_USERS`                               | `stream-sync`                | Absent means no exclusions, which is the intended default.                                                                   |
| `LOAD_TEST_EMAIL`, `LOAD_TEST_PASSWORD`                    | `load-test`                  | The manual k6 load test cannot authenticate. The workflow is `workflow_dispatch`-only, so this never affects scheduled runs. |

## Related

The companion guard `scripts/ci/check-workflow-hygiene.ts` also enforces that no
two scheduled workflows start on the same minute of the same hour. Start-time
collisions do not cause runtime conflicts — every job in this fleet completes in
about sixty seconds — but simultaneous starts contend for the same Supavisor
connection pool, which is the failure mode behind #932.
