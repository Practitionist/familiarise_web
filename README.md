# Familiarise

> **Note:** This project was formerly known as **ConsultX** (2022-2023) and is planned to be rebranded as **Elluminar** in the future.

## What is Familiarise?

Familiarise is a marketplace where people book time with experts. An expert publishes offerings and opens availability, a learner pays and books, and the platform runs the session, takes a platform fee (20% by default) and pays the expert out. It also sells recordings and digital files, and it lets an organisation sponsor its members' learning. Learners can book from anywhere; experts are paid in INR to an Indian bank account.

An expert can publish five kinds of offering: a one-off consultation, a subscription (a fixed number of sessions over a term), a webinar (a seat at one broadcast), a class (a seat in a series of sessions) and a free trial session that can convert into a purchase. The architecture is described in [Platform Architecture](docs/start-here/04-platform-architecture.md).

### Who is it for?

- **Experts (consultants)** are mentors, coaches, instructors and industry professionals who want to sell their time, courses and files. They set availability, receive requests, run sessions over video and chat, and track earnings and payouts.
- **Learners (consultees)** are career changers, students and working professionals who book sessions, join webinars and classes, buy recordings and digital products, and review what they bought.
- **Organisations** sponsor members' bookings through licensed seats or a credit pool, a prepaid wallet and consolidated invoices, and can sign members in through their own single sign-on. See the [enterprise docs](docs/enterprise/README.md).
- **Staff and admins** run the back office: support cases, moderation, refunds, disputes, payouts, compliance filings and system jobs.

### Key Features

| Feature                             | Description                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Consultations and trials**        | One-off sessions, and free trial sessions that can convert into a paid plan.                                                                       |
| **Subscriptions**                   | A fixed number of sessions over a term, booked against the expert's availability.                                                                  |
| **Classes and webinars**            | Seats in scheduled group sessions; a full webinar or class is simply sold out.                                                                     |
| **Scheduling**                      | Timezone-aware booking from the expert's weekly or custom availability, with reschedules and cancellations.                                        |
| **Video and chat**                  | Live meetings and direct messages through Stream, with optional recording ([chat and video HLD](docs/start-here/06-chat-and-video-system-hld.md)). |
| **Recordings and digital products** | Experts sell session replays and downloadable files; buyers keep access.                                                                           |
| **Payments and invoices**           | Razorpay checkout, GST tax invoices, refunds and credit notes, and a double-entry ledger ([money HLD](docs/start-here/02-money-system-hld.md)).    |
| **Earnings and payouts**            | Expert earnings are held, released and paid out through RazorpayX in INR, with TDS withheld where the law requires it.                             |
| **Collaborators**                   | Several experts can co-host a webinar or class and share its revenue by role.                                                                      |
| **Referrals**                       | Referral links that reward both the referrer and the new user with credits.                                                                        |
| **Organisations**                   | Sponsored seats or credit pools, a prepaid wallet, consolidated invoices and single sign-on for members.                                           |
| **Support and reviews**             | Support cases with decisions and appeals, session feedback and public reviews.                                                                     |

## Subsystem map

The platform is 28 subsystems in six areas. Each row links the documentation that exists today. "No doc yet" means no dedicated folder or explainer exists; nothing is invented to fill the gap. The indexes are [`docs/README.md`](docs/README.md) and [`docs/start-here/README.md`](docs/start-here/README.md).

| Area                                  | Subsystem                                                             | Documentation                                                                                                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity and discovery (4)**        | Authentication and account onboarding                                 | [`docs/authentication/`](docs/authentication/README.md), [`docs/onboarding/`](docs/onboarding/README.md)                                                                                                    |
|                                       | Authorization and tenancy                                             | [`docs/authorization/`](docs/authorization/README.md)                                                                                                                                                       |
|                                       | Profiles and expert verification                                      | [Verification lifecycle](docs/onboarding/04-verification-lifecycle.md), [`docs/onboarding/`](docs/onboarding/README.md)                                                                                     |
|                                       | Offerings, catalog and search                                         | No doc yet                                                                                                                                                                                                  |
| **Booking and commerce (8)**          | Scheduling and calendar                                               | [`docs/calendar/`](docs/calendar/), [availability contract](docs/onboarding/03-availability-contract.md)                                                                                                    |
|                                       | Booking lifecycle                                                     | [`docs/booking/`](docs/booking/README.md), [booking HLD](docs/start-here/01-booking-system-hld.md)                                                                                                          |
|                                       | Checkout and payments                                                 | [`docs/finance/10-money-in/`](docs/finance/10-money-in/01-checkout-and-pricing.md), [money HLD](docs/start-here/02-money-system-hld.md)                                                                     |
|                                       | Pricing and discounts                                                 | [`docs/pricing/`](docs/pricing/README.md), [one order, one pipeline](docs/pricing/01-one-order-pipeline.md)                                                                                                 |
|                                       | Ledger and earnings                                                   | [`docs/finance/20-ledger/`](docs/finance/20-ledger/01-double-entry-model.md), [earnings lifecycle](docs/finance/40-payouts/02-earnings-lifecycle.md)                                                        |
|                                       | Payouts                                                               | [`docs/finance/40-payouts/`](docs/finance/40-payouts/01-how-payouts-work.md)                                                                                                                                |
|                                       | Refunds, disputes, chargebacks and clawbacks                          | [`docs/finance/30-refunds-disputes/`](docs/finance/30-refunds-disputes/README.md), [organisation payouts and clawbacks](docs/finance/40-payouts/05-org-payouts-and-clawbacks.md)                            |
|                                       | Digital products                                                      | [`docs/digital-products/`](docs/digital-products/01-architecture.md)                                                                                                                                        |
| **Communication and content (5)**     | Chat                                                                  | [`docs/stream/`](docs/stream/README.md), [chat and video HLD](docs/start-here/06-chat-and-video-system-hld.md)                                                                                              |
|                                       | Video and recordings                                                  | [`docs/stream/`](docs/stream/README.md), [recordings lifecycle](docs/stream/19-recordings-lifecycle-and-access.md)                                                                                          |
|                                       | Notifications and email                                               | [`docs/notifications/`](docs/notifications/01-architecture.md), [`docs/email/`](docs/email/README.md)                                                                                                       |
|                                       | Growth: newsletter, announcements, appointment waitlist and referrals | [`docs/growth/`](docs/growth/README.md)                                                                                                                                                                     |
|                                       | Documents and storage                                                 | [`docs/documents/`](docs/documents/README.md), [`docs/storage/`](docs/storage/management-strategy.md)                                                                                                       |
| **Business relationships (3)**        | Enterprise and organizations                                          | [`docs/enterprise/`](docs/enterprise/README.md), [enterprise design](docs/start-here/07-enterprise-system-design.md)                                                                                        |
|                                       | Collaborators                                                         | [`docs/collaborators/`](docs/collaborators/00-overview.md)                                                                                                                                                  |
|                                       | Referrals and credits                                                 | [`docs/referrals/`](docs/referrals/00-overview.md), [referral credits ledger](docs/finance/20-ledger/07-referral-credits.md), [growth view](docs/growth/03-referrals.md)                                    |
| **Customer experience and trust (4)** | Support                                                               | [`docs/support/`](docs/support/README.md), [support design](docs/start-here/05-support-system-design.md)                                                                                                    |
|                                       | Feedback and reviews                                                  | [`docs/feedback/`](docs/feedback/README.md), [`docs/reviews/`](docs/reviews/01-architecture.md)                                                                                                             |
|                                       | Moderation and abuse                                                  | No folder yet; see [moderation enforcement decision](docs/decisions/2026-07-11-moderation-enforcement-and-peer-chat-block.md) and [rate limiting and abuse](docs/authentication/rate-limiting-and-abuse.md) |
|                                       | Compliance, privacy and consent                                       | [`docs/compliance/`](docs/compliance/00-overview.md)                                                                                                                                                        |
| **Platform operations (4)**           | Backoffice and admin                                                  | No folder yet; see [backoffice single tree decision](docs/decisions/2026-09-27-backoffice-single-tree-and-capability.md)                                                                                    |
|                                       | Background jobs, maintenance and recovery                             | [`docs/maintenance/`](docs/maintenance/README.md), [jobs that did not run](docs/start-here/08-how-we-know-a-job-did-not-run.md)                                                                             |
|                                       | Observability and incidents                                           | [`docs/observability/`](docs/observability/README.md)                                                                                                                                                       |
|                                       | Infrastructure, deployment and CI/CD                                  | [`docs/deployment/`](docs/deployment/README.md), [SRE orientation](docs/start-here/09-infra-and-maintenance-sre-orientation.md), [environment split](docs/start-here/10-environment-split.md)               |

Large domains such as enterprise and finance contain several independently complex components. Finance spans checkout, the ledger, refunds, payouts, tax and operations, and enterprise spans identity, programs, wallets, invoicing and compliance, so read the folder's own README before assuming one page covers it.

Vendors belong to the subsystem that depends on them:

- **Notifications and email:** Novu (in-app and workflow notifications) and Resend (transactional email).
- **Observability and incidents:** Sentry (errors and cron monitors) and Better Stack (uptime, heartbeats and Telemetry logs).
- **Infrastructure, deployment and CI/CD:** Netlify and Vercel (hosting), DNS, Supabase (Postgres and storage) and Upstash (Redis).

## Repo versus Notion

Every fact has one canonical home, either this repository or the owner's Notion workspace ("Familiarise"). Two tests decide it:

- **Repo test:** would an engineer or an agent need this to build, change or verify the system correctly? Then it belongs in the repo.
- **Notion test:** would a competitor gain from reading it, or is it a number or plan the owner can change without a code change? Then it belongs in Notion.

When both apply, split the fact. The mechanism goes in the repo, and the value or the reasoning goes in Notion. The other side links to the canonical home: a repo doc writes `value kept in Notion (Familiarise / <section>[ / <page>])`, and a Notion page links the repo doc for the mechanism. Notion holds no copies of repo docs. Notion page titles carry outline numbers (a number such as 04.01); pointers name the section and page without the number, so renumbering never breaks a pointer. The documentation skill (`.claude/skills/documentation/SKILL.md`) is what documentation agents apply, and `docs/AGENTS.md` repeats the rule for anyone editing `docs/`.

| Topic             | Repo                                                                                                                                                                                                                                        | Notion                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Product decisions | Product rules that shape behaviour (for example notify-all waitlist; digital products vs sessions vs replays; refund and cancellation policy; trial rules; reward mechanics; attribution precedence) and decision records with alternatives | Strategic why (positioning, which competitor a choice counters)                 |
| Compliance        | Everything implemented: DPDP consent, withdrawal and revocation, erasure, retention windows, grievance process, GST and TDS computation, invoice rules                                                                                      | CA advice, tax planning, entity structure, legal opinions                       |
| Pricing           | The mechanism (fee schedule, how the take rate applies) and terms users see                                                                                                                                                                 | Rationale for the chosen levels, unit economics, price experiments              |
| Fraud and abuse   | Which signals exist and what happens (hold, void)                                                                                                                                                                                           | Threshold values and detection tuning                                           |
| Roadmap           | Engineering roadmap tied to issues (P labels, done-when)                                                                                                                                                                                    | Vision, horizons, launch sequencing                                             |
| Strategy          | None                                                                                                                                                                                                                                        | Competition strategy, war rooms, moat, GTM playbook, positioning                |
| Numbers           | Constants that are part of a rule (a 12-hour re-notice, a 30-day purge, caps users hit)                                                                                                                                                     | Budgets, targets, KPIs, vendor spend, salaries, hiring plans                    |
| Research          | Cited public facts that justify a design, briefly                                                                                                                                                                                           | Competitor teardowns and screenshots, competitor revenue, live metric read-outs |

## High-level design (HLD)

To be written; see [docs/start-here/](docs/start-here/README.md) for the current per-subsystem HLDs.

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- OR Node.js 20+ and npm

### Option 1: Docker (Recommended)

```bash
# 1. Clone the repository
git clone <repository_url>
cd familiarise_web

# 2. Create environment file
cp .env.sample .env
# Edit .env with your credentials (see the Environment variables section)

# 3. Start development server
docker compose up --build

# App runs at http://localhost:3000
```

### Option 2: Local Development

```bash
# 1. Clone and install
git clone <repository_url>
cd familiarise_web
npm install

# 2. Setup environment
cp .env.sample .env
# Edit .env with your credentials

# 3. Generate Prisma client
npx prisma generate

# 4. Start development server
npm run dev
```

## Environment variables

Create a `.env` file from [`.env.sample`](.env.sample) and never commit `.env` or any secret. `.env.sample` is the single place where every variable is described. It is split into groups that match the subsections below (database, authentication, payments, tax and compliance, video and chat, email and notifications, storage, observability, infrastructure and jobs, feature flags, seed, build and platform-provided), and each variable has a one-line comment saying what it is, which subsystem reads it, whether it is required or optional, and whether it is a secret. Every value in it is a placeholder. The test `__tests__/maintenance/env-sample-coverage.test.ts` fails when code reads a key that `.env.sample` does not list, so add a new key there in the same change. Fixed values such as the support mailbox, the sending domains and the invoice prefix are constants in `lib/company.ts`, not environment variables.

Every deploy context shares one database, so a deploy preview is new code pointed at live data; the [environment split](docs/start-here/10-environment-split.md) says which keys differ between local, previews, the branch deploy and production. The inventory of every production secret, with where it lives and how to rotate it, is the [secret rotation runbook](docs/maintenance/19-secret-rotation-runbook.md). Netlify secrets are write-only, so keep each value in the password manager. The groups below explain the variables whose purpose or source is not obvious from the name.

### Database and Supabase

- **`DATABASE_URL` and `DIRECT_URL`** (secret): both come from the Supabase dashboard's connection settings. `DATABASE_URL` is the pooled Supavisor string the app uses at runtime; `DIRECT_URL` is the direct connection used for schema work. Set `PG_POOL_MAX=1` on Netlify, because each function invocation holds one connection.
- **`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`:** the project URL is public. The service-role key is a server-only secret that bypasses row security, so it must never get a `NEXT_PUBLIC_` prefix.
- **Production, preview and local** all point at the same Supabase project today, so a local `.env` reads and writes the shared data. See the [environment split](docs/start-here/10-environment-split.md).

### Authentication (Better Auth, OAuth and Turnstile)

- **`BETTER_AUTH_SECRET`** (secret): generate it with `openssl rand -base64 32` and use a different value per environment. It also derives the key that signs emailed links (newsletter confirm and unsubscribe, account unsubscribe, calendar and support links), so rotating it voids every such link already sent. `BETTER_AUTH_SECRETS` is only used while rotating it. `NEXT_PUBLIC_APP_URL` and `BETTER_AUTH_URL` are the public origin, `http://localhost:3000` locally and `https://familiarisenow.com` in production. `BETTER_AUTH_TRUSTED_ORIGINS` lists extra origins of our own, such as deploy-preview URLs.
- **`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`:** from a GitHub OAuth app and a Google Cloud OAuth client. A provider's button appears only when both of its values are set, and the callback URL must match the origin you run on. Ids are public, secrets are not.
- **`NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`:** from the Cloudflare Turnstile dashboard. Locally, keep Cloudflare's always-pass test keys that `.env.sample` ships. Production refuses a test key. Set both or neither.
- **`AUTH_CONFIG_ENCRYPTION_KEY`** (secret): encrypts the single sign-on configuration an organisation registers. Generate it with `openssl rand -hex 32`. It is a different key from `PAN_ENCRYPTION_KEY` so that rotating one never rewrites the other. See [`docs/authentication/`](docs/authentication/README.md).

### Payments (Razorpay and RazorpayX)

- **`RAZORPAY_KEY_ID`, `NEXT_PUBLIC_RAZORPAY_KEY_ID` and `RAZORPAY_SECRET`:** from the Razorpay dashboard. Use the test pair (`rzp_test_`) locally and on previews, and the live pair at cutover. The two key-id variables hold the same value; the secret never gets a `NEXT_PUBLIC_` prefix.
- **`RAZORPAY_WEBHOOK_SECRET` and `RAZORPAYX_WEBHOOK_SECRET`:** you choose these when you create the webhook on each dashboard, and the dashboard and the deployment must hold the same value. The `_PREVIOUS` variants exist only while you rotate.
- **`RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION`:** lets a pre-launch production deploy run on test keys. Delete it when the live keys go in, because without it a test key in production fails at boot.
- **`RAZORPAYX_KEY_ID`, `RAZORPAYX_KEY_SECRET` and `RAZORPAYX_ACCOUNT_NUMBER`:** from RazorpayX, which is the payouts product and is separate from checkout. The key pair falls back to the Razorpay pair when unset; the account number has no fallback.
- **`RAZORPAYX_EGRESS_PROXY_URL`:** the QuotaGuard Static proxy URL, bought at the first live payout because live RazorpayX only answers allowlisted IPs and Netlify has none. Do not set it earlier.
- **`ENABLE_LIVE_PAYOUTS`:** the kill switch. Only the literal `true` lets a payout leave. The steps are in the [money go-live checklist](docs/finance/70-operations/07-go-live-checklist.md).

### Tax, compliance and encryption

- **`PLATFORM_GSTIN`:** the platform's GSTIN, issued after GST registration. Leave it empty until then; the GST jobs record a config skip meanwhile, which the health check treats as expected. Set it before the live Razorpay keys.
- **`PLATFORM_LUT_NUMBER` and `PLATFORM_LUT_VALID_TILL`:** the Letter of Undertaking for zero-rated exports, with the date as `YYYY-MM-DD`. Without both, exports are taxed at 18% IGST.
- **`CLEARTAX_API_KEY`, `CLEARTAX_GSP_TOKEN` and `CLEARTAX_ENV`:** from ClearTax. The e-invoice uploader stays dormant until all of them and `PLATFORM_GSTIN` are set.
- **`PAN_ENCRYPTION_KEY` and `ERASURE_SALT`** (secrets): generate each with `openssl rand -hex 32`. The PAN key has no previous slot and no re-encrypt script, so changing it leaves every stored consultant PAN unreadable. The salt only changes future pseudonyms when rotated.

### Video and chat (Stream)

- **`STREAM_API_KEY` and `NEXT_PUBLIC_STREAM_API_KEY`:** the same public key, from the Stream dashboard for the app. **`STREAM_API_SECRET`** is the secret that mints user tokens. Setup is in [`docs/stream/02-setup-configuration.md`](docs/stream/02-setup-configuration.md).
- **Previews share the production Stream app** today, so a chat or call on a preview lands in production Stream. See the [environment split](docs/start-here/10-environment-split.md).
- **`STREAM_WEBHOOK_SECRET`:** optional; webhooks are signed with `STREAM_API_SECRET` when it is unset. `STREAM_SYNC_EXCLUDED_USERS` lists Stream user ids the sync job must never delete.

### Email and notifications (Resend and Novu)

- **`RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`:** from the Resend dashboard. The webhook signing secret is shown on the webhook you create for `/api/webhooks/resend`. See [`docs/email/README.md`](docs/email/README.md).
- **`EMAIL_DELIVERY_MODE` and `EMAIL_ALLOWLIST`:** the pre-launch guard. Unset or `allowlist` sends only to our own domain and the allowlist; `live` sends to everyone. Production stays on allowlist until launch.
- **`NOVU_DEVELOPMENT_KEY` and `NOVU_PRODUCTION_KEY`:** secret keys from the Novu dashboard, one per Novu environment. Production reads the production key and every other context reads the development key. **`NEXT_PUBLIC_NOVU_APP_ID`** is the public application identifier. See [`docs/notifications/`](docs/notifications/01-architecture.md).

### Storage (Cloudflare R2 and Supabase Storage)

- **`R2_BUCKET`, `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`:** from the Cloudflare R2 dashboard. Create an S3 API token scoped to the one bucket and copy its endpoint URL. The bucket holds the platform's copy of every recording. The access key id and secret are secrets.
- **`R2_DIGITAL_PRODUCTS_BUCKET`:** a second, private R2 bucket on the same credentials for digital product files. Its CORS policy must allow `PUT` and `GET` from the app origins; the exact headers are in the [digital products architecture](docs/digital-products/01-architecture.md).
- **`SUPABASE_DATA_EXPORT_BUCKET`:** optional name of the Supabase Storage bucket for organisation data exports. The default is `org-exports`. Other Supabase buckets are provisioned by the app; see the [storage strategy](docs/storage/management-strategy.md).

### Observability (Sentry and Better Stack)

- **`NEXT_PUBLIC_SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_ENVIRONMENT`:** the DSN is in the Sentry project settings and is public. The environment is `production`, `preview` or `development`; the code reads it as the marker of where it runs, so a wrong value changes behaviour.
- **Three different Sentry tokens.** `SENTRY_AUTH_TOKEN` is build-time only and uploads source maps. `SENTRY_STATS_TOKEN` is an Internal Integration token with `Organization: Read`, used by the daily ingest canary ([steps](docs/observability/sentry/06-ingest-canary.md)). `SENTRY_API_TOKEN` is an optional runtime token with `event:read` for the back-office triage lookup. Never reuse one for another.
- **`SENTRY_IDENTITY_ENABLED`, `NEXT_PUBLIC_SENTRY_IDENTITY_ENABLED` and `SENTRY_IDENTITY_SALT`:** off by default. When on, events carry a hashed user token, never the raw id.
- **`BETTERSTACK_SOURCE_TOKEN` and `BETTERSTACK_INGEST_URL`:** from the Better Stack Telemetry source you create for logs, used only when `ENABLE_BETTERSTACK_TELEMETRY` is `true`. **`BETTERSTACK_API_KEY`** is a different token, from Better Stack Uptime. **`BETTERSTACK_HEARTBEAT_URL` and `BETTERSTACK_DIGEST_HEARTBEAT_URL`** are the heartbeat URLs of the ticker and the daily digest, production only. All of these are described in the [Better Stack setup guide](docs/maintenance/00-betterstack-setup.md).
- **`OBSERVABILITY_ALERT_EMAIL`, `SLACK_OPS_WEBHOOK_URL` and `GITHUB_RELEASE_LAG_TOKEN`:** optional alert channels. The Slack value is an incoming-webhook URL and is secret. The GitHub token needs only `Contents: read` on this repository.

### Infrastructure and jobs (Netlify, Upstash and `CRON_SECRET`)

- **`CRON_SECRET`** (secret): generate it with `openssl rand -hex 32`. It gates every `/api/cleanup/*` route and the Netlify ticker, and the same value is also stored in the Better Stack and Sentry monitor headers, so a rotation touches all three places. See the [secret rotation runbook](docs/maintenance/19-secret-rotation-runbook.md).
- **`CRON_TICK_BASE_URL`:** optional. Where the ticker posts; it defaults to the deploy URL Netlify provides.
- **`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`:** from the Upstash console, REST API section. The platform reaches Redis over REST only. Do not set `REDIS_URL` on Netlify. Local, previews and production share one Redis database today.
- **`UPSTASH_MANAGEMENT_API_KEY`, `UPSTASH_EMAIL`, `UPSTASH_DATABASE_ID` and `UPSTASH_MONTHLY_COMMAND_CAP`:** optional, for the usage line in the daily digest. They are Upstash account credentials, not the database REST token.
- **`MAINTENANCE_BYPASS_SECRET`:** optional secret that lets an operator through maintenance mode when none is stored in Redis.
- **The scheduled fleet switch** is not an environment variable but the Upstash key `ops:active_cron_platform`; see the [pause decision](docs/decisions/2026-11-06-pause-scheduled-jobs-prelaunch.md).

The feature flags (`ENABLE_*`, `TDS_ENGINE`, `RATE_CARD_SCOPED_RESOLUTION`), the seed variables and the build-only variables are self-explanatory from their comments in `.env.sample`. `NEXT_PUBLIC_ENABLE_DEV_TOOLS` must never be `true` in production.

### Payment rails

Razorpay is the only live rail (INR settlement); Stripe was removed from the code on 2026-10-04. `DODO_PAYMENTS` exists only as a `PaymentGateway` enum value. There is no client, checkout path, webhook handler, payout submitter or timeline behind it, and it throws `UnsupportedGatewayError` if it ever reaches gateway routing, a refund or a payout. Dodo has never moved money and appears in no reconciliation or filing. The other options were evaluated and are either rejected or deferred with a revisit trigger; none has code. See [the gateway decision](docs/decisions/2026-11-09-payment-gateways-one-rail.md) and [the gateway page](docs/finance/10-money-in/04-razorpay-gateway-and-currency.md).

### Production vs local checklist

When deploying to production (Netlify), ensure:

- [ ] All `localhost:3000` URLs replaced with `https://familiarisenow.com`
- [ ] `NODE_ENV` set to `production`
- [ ] `SEED_PASSWORD` removed
- [ ] `REDIS_URL` removed (use `UPSTASH_REDIS_REST_URL` instead)
- [ ] Payment keys switched from `test` to `live` when going live (see the go-live highlights below)
- [ ] `BETTER_AUTH_SECRET` is a unique production secret
- [ ] No credentials committed to the repository

## Go-live checklist highlights

Taking the platform from sandbox to real money is a short ordered list of owner steps. This is the highlights version; the full checklist, with the proof for every step, is [the money go-live checklist](docs/finance/70-operations/07-go-live-checklist.md), and the agent-facing index is the [go-live skill](.claude/skills/go-live/SKILL.md). Do these in order, because some steps only make sense after an earlier one.

1. **Resume the paused job fleet.** The scheduled jobs are deliberately paused until launch, and nothing runs on schedule until the Upstash key `ops:active_cron_platform` is deleted or set to `netlify`. The resume steps are in [the pause decision](docs/decisions/2026-11-06-pause-scheduled-jobs-prelaunch.md#how-to-resume-go-live-or-any-time).
2. **Run the pre-launch secret rotation.** Several credentials were exposed before launch, and Netlify secrets are write-only, so follow the ordered procedures in the [secret rotation runbook](docs/maintenance/19-secret-rotation-runbook.md).
3. **Set `PLATFORM_GSTIN` before the Razorpay live keys.** Until it is set, the GST jobs record a config skip that the ops digest notes as expected and the health check ignores; once it is set, any config skip pages. See [1.2 Keys and the test-key guard](docs/finance/70-operations/07-go-live-checklist.md#12-keys-and-the-test-key-guard).
4. **Make the daily ops digest read clean.** The latest digest email must show no config skips and no paused or muted monitor. See [Part 3](docs/finance/70-operations/07-go-live-checklist.md#part-3-the-daily-ops-digest-reads-clean).
5. **Set `EMAIL_DELIVERY_MODE=live`.** Any other value holds every email to a domain other than ours and the allowlist. The digest's "Settings" line shows the current value ([Part 3](docs/finance/70-operations/07-go-live-checklist.md#part-3-the-daily-ops-digest-reads-clean)).
6. **Clear the sandbox identities.** Razorpay rejects every test-mode customer, contact and fund-account id under a live key, so run the purge once, in the cutover window, and never again after live traffic. See [1.5 Clear sandbox identities from the database](docs/finance/70-operations/07-go-live-checklist.md#15-clear-sandbox-identities-from-the-database).
7. **Switch to the Razorpay live keys and prove them with two live ₹1 tests**, a checkout and a full refund ([1.2](docs/finance/70-operations/07-go-live-checklist.md#12-keys-and-the-test-key-guard) and [1.6](docs/finance/70-operations/07-go-live-checklist.md#16-proof-for-collection-two-live-1-tests)).
8. **Unpause the eight Better Stack Telemetry alerts after the go-live data reset and once every money gauge reads zero.** They were created paused because seeded and QA money rows would fire them, and the digest cannot see them, so tick each one off. See [2.1 Pre-flip checks](docs/finance/70-operations/07-go-live-checklist.md#21-pre-flip-checks) and the [Better Stack setup guide](docs/maintenance/00-betterstack-setup.md).
9. **Buy the Better Stack responder seat** (phone and SMS paging) and the Telemetry bundle, then add phone and SMS to the four money backlog alerts. Also in [2.1 Pre-flip checks](docs/finance/70-operations/07-go-live-checklist.md#21-pre-flip-checks).
10. **Buy static egress for RazorpayX (QuotaGuard) at the first live payout.** Live RazorpayX APIs answer only allowlisted IPs and Netlify has none, so every payout call refuses without `RAZORPAYX_EGRESS_PROXY_URL`. See the "Static egress" item in [2.1 Pre-flip checks](docs/finance/70-operations/07-go-live-checklist.md#21-pre-flip-checks).
11. **Flip RazorpayX payouts with a canary.** Set `ENABLE_LIVE_PAYOUTS=true`, redeploy, pay exactly one small verified payout (₹1.00 is enough), and watch it reach `COMPLETED` before releasing the rest. See [2.3 Flip, canary, rollback](docs/finance/70-operations/07-go-live-checklist.md#23-flip-canary-rollback) and [Part 2](docs/finance/70-operations/07-go-live-checklist.md#part-2-paying-out-real-money-razorpayx).
12. **Optional: show the company details in the footer again.** The footer shows only the copyright line with the operating company's name; the CIN, registered office and contact email are on `/grievance` and the terms, privacy and refund pages. To add them back under the copyright line, revert the commit "copy(footer): drop the CIN and registered-office line from the footer" (`git log --grep 'drop the CIN'`). See step 16 of the [go-live skill](.claude/skills/go-live/SKILL.md).

### Payment and tax prerequisites

These constraints explain why the product statement says experts are paid in INR to an Indian bank account. They are deliberate, and removing a refusal would create a statutory failure rather than a feature.

- **Learners can pay from anywhere.** International cards are accepted, Razorpay converts at the buyer's bank, and the platform settles in INR only. Enforcement is described in [the gateway page](docs/finance/10-money-in/04-razorpay-gateway-and-currency.md).
- **Experts must be able to receive INR in India.** TDS is withheld under Section 194-O, which applies only to residents. Paying a non-resident would need Section 195 withholding, treaty relief and a Form 15CA/15CB filing per remittance, none of which exists, and RazorpayX cannot pay a foreign bank account. `processSinglePayout` therefore refuses a non-resident payee, and consultant onboarding says so. See [TDS withholding](docs/finance/40-payouts/06-tds-withholding.md).
- **Tax invoices need `PLATFORM_GSTIN`** (step 3), and zero-rated exports need a valid Letter of Undertaking, otherwise they are taxed at 18% IGST.

## Docker Commands

### Development

```bash
# Start with hot-reload
docker compose up --build

# Start in background
docker compose up -d --build

# View logs
docker compose logs -f web

# Stop
docker compose down

# Rebuild from scratch
docker compose down -v && docker compose up --build
```

### Production

```bash
# Build and run production
docker compose -f docker-compose.prod.yml up --build -d

# View logs
docker compose -f docker-compose.prod.yml logs -f

# Stop
docker compose -f docker-compose.prod.yml down
```

## Development

### Available Scripts

```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run ESLint
npm run format:write # Format with Prettier
npm run studio       # Open Prisma Studio
npm run db:push      # Push schema to database
```

### Database (Prisma)

```bash
# Generate client after schema changes
npx prisma generate

# Push schema changes to Supabase
npx prisma db push

# Open database GUI
npx prisma studio
```

## Architecture

- **Framework:** Next.js 15 with App Router and React 18
- **Database:** PostgreSQL via Supabase
- **ORM:** Prisma 7
- **Auth:** Better Auth
- **Payments:** Razorpay
- **Real-time:** Stream.io
- **Styling:** Tailwind CSS

[View Entity Relationship Diagram](https://claude.site/artifacts/cba3bcba-1810-49d4-93f4-2e5c63bde35e)

## Troubleshooting

### Docker Issues

**Container won't start:**

```bash
# Check logs
docker compose logs web

# Ensure .env file exists and has required variables
cat .env | grep -E "^(DATABASE_URL|BETTER_AUTH)"
```

**Hot reload not working:**

```bash
# Restart with fresh volumes
docker compose down -v
docker compose up --build
```

**Prisma errors:**

```bash
# Regenerate client inside container
docker compose exec web npx prisma generate
```

### Build Issues

**bcrypt/sharp errors:**
These require native compilation. In Docker, this is handled automatically. For local development:

```bash
npm rebuild bcrypt
npm rebuild sharp
```
