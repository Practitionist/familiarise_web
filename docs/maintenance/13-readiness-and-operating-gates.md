# Readiness and operating gates

Production readiness is evidence about a deployed system under normal operation
and failure. Source inspection, mocked tests, merged code, deployed code and
verified effects are distinct states. This guide defines the evidence needed for
the infrastructure and maintenance machinery; the [worker contracts](12-worker-recovery.md)
and [generated inventory](04-cron-jobs-reference.md) define its implementation.

## Evidence required before declaring a capability ready

| Gate                 | Evidence                                                                                 | Insufficient substitute                                  |
| -------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Source correctness   | Domain and mock-dependent suites, typecheck and review of actual failure paths           | A test of only the edited happy path                     |
| Schema compatibility | Exact reviewed additive SQL, catalog read-back and required-schema check                 | Generated Prisma client or a whole-database drift script |
| Deployment           | The active host's published SHA and runtime configuration                                | A merged dev SHA or a preview deployment                 |
| Automatic execution  | Environment-scoped successful core completions under the owning clock                    | A cron expression, heartbeat or 202 admission            |
| Business recovery    | Real expected effects and retained obligations after a representative failure            | No-op success or counters alone                          |
| Human notification   | A controlled absence alert received by the responsible operator, followed by restoration | Routing configuration or SDK capture assertions          |
| Capacity             | Arrival rate, backlog age and recovery throughput within agreed limits                   | A row limit, ten dispatches or an invocation timeout     |
| Disaster recovery    | Restored data with reconciliation and a tested host failback                             | A backup enabled toggle or a second build target         |

Store dated execution receipts and current owners in the operational tracker.
Do not put customer identities, credentials or storage bearer URLs into source
or public evidence. A readiness score is an estimate, not a substitute for any
of these acceptance gates.

The ticker's real missed-check-in email path has a [recorded acceptance receipt](00-betterstack-setup.md#recorded-end-to-end-verification), including restoration and ordinary recovery. That sub-gate is met; it does not establish independent capability/backlog alarms, vendor correctness or protection from a Sentry outage. Stream's owning session retains its deployed-job verification; do not replay production work merely to collect duplicate evidence.

## Priority order

| Priority | Core machinery                              | Acceptance                                                                                                                                                      |
| -------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Scheduler absence detection                 | An enabled monitor accepts production check-ins; a controlled missed-run exercise reaches the operator, then normal monitoring is restored                      |
| P1       | Capture, refund and durable worker recovery | Money transitions and obligations commit together; unknown gateway results remain recoverable; interrupted workers retry without publishing a successor's state |
| P1       | Storage deletion and retention safety       | Exact ownership survives parent deletion; ambiguous provider responses retain deletion responsibility; concurrent refreshes survive housekeeping                |
| P1       | Environment isolation                       | Production data and vendor targets are separated from development and previews; deployed fingerprints prove separation                                          |
| P1       | Required automatic jobs                     | Every required capability has a working clock and completion/age evidence; migrate remaining blocked batch work with bounded execution and one scheduler        |
| P2       | Throughput and recovery capacity            | Representative duration, connection pressure, oldest obligation age and outage catch-up satisfy the operating budget                                            |
| P2       | Monitoring quality and restore/failback     | Per-capability absence and backlog signals complement shared activity; restore and standby procedures are exercised                                             |

A P0 finding requires production evidence. A missing acceptance receipt is a
readiness gap, not proof that a customer incident occurred. Keep optional
features behind core recovery, safety and operator visibility.

## Scheduler capacity and completion signals

`lib/cron/schedule.ts` is the configured source for intervals, UTC phases,
calendar windows, batch limits and HTTP aborts. The calendar test checks every
five-minute tick over 400 days against the ten-target design bound. There are
already fully occupied hours. Adding a job needs a proven slot or an explicit
capacity change; arbitrarily increasing the cap is not capacity evidence.

The ticker counts admission separately for background adapters. A core's
Postgres lease and its domain claims protect different scopes. An expired
lease, a platform timeout or an HTTP disconnect does not cancel a vendor call.
On Netlify, job leases are capped at 90 seconds and renewed every third of
the effective TTL; other hosts retain requested TTLs. A failed renewal does not
stop the core, so a replacement can overlap effects from a surviving old worker.
Different jobs still require compatible row-level CAS and durable obligations.
Fleet selection may fail open, so it cannot supply exactly-once effects.

`/api/health/jobs` checks successful completions for the current configured
environment. Export and stale-request processing have forty-five-minute
completion budgets. Retained-order invoice recovery has a twelve-hour budget
for its four-hour cadence. These thresholds detect stopped capabilities; they
do not establish the age of an individual queued obligation. Invoice recovery
reads at most five candidates per slot, so cohort size and lost order pointers
remain explicit capacity and coverage concerns.

At the current limit this is at most thirty scheduled order reads per day;
abandoned orders consume those reads too. Before config-enabled suspension,
dunning separately reads the retained order with a bounded provider wait and
uses canonical settlement for a discovered capture. Unavailable, live or parked
payment evidence holds suspension. The claim also rechecks positive net debt
and the inspected order reference transactionally. Lost historical references
remain outside these reads, and reminders still select by invoice status.
Measure cohort rotation and missed-capture age; neither this guard nor a
most-recent-first scan establishes adequate recovery capacity.

The public dependency health endpoint and shared heartbeat remain useful
activity signals. One healthy job can refresh activity while another stops.
Configure an independent per-capability absence probe and ensure the alert path
works when the application ticker, database or primary telemetry pipeline fails.
A disabled Sentry cron monitor rejects check-ins; sending them does not silently
enable it. See [Sentry's monitor contract](https://docs.sentry.io/api/crons/update-a-monitor/).

## Error reporting, scheduler absence and worker completion

Ordinary Sentry exception/message capture reports an observed failure while code
is executing. A disabled scheduler, failed deployment or missing invocation
executes no catch block and emits no exception. An outside observer must retain
the expected deadline and alert when the next check-in never arrives. The Sentry
cron monitor supplies that observation; it does not run the Netlify ticker or
execute another copy of its jobs.

These signals protect different boundaries. Error events retain the stack and
context of a failing job. The fleet check-in proves scheduler activity and
reports the tick's outcome. The environment-scoped completion probe detects a
required worker that stops completing while other ticker targets continue.
Backlog age and vendor-effect reconciliation remain separate evidence. One
fleet monitor plus an aggregate capability probe avoids buying a cron-monitor
seat for every worker.

The ticker's bearer-protected `GET /api/health/jobs/streaks` read also scopes
COMPLETED/FAILED history to the configured environment. A dev completion must
never reset production's repeat-failure escalation. Both job-history endpoints
read `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, falling back to `SENTRY_ENVIRONMENT`
only when the public variable is absent, and return 503 when the selected label
is empty or missing. Historical untagged rows cannot establish success. This
separates monitoring evidence; business data and job leases still share the
database. If streak history is unavailable, the ticker retains its one-off
failure report rather than claiming a verified repeat.

Keep Sentry for error diagnostics regardless of the absence-monitor provider.
A dedicated heartbeat service can replace or complement the fleet observer
without replacing the scheduler or exception reporting. An independent provider
also avoids making every outage signal depend on Sentry's availability and
allowance. Provider choice still requires a working account, reviewed credentials,
truthful signals and an actual human alert receipt; a free plan is not operating
proof. No alternative heartbeat integration is enabled by these documents.

## Monitor activation and allowance

In Sentry's current UI, open **Monitors**, select the application project,
search for the existing cron monitor and choose **Enable**. Older generated
`/crons/<project>/<slug>/` links can fail after the Monitors migration. A
configured alert route cannot receive missed-run incidents from a disabled
monitor. Keep the ticker's five-minute schedule and three-minute check-in margin
unless changing the reviewed detection policy.

Sentry's free Developer plan permits one active cron monitor per organization;
additional cron monitors require a paid plan with available pay-as-you-go
capacity. A monitor activation error about a new seat can therefore be an
allowance problem, even though the disabled monitor already exists. Verify the
current subscription and reserve capacity, or use an approved independent
absence monitor. Disable another application's monitor only after its owner
explicitly authorizes its retirement. Choosing a provider still requires a controlled
missed-run exercise and human receipt before closing the operating gate.

References: [Monitors migration](https://www.sentry.help/en/articles/15007504-monitors-alerts-guide-and-faq),
[Developer cron limit](https://www.sentry.help/en/articles/13963931-how-do-i-can-i-get-more-crons-on-a-developer-plan)
and [subscription controls](https://www.sentry.help/en/articles/13965037-can-i-set-up-an-on-demand-pay-as-you-go-budget-for-my-free-developer-plan).

Email routing and email timing are separate gates. Familiarise's owner-approved
Sentry project digest minimum/maximum is 60/60 seconds; the cron alert retains its
30-minute repeat throttle. Read both policies back before a drill. A short issue
can resolve before a delayed digest is built, and Sentry's published digest path
excludes resolved issues. This explains a possible delivery failure; it is not
access to the provider's internal queue. Receipt of a test notification or an
unrelated application error does not prove the real missed-run alert arrived.

Use the [ticker missed-run runbook](./00-betterstack-setup.md) for the complete
operator procedure, including repeat-throttle timing, the reserved configuration
window, independent restoration and ordinary-check-in recovery. Keep secrets in
protected configuration and preserve exact issue/time evidence in the operating
record. The runbook is reusable across companies; read their current vendor
settings rather than assuming Familiarise's policy or account allowance applies.

The latest bounded exercise on 26 October 2026 produced a real missed-check-in
incident at 12:18 UTC. The production workflow triggered at 12:19 UTC, and its
matching email reached the operator's inbox at 12:20:08 UTC. Normal monitor
settings were restored by 12:18:15 UTC, independently checked by the watchdog,
and the ordinary 12:20 production check-in recovered the monitor. Evidence and
the broader remaining monitoring scope live in the
[operating record](https://github.com/Practitionist/familiarise_web/issues/2156#issuecomment-6401498922).
This proves the ticker's missed-run email path, not individual worker completion
or an independent observer surviving a Sentry outage.

## Safe release and verification

1. Refresh the branch against current dev and verify all affected domain suites,
   including every suite mocking changed modules. Preserve independent PR bases.
2. Have the release owner apply only reviewed schema prerequisites and confirm
   the catalog. The cutover resets mock rows; this change adopts no old artifacts
   and creates no obligations from historical expiry rows. Preserve retained
   obligations during rollback; never resume an incompatible writer.
3. Use the established release flow and confirm the active host's published
   source. Keep Stream production-effect verification with its domain owner.
4. Observe successful automatic core completions and inspect the actual business
   effects. Exercise a representative interruption without creating live money
   movements or deleting customer data as a test.
5. Confirm missed-run notification receipt, recovery and restored monitor state.
   Record the actual result instead of marking a runbook as operational proof.

Changes to SQL, Redis, environment state and deployment/merges remain owner
controlled. Do not operate on the shared database to make an unverified test
pass. Network-denied Jest validates local logic and mocks, not provider behavior.

## Adapting the architecture elsewhere

Keep one canonical job implementation, a small platform scheduler adapter,
Postgres leases, transaction-owned obligations, vendor idempotency and independent
absence monitoring. Match worker durations, pools, upload limits and background
execution to the new host. A hosting switch must preserve an executable standby
and a tested failback path. Copy the contracts and failure tests before copying
cadences: traffic, legal retention, provider behavior and operating ownership
belong to the receiving service.

## Deprecated & Superseded Approaches

A single percentage, healthy shared heartbeat, passing mock suite or merged PR
was sometimes treated as overall readiness. Each proves only its own layer;
retain separate deployment, business-effect, alert and recovery receipts.

Running the same money job from both Actions and a platform scheduler does not
supply resilience by itself. Leases cannot cancel late effects, and retries
cannot recover an obligation that was never recorded. Prefer one owning clock
and durable, replay-safe recovery.
