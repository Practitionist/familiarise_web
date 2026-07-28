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

## The second surface: Netlify runtime environment

Everything above concerns GitHub Actions secrets, which is where the scheduled
fleet reads its configuration. The running application reads a different store
entirely — the Netlify site environment — and a name can be present in one and
absent from the other. `scripts/ci/check-workflow-hygiene.ts` cannot see the
Netlify side at all, because it parses workflow files rather than querying a
deploy, so this section has to be maintained by hand.

Netlify scopes each variable to a set of deploy contexts, and the default when a
variable is added through the UI is production only. A value that works in
production is therefore not evidence that branch deploys and deploy previews
have it, which is the trap described below.

The one confirmed gap was found on 2026-07-28 while exercising the refund
webhook against the deploy preview for PR #1042. Every request to
`/api/webhooks/razorpay` returned `500 {"error":"Webhook secret not
configured"}`, because `app/api/webhooks/razorpay/route.ts` reads
`process.env.RAZORPAY_WEBHOOK_SECRET` and refuses to verify a signature without
it. The consequence is narrow but worth stating plainly: gateway webhooks cannot
be exercised on a preview, so refund, dispute and payout events can only be
tested against production or locally.

| Variable                   | Read by                               | What is broken where it is missing                                                                                                                                                                                               |
| -------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RAZORPAY_WEBHOOK_SECRET`  | `app/api/webhooks/razorpay/route.ts`  | Every Razorpay webhook is rejected with a 500 before signature verification. Confirmed missing on Deploy Preview; **production has not been confirmed either way and should be**, because no live payment has ever exercised it. |
| `RAZORPAYX_WEBHOOK_SECRET` | same route, payout-signature fallback | Payout webhooks signed with the X secret fail verification. Not yet provisioned anywhere; live payouts remain gated.                                                                                                             |
| `STRIPE_WEBHOOK_SECRET`    | `app/api/webhooks/stripe/route.ts`    | Same failure shape on the Stripe route.                                                                                                                                                                                          |
| `STREAM_WEBHOOK_SECRET`    | `app/api/stream/webhooks/route.ts`    | Same failure shape on the Stream route.                                                                                                                                                                                          |

Confirming production is a two-minute check and it has never been done, so it is
worth doing before the first live payment rather than after: open the Netlify
site environment, confirm `RAZORPAY_WEBHOOK_SECRET` is present for the
production context, and confirm the value matches the secret configured on the
Razorpay dashboard webhook. An endpoint that 500s on every delivery would be
invisible today, because no live payment has ever produced one.

## Open actions, and who can do them

Everything below needs a credential, a console, or a professional opinion, so
none of it can be completed from the codebase. They are listed here rather than
in a commit message because a commit message is not somewhere anyone looks for
outstanding work. Ordered by what would hurt most if it stayed undone.

**1. Confirm `RAZORPAY_WEBHOOK_SECRET` in the Netlify production context.**
This is the one to do first. `app/api/webhooks/razorpay/route.ts` returns a 500
before it verifies anything when the variable is missing, so every gateway
event — captures, refunds, disputes, payouts — is rejected. It is confirmed
absent from the deploy-preview context, and production has never been checked.
Nothing would surface this today because no live payment has ever produced a
webhook. Open the Netlify site environment, confirm the variable exists for the
production context, and confirm the value matches the secret configured on the
Razorpay dashboard webhook.

**2. Provision the four dangling ops secrets.** `SLACK_OPS_WEBHOOK_URL`,
`NOVU_SECRET_KEY`, `NEXT_PUBLIC_APP_URL` and `MSME_ALERT_EMAIL` are referenced
by workflows and have never been set. Sentry is currently the only channel by
which a money-cron failure reaches a human.

**3. Take the GST zero-rating evidence gap to a CA.** Buyer-country detection
now defaults to `IN` unless a country was explicitly asserted, so the error
direction is over-collection rather than under-collection. What is still missing
is the evidence a zero-rated export needs: no billing address is captured, no
LUT is checked, settlement is in INR rather than convertible foreign exchange,
and no FIRC reference is stored. `lib/payments/tax/tax-engine.ts` carries a TODO
listing exactly these. Worth a professional opinion before international volume
grows.

**4. Decide whether non-resident consultants are supported at all.** The payout
pipeline hard-throws for them today. Section 194-O does not apply to
non-residents, so supporting them means Section 195 withholding, DTAA relief
against a Tax Residency Certificate and Form 10F, and Form 15CA/15CB per
remittance. The DTAA engine in `lib/compliance/tds.ts` is already written but
unreachable, because both callers hardcode `residencyStatus: "RESIDENT"`. This
is a product decision before it is an engineering one.

**5. Finish the `PaymentGateway` enum removal.** `LEMON_SQUEEZY` and `XFLOW`
still exist in the live enum but not in the schema. The reason this was deferred
— that live rows referenced them — no longer holds: re-checked 2026-07-29, zero
rows in `Payment`, `Refund` or `Dispute` use either value. All that remains is
the mechanics, since Postgres has no `ALTER TYPE … DROP VALUE` and it needs a
type recreation and swap. `scripts/ci/check-db-drift.ts` tolerates the drift
until **2026-09-30**, after which CI fails rather than letting it become
permanent.

## Related

The companion guard `scripts/ci/check-workflow-hygiene.ts` also enforces that no
two scheduled workflows start on the same minute of the same hour. Start-time
collisions do not cause runtime conflicts — every job in this fleet completes in
about sixty seconds — but simultaneous starts contend for the same Supavisor
connection pool, which is the failure mode behind #932.
