---
name: booking-verification
description: How to actually prove a booking change works in this repo — which jest suites cover what, the prisma-mocking patterns the tests use, the shared-node_modules worktree trap, what CI does and does not block on, the seeded dev-server plus mock-payment recipe, the chaos runbook, the race workflow, and the standing prohibition on db push against the shared Supabase project. Load before claiming a booking, slot, allocation, checkout, refund or maintenance change is verified, and when writing or running tests under __tests__/booking-algorithm, __tests__/payments, __tests__/booking, __tests__/maintenance or __tests__/collaborators.
---

# Booking Verification

A booking change is verified when the right jest suite passes, a real request
against a running app produces the right database state, and — for anything
touching a lock or a CAS transition — the chaos scenarios pass too. Unit tests
alone do not settle a concurrency claim.

## 1. Which suite covers what

Five folders carry the booking subsystem, and all five exist today.
`__tests__/booking-algorithm/` is the large one (65 suites on merged wave-5
dev): slot validation, allocation, availability scans, reschedule proposals, the
idempotency key, the initial-allocation guard, trial slot integrity, the
hold-expiry predicate, the slot-completion transitions and the collaborator
availability modes. `__tests__/payments/` (50) covers checkout price parity,
refund-preview parity, refund rails, lock TTLs, capture parity, the earnings
healer, the ledger baseline and disputes. `__tests__/booking/` holds five: the
cancellation policy, the tentative-cleanup guard, the expiry-sweep reschedule
race, the no-show refund front door and the slot/session fix pins.
`__tests__/maintenance/` holds eight — freeze, the cron-lock registry, the
`assertNotInMaintenance` guard, the `cleanupRoute()` factory, the DEGRADED
write block, the abandoned-payments reversal, the `SystemJobExecution` prune and
workflow import-env. `__tests__/collaborators/` holds only `availability.test.ts`
— the wave-5 co-host work landed under `__tests__/booking-algorithm/` instead,
so grep both. Run everything with `npm run test`. Races between real
transactions live in a sixth folder, `__tests__/db/booking/`, which the unit run
never executes; see §11.

## 2. The mocking patterns these suites actually use

There is no `Pick<Prisma.TransactionClient, …>` anywhere in the test tree, and
that is deliberate: `lib/booking/request-caps.ts` records that comparing the
extended client against `PrismaClient` blows tsc's stack, so shared helpers take
inline structural types instead. What the transition helpers _do_ take is
`Pick<Tx, "consultation">` and friends, where `Tx` comes from `@/lib/prisma` —
which is precisely what lets a test hand them a plain object of `jest.fn()`s.

The prevailing shape is four steps. Import `./setup` first, which polyfills
`TextEncoder`/`TextDecoder` for Prisma under jsdom and mocks `lib/novu` (the
Novu client pulls undici's `Request` at import time, which the Jest environment
lacks). Then `jest.mock` the modules — **with relative paths, because `@/`
aliases fail inside `jest.mock`** — including `utils/appointmentlock`, to avoid
the `@upstash/redis` ESM import. Then build a `makeMockTx()` factory returning
one group of `jest.fn()`s per model; `updateMany` resolving `{ count: 1 }`
simulates a successful CAS transition, and `{ count: 0 }` exercises the loser
branch. Finally narrow with `const mockPrisma = prisma as unknown as { … }`.

## 3. The worktree trap: shared `node_modules` and the generated client

Every `fw-*` worktree symlinks both `node_modules` and `.env` into the primary
checkout at `~/Desktop/familiarise_web`. Because `package.json` has
`"postinstall": "prisma generate"` and `"build": "npm run db:generate && next
build"`, running `prisma generate`, `npm run build` or `npm ci` from **any**
worktree rewrites the one shared generated client — clobbering whatever the
other worktrees and the primary checkout were compiling against. This bites
hardest against a branch that changes the schema. Chain the generate with the
check that depends on it (`npx prisma generate && npx tsc --noEmit`) and expect
to regenerate again before switching worktrees. This hazard is documented
nowhere else in the repo; treat this paragraph as the reference.

A related, opposite trap: `jest.config.ts` ignores `/\.claude/worktrees/`, which
covers agent checkouts nested under `.claude/` but **not** the `~/Desktop/fw-*`
worktrees, so jest runs their tests normally and needs no override.
(`.claude/skills/finance/references/razorpay/references/this-repo.md` claims
otherwise.)

A warm incremental `tsc` can also hide type errors here: clear the
`.tsbuildinfo` cache before trusting a clean local run, or trust CI.

## 4. What CI blocks on, and what it merely reports

The only workflow that runs unconditionally on every pull request is
`.github/workflows/ci.yaml` (`pull_request` against `dev`, `staging`, `prod`).
Two others carry a `pull_request` trigger but are conditional and never gate a
booking change: `claude-code-review.yml` fires only on a `labeled` event, and
`claude.yml` only when a comment or review body contains `@claude`.

CI's `test-and-build` job is the gate: it passes only when the `checks` job
(lint on changed files, the `check-npm-audit.ts` advisory gate, `prisma generate`, `npx tsc --noEmit`, the
money-column, auth-schema and workflow-hygiene guards, `jest --changedSince` on
non-prod PRs, and the DB-sidecar guard plus the database tier
`jest -c jest.db.config.ts` against a throwaway Postgres whenever `prisma/**`
or `scripts/ci/check-db*` changed) passes, and, on PRs into `prod` and pushes to
`staging` or `prod`, the full sharded `unit-tests` and the `build` job
(`npm run build`) pass too. Draft PRs run nothing. There is no `typecheck`
script, so type-check locally by typing `npx tsc --noEmit` yourself.

In the `checks` job ESLint errors fail the job, and on non-release runs ESLint
checks only the changed files with `--max-warnings=0`, so a warning in a touched
file fails; release runs lint everything with warnings advisory. The Prettier
step carries `continue-on-error: true`, so formatting is advisory in CI. The
config marks almost everything `warn`; only
`react-hooks/rules-of-hooks` and `no-restricted-imports` are errors. That
layering guard is the one lint rule that catches a bad booking refactor — it
forbids `lib/**`, `components/**`, `hooks/**`, `types/**` and `schemas/**` from
importing anything under `@/app/`. Prettier runs on defaults with no config
file, so run `npx prettier --write` on files you touch and keep formatting-only
churn in its own commit. SonarCloud runs outside CI through Automatic Analysis;
treat its findings as real review feedback anyway.

## 5. Verify against a running app with seeded data

The practical loop is a background dev server plus real HTTP calls, not schema
pushes. Every non-operator seeded user shares one password, the seed default
(`prisma/seedFiles/1a-create-users.ts`, overridable with `SEED_PASSWORD`; ADMIN/STAFF use `SEED_OPERATOR_PASSWORD`), stored
as a bcrypt hash on a BetterAuth `Account` row with `providerId: "credential"`.
The credential roster lives in `docs/team/mock-credentials.md`; a reseed is a
write against the shared project, with no production guard anywhere in
`prisma/seed.ts`, so read §7 before running it; the booking- and
money-specific walkthrough is `docs/testing/booking-finance-hardening-test-plan.md`.

Drive checkout with `isMockPayment: true` in the request body. It only works
when `NODE_ENV === "development"`, and it makes the payment succeed immediately,
the slots non-tentative and the gateway call disappear (see
`references/money-boundary.md` §2). That is the cheapest way to produce a real
booking, a real Payment row and real earnings without touching a gateway.

## 6. Concurrency claims need the chaos suite

For anything touching a lock, a CAS transition or an exclusion constraint, run
`npm run test:chaos:api`, which executes the real-API booking and webhook-storm
categories against a seeded database and a running server. The runbook is
`docs/enterprise/50-operations/06-chaos-test-runbook.md`. Its booking scenarios
cover the cancel-versus-reschedule race, the reschedule storm, two concurrent
`DELETE`s on one pending payment (exactly one 200, the loser a 409), the
last-seat storm, and webhook bulk-replay and out-of-order. They restore their
fixtures and move no gateway money, but they are not money-free: the last-seat
storm posts `isMockPayment: true`, which by §5 writes a real `Payment` row and
real earnings, and it then deletes the `Payment`, `PaymentLeg`,
`ConsultantEarnings`, `OrganizationEarnings` and `BookingUtilization` rows again
in a fenced `finally`
(`tests/typescript/race-conditions/scenarios/07-real-api-booking/test-last-seat-storm.ts`)
that logs a warning and leaves them in place when the teardown fails. A local run
against seeded data is sanctioned on that basis, so read the run's output for
that warning afterwards. The money scenarios are not sanctioned, and the runbook
forbids running them against production or the shared development database.
Scenarios that find no reachable server skip rather than fail, so check for SKIP
lines before believing green.

The race workflow `.github/workflows/race-condition-tests.yml` triggers only on
`push` to `prod` and on `workflow_dispatch`. **It has no `pull_request` trigger**,
so it will not run on your PR — dispatch it manually if you want its verdict
before merge.

## 7. Never `db push` against the shared project

One Supabase project serves both development and production, and every `fw-*`
worktree's `.env` symlinks to the same `DATABASE_URL`. `npm run db:push` is
therefore a production operation (the one exception is a throwaway local
database, §11), as are `--force-reset`, the seed scripts and
the availability coalesce scripts (which is why those default to dry-run and
require `--apply`). The reset itself is a scheduled, owner-approved event with
its own procedure in `docs/prisma/README.md`. If a change needs
new schema, say so and stop; do not push it to prove a test passes.

Since #1322 merged, `db:push` on `dev` is push-then-sidecars-then-assert
(`db:push:schema` = the preflight, `prisma db push` and `npm run db:sidecars`, then
`scripts/ci/check-db-sidecars.ts`), so a push can no longer silently leave
`occurrence_no_confirmed_overlap` and the money CHECK constraints behind. There is
no sidecar-skipping push script any more, so `npm run db:push` is the only path.
"Prisma schema is up to date" says nothing about the sidecars.

## 8. The preview-QA recipe used on the 2026-09-18/19 requests train (#1703)

Five previews in a row (#1702, #1717, #1720, #1721, #1724) were QA'd with the
same recipe, which is worth writing down once rather than re-deriving per PR.

**Accounts.** Two seeded users carried the whole train: consultant
`ethan.anderson@gmail.com` and consultee `olivia.anderson@gmail.com`, both at
the seed password (`SEED_PASSWORD`, defaulted in
`prisma/seedFiles/1a-create-users.ts`; §5). These are faker-generated seed
accounts, and the shared project is also production, so never reuse the recipe
against a customer account. A plain-`CONSULTEE`-role second account (Patrick) was
needed once, because Olivia is also dual-role and a pre-existing role gate
hides her own request CTA from her.

**Fixtures came from the real route, not SQL.** Every request fixture this
train created went through the real `POST /api/scheduling/request-for-approval`
endpoint rather than a direct insert, because the route itself refuses an
overlapping request at creation time — a SQL-inserted fixture would skip that
guard and could assert something the app can never actually produce. Where a
genuine slot conflict was needed, one occurrence's time was shifted by SQL
_after_ the route created it, not instead of the route.

**Cleanup order.** This applies only to rows the QA run itself created — never
to a seeded or customer row, and never to any row a real `Payment` points at
(doctrine rule 2). Delete children before parents: appointment participants and
occurrences, then the booking-status-history rows, then the appointment
wrapper, then the consultation/subscription/plan row. A fixture that carried a
mock payment deletes its own payment graph first (legs, and any
`ConsultantEarnings` row the healer created against it), because
`Payment.appointment` is `onDelete: Restrict`, so the appointment cannot be
deleted while a Payment points at it. The mock booking fixture
(`aaaaaaaa-…-aa01`) is never touched by any QA cleanup — it is a fixed,
permanently-present fixture other tests and demos rely on.

**The preview's own sign-in limiter.** BetterAuth's limiter
(`lib/auth/rate-limit.ts`, Upstash-backed; `/sign-in/email` allows 30 requests
per 15 minutes per IP) applies to a preview exactly as it does to production,
and switching test identities in the same browser context burns through it. Budget for one full 15-minute cooldown if a QA pass needs more
than about 30 sign-ins from one IP; the #1724 QA run paid this cost once.

**The Sentry sweep.** After each preview case, sweep Sentry filtered to
`branch:pull/<N>/head` (the PR's own preview release) rather than the whole
project, so an unrelated production event does not read as a regression this
change caused. Cross-reference against the issue ids the PR's own root-cause
section names, and treat anything new as either an expected refusal's Sentry
face (an `expected: true, level: info` event is a typed refusal working as
designed, not a defect) or a finding to send back to the builder.

## 9. The agent-run E2E corpus

`prompts/booking-qa/` holds the agent-run QA suite: folders `01-setup-and-smoke/`
through `13-copy-a11y-responsive/`, one per area (consultations, subscriptions,
webinars, classes, trials, money, concurrency, time zones, dashboards, sweeps,
copy and accessibility). An agent drives the UI through the Chrome DevTools MCP
(one browser, one tab, the `/tmp/fw-browser.lock` lock) and reads and seeds data
through the Supabase MCP, whose writes need owner approval. Read its `README.md`
and `_shared/` first: the personas and their time zones, base fixtures, SQL
recipes (including the host overlap invariant), and the reporting taxonomy
(verdicts plus finding types such as INCONSISTENCY, FALSE-INFO, COPY / AI-SLOP
and MISSED-OPPORTUNITY). The database is the arbiter, every fixture is prefixed
`qa-<caseId>`, and every state change is checked on each dashboard that shows
it. When a booking behaviour changes, update the case that covers it in the same
PR. Add a case when a bug would not have been caught by a unit test.

## 10. QA hygiene when you drive the agent-run cases

- **Sentry may be quota-blind.** The free plan allows 5,000 errors a month, and a
  flood can leave a preview ingesting nothing. Before concluding "no error was
  raised", run `find_dropped_events` (Sentry MCP) or read the stats API for
  `rate_limited`, then read the Netlify function logs for the preview deploy.
  Refusal paths also write a `console.error` or a structured JSON line, for
  example `approval_mint_order_unrecorded`.
- **Report once per run.** A sweep records failures through
  `createRunFailureReporter` and standing conditions through
  `reportStandingFinding`, so expect at most one event per failing op per run and
  one per distinct id per day. Ten failing rows are one event with `count: 10`,
  not ten events.
- **Retire synthetic webhook events.** A `WebhookEvent` you insert or replay
  stays visible to `sweep-stuck-webhook-events` until it is terminal. Set
  `error = 'permanent: qa fixture'` (the `permanent:` prefix is in
  `TERMINAL_ERROR_PREFIXES` in `lib/webhooks/event-log.ts`) on every synthetic
  row before cleanup so the sweep never re-drives it.
- **Prefix every fixture** with `qa-<caseId>` and never touch a row a real
  `Payment` points at; the database refuses the delete anyway.
- **Seed availability with its local columns.** A weekly row with NULL `timezone`
  or `local*` columns is refused by every reader, so a SQL-seeded row must set
  `timezone`, `localStartDay`, `localStartMinutes`, `localEndDay` and
  `localEndMinutes` as well as the UTC columns (the corpus convention is
  Asia/Kolkata, offset 330, except the cases that name another zone).

## 11. The database tier: real-Postgres race tests on a throwaway database

A race between two transactions is proven against real Postgres, never against
mocks. The tier is `__tests__/db/**/*.db.test.ts`, run by `jest.db.config.ts`
(Node environment, one worker because the suites share one database, 30-second
test timeout). `jest.config.ts` exports `DB_TIER_PATTERNS`, which keeps every
`*.db.test.ts`, `__tests__/db/guard.ts`, `__tests__/db/seed.ts` and every
`__tests__/db/**/*harness*.ts` module out of the unit runner, so a harness never
counts as an empty suite. Put a new shared race helper in a file whose name
contains `harness`, beside `__tests__/db/booking/harness.ts`.

`__tests__/db/guard.ts` runs as the tier's global setup and refuses to start
unless `CI=true` and `DATABASE_URL` points at `localhost` or `127.0.0.1` with the
database named `ci`. Run it locally like this, and only like this:

1. Start a local Postgres 16 or newer with the `btree_gist` extension available
   (the overlap constraint needs it), and create a **fresh, empty** database named
   `ci` (macOS: `brew install postgresql@16`, start it with
   `pg_ctl -D /opt/homebrew/var/postgresql@16 start`, then `createdb ci`;
   `DATABASE_URL=postgresql://$USER@localhost:5432/ci`).
2. From a worktree that has **no `.env`** (`next/jest` loads `.env`, and the main
   checkout's points at the shared database), pass both URLs inline and confirm
   they say `localhost` and `/ci` before running anything:
   `DIRECT_URL=postgresql://ci@localhost:<port>/ci DATABASE_URL=postgresql://ci@localhost:<port>/ci node_modules/.bin/prisma db push`,
   then the same two variables in front of `npm run db:sidecars`. A plain
   `prisma db push` drops the ledger triggers and every CHECK, which is why the
   sidecars always follow it.
3. Never pass `--accept-data-loss`: an empty database never needs it, and
   Prisma refuses it without the owner's consent. If a push wants data loss,
   drop and re-create the throwaway database instead.
4. Run `CI=true DATABASE_URL=postgresql://ci@localhost:<port>/ci npx jest -c jest.db.config.ts <paths>`,
   then stop the server and delete its data directory.

An agent cannot use step 2 as written: `.claude/settings.json` denies `prisma db push` and `npm run db:sidecars` in every permission mode, and a worktree usually has a `.env`. The same tier runs without either, on a disposable container:

1. `docker run -d --name <name> -p <port>:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ci postgres:17`, and wait for `pg_isready`.
2. Load the branch's own schema with the read-only diff: `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`, piped into `psql -v ON_ERROR_STOP=1` inside the container. Then apply the sidecar files the same way, in the order `db:sidecars` uses (`check-constraints`, `ledger-triggers`, `payment-legs-triggers`, `analytics-views`).
3. For the jest process only, export every key named in `.env` and `.env.local` as an empty string, so `next/jest` cannot load a live credential, then set `CI=true`, a dummy `BETTER_AUTH_SECRET`, and `DATABASE_URL` and `DIRECT_URL` to `postgresql://postgres:postgres@localhost:<port>/ci`. Print the host, port and database name before running.
4. `npx jest -c jest.db.config.ts --maxWorkers=1 --coverage=false`, then `docker rm -f <name>`.

CI runs this tier inside its lint job only when the changed paths trip the `db` filter in `.github/workflows/ci.yaml`. A PR that changes booking, payment or Stream state without tripping the filter has not had the tier run until someone runs it this way.

Known failures: three booking suites, `seat-races`, `notice-floor-real-path` and
`seat-hold-grace` under `__tests__/db/booking/`, fail under Jest with "A dynamic
import callback was invoked without --experimental-vm-modules" while rendering
emails. The cause is the email stack being loaded through `import()` (as in
`lib/novu/stage-then-attempt.ts`), which Jest's VM cannot run without that flag.
The production runtime is unaffected.

Most booking suites in `__tests__/db/booking/` make two writers meet at a real
conflict and assert exactly one commit, one typed refusal, and a raw-SQL
invariant (no two time-holding rows overlap per host profile or per buyer):

| Suite                                    | What it pins                                                          |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `allocator-races.db.test.ts`             | The allocator against checkout, webinar publish and itself            |
| `subscription-period-races.db.test.ts`   | Subscription-period allocation against concurrent buyer checkouts     |
| `host-time-races.db.test.ts`             | Host-time writers against the allocator and the request door          |
| `makeup-vs-holds.db.test.ts`             | A class make-up against every hold kind                               |
| `event-retime.db.test.ts`                | Webinar re-time, attendee clashes and the free leave                  |
| `reschedule-lifecycle.db.test.ts`        | Preference-only requests, withdraw and expiry restores, free restores |
| `place-new-time.db.test.ts`              | Placing a new time on a booking with no live session                  |
| `cancel-vs-capture.db.test.ts`           | A cancel and a capture landing together                               |
| `cancel-money.db.test.ts`                | The cancel window, and a refund another door already owns             |
| `notice-floor-real-path.db.test.ts`      | The notice floor read from real release records                       |
| `capture-recheck-freed-time.db.test.ts`  | A capture on time a cancelled or returned row freed                   |
| `blocked-capture-sweep.db.test.ts`       | A blocked capture's hold against the tentative-clear sweep            |
| `approval-mint-paid.db.test.ts`          | A pay-link mint for a request that is already paid                    |
| `approval-pay-window.db.test.ts`         | The pay window and the too-close-to-start lapse                       |
| `reject-live-checkout.db.test.ts`        | A decline against the buyer's own live checkout                       |
| `decline-while-rescheduling.db.test.ts`  | Every decline door refusing a booking being moved, with nothing moved |
| `trial-conversion-at-capture.db.test.ts` | A trial left COMPLETED at checkout start and converted at capture     |
| `checkout-tabs.db.test.ts`               | Two tabs, one plan, and the request fingerprint                       |
| `seat-races.db.test.ts`                  | The seat herd and whole-event cancel against seat checkout            |
| `seat-hold-grace.db.test.ts`             | A late capture inside the seat's capture grace                        |
| `buyer-lapsed-seat.db.test.ts`           | A lapsed seat no longer blocking a dual-role buyer                    |
| `seat-leave-redrive.db.test.ts`          | A seat-leave crash re-driven by the owed-refund sweep                 |
| `seat-leave-owned-marker.db.test.ts`     | A seat leave refused by another door's owed marker                    |
| `owed-refund-earnings.db.test.ts`        | A failing plan-end refund holding both earnings arms past their hold  |
| `zero-total-checkout.db.test.ts`         | A fully discounted order taking the no-gateway rail                   |
| `unique-violation-shape.db.test.ts`      | The real shape of a unique violation, classified by constraint        |

Read each suite's header before trusting a row of this table; the file is the
contract. `__tests__/db/scope/` and `__tests__/db/support/` hold the scoping and
support races on the same harness.

## Deprecated & Superseded Approaches

- **Mock-only race tests.** Interleaving `jest.fn()` transactions proved only
  the order the test author imagined. A concurrency claim now needs a
  `__tests__/db/` suite on real Postgres.
- **`--accept-data-loss` on a test database.** It was once the habit when a push
  complained. On a fresh database it is never needed, and the guard rails refuse
  it; re-create the database instead.
