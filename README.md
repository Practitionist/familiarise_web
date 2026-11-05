# Familiarise

> **Note:** This project was formerly known as **ConsultX** (2022-2023) and is planned to be rebranded as **Elluminar** in the future.

## Go-live checklist highlights

Taking the platform from sandbox to real money is a short ordered list of owner steps. This is the highlights version; the full checklist, with the proof for every step, is [the money go-live checklist](docs/finance/70-operations/07-go-live-checklist.md). Do these in order, because some steps only make sense after an earlier one.

1. **Resume the paused job fleet.** The scheduled jobs are deliberately paused until launch, and nothing runs on schedule until the Upstash key `ops:active_cron_platform` is deleted or set to `netlify`. The resume steps are in [the pause decision](docs/decisions/2026-11-06-pause-scheduled-jobs-prelaunch.md). That file is not on `dev` yet. It arrives with the open pull request #2615 on the branch `docs/pause-scheduled-jobs-prelaunch`, so this link resolves only after that pull request merges.
2. **Run the pre-launch secret rotation.** Several credentials were exposed before launch, and Netlify secrets are write-only, so follow the ordered procedures in the [secret rotation runbook](docs/maintenance/19-secret-rotation-runbook.md).
3. **Set `PLATFORM_GSTIN` before the Razorpay live keys.** Until it is set, the invoice jobs record a standing config skip, and live keys turn that skip into a page. See [1.2 Keys and the test-key guard](docs/finance/70-operations/07-go-live-checklist.md#12-keys-and-the-test-key-guard).
4. **Make the daily ops digest read clean.** The latest digest email must show no config skips and no paused or muted monitor. See [Part 3](docs/finance/70-operations/07-go-live-checklist.md#part-3-the-daily-ops-digest-reads-clean).
5. **Set `EMAIL_DELIVERY_MODE=live`.** Any other value holds every email to a domain other than ours and the allowlist. The digest's "Settings" line shows the current value ([Part 3](docs/finance/70-operations/07-go-live-checklist.md#part-3-the-daily-ops-digest-reads-clean)).
6. **Clear the sandbox identities.** Razorpay rejects every test-mode customer, contact and fund-account id under a live key, so run the purge once, in the cutover window, and never again after live traffic. See [1.5 Clear sandbox identities from the database](docs/finance/70-operations/07-go-live-checklist.md#15-clear-sandbox-identities-from-the-database).
7. **Switch to the Razorpay live keys and prove them with two live ₹1 tests**, a checkout and a full refund ([1.2](docs/finance/70-operations/07-go-live-checklist.md#12-keys-and-the-test-key-guard) and [1.6](docs/finance/70-operations/07-go-live-checklist.md#16-proof-for-collection-two-live-1-tests)).
8. **Unpause the eight Better Stack Telemetry alerts after the go-live data reset.** They were created paused because seeded and QA money rows would fire them, and the digest cannot see them, so tick each one off. See [2.1 Pre-flip checks](docs/finance/70-operations/07-go-live-checklist.md#21-pre-flip-checks).
9. **Buy the Better Stack responder seat** (phone and SMS paging) and the Telemetry bundle, then add phone and SMS to the four money backlog alerts. Also in [2.1 Pre-flip checks](docs/finance/70-operations/07-go-live-checklist.md#21-pre-flip-checks).
10. **Buy static egress for RazorpayX (QuotaGuard) at the first live payout.** Live RazorpayX APIs answer only allowlisted IPs and Netlify has none, so every payout call refuses without `RAZORPAYX_EGRESS_PROXY_URL`. See the "Static egress" item in [2.1 Pre-flip checks](docs/finance/70-operations/07-go-live-checklist.md#21-pre-flip-checks).
11. **Flip RazorpayX payouts with a canary.** Set `ENABLE_LIVE_PAYOUTS=true`, redeploy, pay exactly one small verified payout (₹1.00 is enough), and watch it reach `COMPLETED` before releasing the rest. See [2.3 Flip, canary, rollback](docs/finance/70-operations/07-go-live-checklist.md#23-flip-canary-rollback) and [Part 2](docs/finance/70-operations/07-go-live-checklist.md#part-2-paying-out-real-money-razorpayx).

## What is Familiarise?

Familiarise is a **B2B/B2C marketplace platform** that connects world-class experts—mentors, consultants, coaches, and instructors—with learners seeking personalized guidance, mentorship, and education.

Think of it as the "Airbnb for expertise": a platform where professionals can monetize their knowledge through one-on-one sessions, ongoing mentorship programs, structured courses, and live webinars, while learners get direct access to industry experts who can accelerate their careers and skill development.

### Who is it for?

**For Experts (Consultants):**

- Industry professionals looking to monetize their expertise
- Career coaches and mentors
- Subject matter experts and educators
- Entrepreneurs sharing startup knowledge
- Specialists in tech, business, design, marketing, and more

**For Learners (Consultees):**

- Career changers breaking into new fields
- Professionals seeking advancement
- Students wanting industry guidance
- Entrepreneurs needing business mentorship
- Anyone seeking personalized skill development

### Key Features

| Feature                  | Description                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1-on-1 Consultations** | Single sessions for career advice, mock interviews, code reviews, design feedback                                                                   |
| **Subscriptions**        | Ongoing 4-12 week mentorship programs with recurring sessions                                                                                       |
| **Classes**              | Structured multi-week courses with materials, recordings, and certifications                                                                        |
| **Webinars**             | Live group learning events with Q&A and waitlist management                                                                                         |
| **Video Calls**          | HD video via Stream.io with screen sharing and recording                                                                                            |
| **In-App Messaging**     | Direct communication and document sharing between sessions                                                                                          |
| **Document Review**      | Upload resumes, portfolios, or code for expert feedback                                                                                             |
| **Smart Scheduling**     | Timezone-aware booking with weekly and custom availability                                                                                          |
| **Secure Payments**      | Razorpay (INR settlement), with escrow protection. **Consultees book from anywhere; consultants must be able to receive INR in India** — see below. |
| **Earnings Dashboard**   | 80/20 revenue split with transparent payout tracking                                                                                                |
| **Referral System**      | Viral growth via referral links, credit rewards for referrer and referee                                                                            |
| **Collaborators**        | Multi-creator webinars and classes with role-based revenue sharing                                                                                  |

### Platform Stats

- 500+ verified expert mentors
- 8+ domains (Technology, Business, Design, Marketing, Career Coaching, Education, Startups, Languages)
- Multiple session types to fit any learning style
- Money-back guarantee for unsatisfied sessions

## Who can use this, and from where

This distinction is load-bearing and easy to get backwards, so it is stated up
front rather than buried in the payments docs.

**Consultees can be anywhere in the world.** International cards are accepted,
Razorpay converts at the buyer's bank and settles INR to the platform, and the
FIRC needed under FEMA is generated automatically. Nothing blocks a foreign
buyer and nothing should — this is live and working.

**Consultants must be able to receive INR into an Indian bank account.** This is
not a preference, it is what is currently built. TDS is withheld under Section
194-O, which by definition applies only to residents; paying a non-resident
instead requires Section 195 withholding, treaty relief against a tax residency
certificate and Form 10F, and a Form 15CA/15CB filing per remittance, none of
which exists yet. RazorpayX also cannot pay a foreign bank account at all. The
payout pipeline enforces this: `processSinglePayout` throws rather than
half-paying someone, and the UI says so during consultant onboarding.

If you are changing payout code and wondering why the non-resident branch
refuses instead of falling through — that is deliberate, and removing it would
create a statutory withholding failure, not a feature.

## Subsystem map

The platform is 27 subsystems in six areas. Each row links the documentation that exists today. "No doc yet" means no dedicated folder or explainer exists; nothing is invented to fill the gap. The indexes are [`docs/README.md`](docs/README.md) and [`docs/start-here/README.md`](docs/start-here/README.md).

| Area                                  | Subsystem                                    | Documentation                                                                                                                                                                                               |
| ------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity and discovery (4)**        | Authentication and account onboarding        | [`docs/authentication/`](docs/authentication/README.md), [`docs/onboarding/`](docs/onboarding/README.md)                                                                                                    |
|                                       | Authorization and tenancy                    | [`docs/authorization/`](docs/authorization/README.md)                                                                                                                                                       |
|                                       | Profiles and expert verification             | [Verification lifecycle](docs/onboarding/04-verification-lifecycle.md), [`docs/onboarding/`](docs/onboarding/README.md)                                                                                     |
|                                       | Offerings, catalog and search                | No doc yet                                                                                                                                                                                                  |
| **Booking and commerce (7)**          | Scheduling and calendar                      | [`docs/calendar/`](docs/calendar/), [availability contract](docs/onboarding/03-availability-contract.md)                                                                                                    |
|                                       | Booking lifecycle                            | [`docs/booking/`](docs/booking/README.md), [booking HLD](docs/start-here/01-booking-system-hld.md)                                                                                                          |
|                                       | Checkout and payments                        | [`docs/finance/10-money-in/`](docs/finance/10-money-in/01-checkout-and-pricing.md), [money HLD](docs/start-here/02-money-system-hld.md)                                                                     |
|                                       | Ledger and earnings                          | [`docs/finance/20-ledger/`](docs/finance/20-ledger/01-double-entry-model.md), [earnings lifecycle](docs/finance/40-payouts/02-earnings-lifecycle.md)                                                        |
|                                       | Payouts                                      | [`docs/finance/40-payouts/`](docs/finance/40-payouts/01-how-payouts-work.md)                                                                                                                                |
|                                       | Refunds, disputes, chargebacks and clawbacks | [`docs/finance/30-refunds-disputes/`](docs/finance/30-refunds-disputes/README.md), [organisation payouts and clawbacks](docs/finance/40-payouts/05-org-payouts-and-clawbacks.md)                            |
|                                       | Digital products                             | [`docs/digital-products/`](docs/digital-products/01-architecture.md)                                                                                                                                        |
| **Communication and content (5)**     | Chat                                         | [`docs/stream/`](docs/stream/README.md), [chat and video HLD](docs/start-here/06-chat-and-video-system-hld.md)                                                                                              |
|                                       | Video and recordings                         | [`docs/stream/`](docs/stream/README.md), [recordings lifecycle](docs/stream/19-recordings-lifecycle-and-access.md)                                                                                          |
|                                       | Notifications and email                      | [`docs/notifications/`](docs/notifications/01-architecture.md), [`docs/email/`](docs/email/README.md)                                                                                                       |
|                                       | Marketing, waitlist and announcements        | No doc yet                                                                                                                                                                                                  |
|                                       | Documents and storage                        | [`docs/documents/`](docs/documents/README.md), [`docs/storage/`](docs/storage/management-strategy.md)                                                                                                       |
| **Business relationships (3)**        | Enterprise and organizations                 | [`docs/enterprise/`](docs/enterprise/README.md), [enterprise design](docs/start-here/07-enterprise-system-design.md)                                                                                        |
|                                       | Collaborators                                | [`docs/collaborators/`](docs/collaborators/00-overview.md)                                                                                                                                                  |
|                                       | Referrals and credits                        | [`docs/referrals/`](docs/referrals/00-overview.md), [referral credits ledger](docs/finance/20-ledger/07-referral-credits.md)                                                                                |
| **Customer experience and trust (4)** | Support                                      | [`docs/support/`](docs/support/README.md), [support design](docs/start-here/05-support-system-design.md)                                                                                                    |
|                                       | Feedback and reviews                         | [`docs/feedback/`](docs/feedback/README.md), [`docs/reviews/`](docs/reviews/01-architecture.md)                                                                                                             |
|                                       | Moderation and abuse                         | No folder yet; see [moderation enforcement decision](docs/decisions/2026-07-11-moderation-enforcement-and-peer-chat-block.md) and [rate limiting and abuse](docs/authentication/rate-limiting-and-abuse.md) |
|                                       | Compliance, privacy and consent              | [`docs/compliance/`](docs/compliance/00-overview.md)                                                                                                                                                        |
| **Platform operations (4)**           | Backoffice and admin                         | No folder yet; see [backoffice single tree decision](docs/decisions/2026-09-27-backoffice-single-tree-and-capability.md)                                                                                    |
|                                       | Background jobs, maintenance and recovery    | [`docs/maintenance/`](docs/maintenance/README.md), [jobs that did not run](docs/start-here/08-how-we-know-a-job-did-not-run.md)                                                                             |
|                                       | Observability and incidents                  | [`docs/observability/`](docs/observability/README.md)                                                                                                                                                       |
|                                       | Infrastructure, deployment and CI/CD         | [`docs/deployment/`](docs/deployment/README.md), [SRE orientation](docs/start-here/09-infra-and-maintenance-sre-orientation.md), [environment split](docs/start-here/10-environment-split.md)               |

Large domains such as enterprise and finance contain several independently complex components. Finance spans checkout, the ledger, refunds, payouts, tax and operations, and enterprise spans identity, programs, wallets, invoicing and compliance, so read the folder's own README before assuming one page covers it.

Vendors belong to the subsystem that depends on them:

- **Notifications and email:** Novu (in-app and workflow notifications) and Resend (transactional email).
- **Observability and incidents:** Sentry (errors and cron monitors) and Better Stack (uptime, heartbeats and Telemetry logs).
- **Infrastructure, deployment and CI/CD:** Netlify and Vercel (hosting), DNS, Supabase (Postgres and storage) and Upstash (Redis).

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

Create a `.env` file from [`.env.sample`](.env.sample) and never commit `.env` or any secret. `.env.sample` is the single place where every variable is described. It is grouped into eight sections (core runtime, vendors, compliance and encryption, ops and observability, pre-launch guards and feature flags, seed only, build only, platform-provided), and each variable has a one-line comment saying what it is, which subsystem reads it, whether it is required or optional, and whether it is a secret. Every value in it is a placeholder. The test `__tests__/maintenance/env-sample-coverage.test.ts` fails when code reads a key that `.env.sample` does not list, so add a new key there in the same change. Fixed values such as the support mailbox, the sending domains and the invoice prefix are constants in `lib/company.ts`, not environment variables.

Where to get the non-obvious ones:

- **`CRON_SECRET`:** generate it yourself with `openssl rand -hex 32`. It is write-only in Netlify, so keep the value in the password manager. See the [secret rotation runbook](docs/maintenance/19-secret-rotation-runbook.md).
- **`SENTRY_STATS_TOKEN`:** a Sentry Internal Integration token with `Organization: Read`, used by the daily ingest canary. Steps are in the [ingest canary page](docs/observability/sentry/06-ingest-canary.md). It is a different token from the build-time `SENTRY_AUTH_TOKEN`.
- **`BETTERSTACK_API_KEY`:** a Better Stack Uptime API token. The [Better Stack setup guide](docs/maintenance/00-betterstack-setup.md) says where to create it and how it is used.
- **`RAZORPAY_*` and `RAZORPAYX_*`:** from the Razorpay and RazorpayX dashboards, test pair first and live pair at cutover. The webhook secrets are set on the dashboards. The live-key steps and the test-key boot guard are in the [money go-live checklist](docs/finance/70-operations/07-go-live-checklist.md).
- **`RAZORPAYX_EGRESS_PROXY_URL`:** the QuotaGuard Static proxy URL, bought at the first live payout (checklist section 2.1).
- **`STREAM_API_KEY`, `NEXT_PUBLIC_STREAM_API_KEY` and `STREAM_API_SECRET`:** from the Stream dashboard for the app. Setup is in [`docs/stream/02-setup-configuration.md`](docs/stream/02-setup-configuration.md).
- **`BETTER_AUTH_SECRET` and the encryption keys (`PAN_ENCRYPTION_KEY`, `AUTH_CONFIG_ENCRYPTION_KEY`, `ERASURE_SALT`):** generate each with `openssl rand -base64 32` or `openssl rand -hex 32` as its comment says, and use a different value per environment.
- **Supabase, Upstash, Novu, Resend and R2 keys:** from each vendor's dashboard. The inventory of every production secret, with where it lives, is in the [secret rotation runbook](docs/maintenance/19-secret-rotation-runbook.md). [`docs/enterprise/50-operations/07-required-secrets.md`](docs/enterprise/50-operations/07-required-secrets.md) covers only the GitHub Actions secrets used by the scheduled workflows, not the application environment.

Do not set `REDIS_URL` on Netlify. The platform reaches Upstash over REST (`UPSTASH_REDIS_REST_URL`), never over a TCP Redis connection.

### Payment rails

Razorpay is the only live rail (INR settlement); Stripe was removed from the code on 2026-10-04. `DODO_PAYMENTS` exists only as a `PaymentGateway` enum value. There is no client, checkout path, webhook handler, payout submitter or timeline behind it, and it throws `UnsupportedGatewayError` if it ever reaches gateway routing, a refund or a payout. Dodo has never moved money and appears in no reconciliation or filing. Lemon Squeezy and XFlow were evaluated in March 2026, rejected and removed. See [the gateway page](docs/finance/10-money-in/04-razorpay-gateway-and-currency.md).

### Production vs local checklist

When deploying to production (Netlify), ensure:

- [ ] All `localhost:3000` URLs replaced with `https://familiarisenow.com`
- [ ] `NODE_ENV` set to `production`
- [ ] `SEED_PASSWORD` removed
- [ ] `REDIS_URL` removed (use `UPSTASH_REDIS_REST_URL` instead)
- [ ] Payment keys switched from `test` to `live` when going live (see the go-live highlights above)
- [ ] `BETTER_AUTH_SECRET` is a unique production secret
- [ ] No credentials committed to the repository

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

- **Framework:** Next.js 15 with App Router
- **Database:** PostgreSQL via Supabase
- **ORM:** Prisma 6
- **Auth:** NextAuth.js
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
cat .env | grep -E "^(DATABASE_URL|NEXTAUTH)"
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
