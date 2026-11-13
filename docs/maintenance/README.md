# Infrastructure jobs and maintenance

Start with the [infrastructure architecture and operating model](../start-here/09-infra-and-maintenance-sre-orientation.md). It explains scheduler ownership, durable obligations, leases, cross-job races, bounded progress, reconciliation, operational health, maintenance recovery and portability. This directory supplies the inventory and detailed runbooks. GitHub review comments record decisions and evidence; they are not the architecture manual.

## Runtime model

The active platform ticker dispatches registered bounded jobs. Postgres owns job leases, execution history, transactional obligations and database invariants. Redis owns short-lived interactive mutexes, request limits, maintenance edge state and active-host preference. A timeout, lease expiry or host switch does not cancel work already in flight; business CAS and vendor idempotency protect overlapping effects.

The ticker owns all 81 scheduled targets (`TARGETS` in `lib/cron/schedule.ts`), including the housekeeping, compliance and retention jobs that GitHub Actions once ran, so no Actions workflow schedules a registry job. GitHub Actions keeps only CI and the cron heartbeat, the live-database drift check and the security audit (`.github/workflows`). Source configuration and a registered handler do not establish live execution. The architecture guide describes the configured Stream ticker cadences and their Netlify background targets.

| Maintenance state        | Policy                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| OFF                      | Normal traffic and job admission                                                                       |
| DEGRADED                 | Reads remain available; classified financial mutations/jobs are held                                   |
| OFFLINE                  | Non-exempt traffic and cleanup work are held; explicit webhook, health and admin recovery doors remain |
| Missing/unreadable state | Mutations fail closed; operator bootstrap/recovery is required                                         |

Activation never implicitly cancels bookings. Cancellation requires a separate explicit preview and confirmation. ETA never automatically reopens traffic. The additive schema and persistent edge phase must exist before deploying readers; follow the pre-maintenance rollout prerequisites.

## Reading order

| Reference                                                                        | Purpose                                                                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [00 — BetterStack setup](./00-betterstack-setup.md)                              | Existing incident/status-page integration and operator setup                                                                             |
| [01 — Architecture](./01-architecture.md)                                        | Maintenance state, durable remediation and dependency boundaries                                                                         |
| [02 — DEGRADED and OFFLINE](./02-degraded-vs-offline.md)                         | Request and job admission policy                                                                                                         |
| [03 — Business risks](./03-business-risks.md)                                    | Domain risks to consider before planned work                                                                                             |
| [04 — Generated job inventory](./04-cron-jobs-reference.md)                      | Source-derived roster, schedules, bounds and declared lease policy                                                                       |
| [05 — Webhooks](./05-webhook-behavior.md)                                        | Recording external truth during maintenance                                                                                              |
| [06 — Before maintenance](./06-pre-maintenance-checklist.md)                     | Schema/edge bootstrap, activation, active-work checks and confirmed remediation                                                          |
| [07 — Recovery](./07-post-maintenance-recovery.md)                               | Explicit reopening, dependency checks and durable recovery                                                                               |
| [08 — SDK updates](./08-sdk-update-guide.md)                                     | Package-specific verification guidance                                                                                                   |
| [09 — Further work](./09-future-improvements.md)                                 | Proposals; check current source before treating an item as outstanding                                                                   |
| [10 — Cron and reconciliation](./10-cron-and-reconciliation-reference.md)        | Dispatch/status contracts, sidecars, ledger checkpoints and host concerns                                                                |
| [11 — Job machinery and dashboard](./11-job-machinery-catalog.md)                | Current job signals, lease/retry contracts and the operations dashboard design                                                           |
| [12 — Worker recovery](./12-worker-recovery.md)                                  | Export attempt ownership, expiry refunds and retained-order recovery                                                                     |
| [13 — Readiness gates](./13-readiness-and-operating-gates.md)                    | Source, schema, execution, alert-delivery and recovery evidence                                                                          |
| [14 — Background-job runtime options](./14-background-job-runtime-options.md)    | Comparison matrix, diagrams, worked example and official sources for each job runtime tested on 2026-10-31                               |
| [15 — Job-runtime layer matrix](./15-job-runtime-layer-matrix.md)                | The eight layers, the five compatibility rules and eleven coherent stacks, with an HLD and a decision flowchart                          |
| [16 — Job machinery and portability](./16-job-machinery-and-portability.md)      | Line counts of the job machinery, what a host move removes and ports-and-adapters portability                                            |
| [17 — Target architecture and roadmap](./17-target-architecture-and-roadmap.md)  | Executive summary, the target design (a proposal), the path from today and the Netlify billing status                                    |
| [18 — Monitoring and tracing failures](./18-monitoring-and-tracing-failures.md)  | The four monitoring layers and how to tell whether a failure hits one user or a group                                                    |
| [19 — Secret rotation runbook](./19-secret-rotation-runbook.md)                  | Inventory of every production credential, the pre-launch rotation plan, and the ordered procedures with vendor-cited steps and rollbacks |
| [Job-runtime experiment reports](./experiments/2026-10-31-job-runtime/README.md) | Index, method, honesty labels, dashboards and cleanup log for the raw reports                                                            |
| [Schedule catalog](./schedule-catalog.md)                                        | Catalog ownership and generated documentation                                                                                            |
| [Bounded housekeeping](./housekeeping-bounds.md)                                 | Retention eligibility, per-phase limits and continuation semantics                                                                       |
| [Compliance/retention workers](./compliance-retention-workers.md)                | Consent retention, durable breach staging and event history                                                                              |
| [Messaging retention](./messaging-retention.md)                                  | Job-history retention, bounded payload scrubbing and replay races                                                                        |
| [Recording worker](../stream/recording-background-worker.md)                     | Narrow background adapter, source expiry and activation evidence                                                                         |
| [Deployment/failback](../deployment/README.md)                                   | Runtime differences, one active scheduler and standby recovery                                                                           |

Link a worker guide when its implementation is present; keep proposed activation work separate from the current inventory.

## Verification and maintenance of these docs

Regenerate the job inventory from executable sources after registry or schedule changes. Keep this index and the architecture guide focused on behavior and invariants; per-job bounds and provider policy belong in their linked domain guide. A future developer should be able to understand the design without reading historical issues.

Use the repository Jest configuration, a matching isolated Prisma client when a worktree schema differs, TypeScript, lint and changed-file formatting. Validate same-job overlap, cross-job races, sequential replay, stale ownership, unavailable dependencies and more-than-one-slice progress. Use mocks or a disposable database. Accepted deployed execution, source deadlines, measured backlog progress and real alert delivery remain separate rollout checks.

## Deprecated & Superseded Approaches

The former index led with historical flaw diagrams, stale workflow counts, fail-open maintenance and an unimplemented target architecture. Those descriptions were easy to mistake for the active system. Current contracts and runbooks take precedence; history belongs in this small footer and source control.
