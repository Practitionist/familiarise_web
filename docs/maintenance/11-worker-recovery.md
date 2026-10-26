# Worker recovery and durable obligations

The scheduler supplies opportunities to work. Postgres owns the work and its
history. A successful HTTP request, an acquired lease and a completed business
obligation are three different observations. This guide explains the contracts
used by the export and booking-expiry workers; see the
[generated inventory](04-cron-jobs-reference.md) for the complete configured
roster and the [scheduler reference](10-cron-and-reconciliation-reference.md)
for dispatch, maintenance admission and lease behavior.

## Responsibilities and execution lanes

| Component                           | Responsibility                                                                | Evidence it cannot establish alone                                |
| ----------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Platform ticker                     | Dispatch due registry targets with the catalog's limits, offsets and windows  | Business completion or sufficient backlog capacity                |
| Cleanup registry and admin run door | Authenticate, validate request bounds and invoke the canonical implementation | Cancellation of a previously started invocation                   |
| Postgres job lease                  | Refuse concurrent admission of the same fail-closed core                      | Row ownership after reclaim; serialization across different jobs  |
| Domain transaction                  | Commit an eligible transition with the obligations it creates                 | Vendor acceptance or delivery                                     |
| Refund, email and bell relays       | Retry the existing durable markers/outboxes using stable identities           | An exactly-once vendor effect outside its idempotency contract    |
| Operational health                  | Check recent owned successful completions in this deployment environment      | Absence of overdue rows or proof that the human received an alert |

The five-minute Netlify ticker is the current operating clock for time-sensitive
recovery and the configured money jobs. Export processing runs every ten minutes;
stale-request expiry runs every fifteen. GitHub Actions retains CI and the
remaining configured non-money batch jobs. Do not create a second automatic
scheduler for a ticker-owned job. An Actions cron expression is configuration,
not evidence of current budget, execution or successful effects.

Netlify remains the standby build target. A new active host needs an equivalent
ticker and execution adapters, including background functions. The fleet key
selects dispatch ownership but fails open when absent or unreadable; it is not an
exactly-once lock. Changing hosting does not change these domain contracts.

## Export claim and publication

`process-data-exports` has one implementation in
`scripts/cleanup/process-data-exports.ts`. Its Postgres lease fails closed.
`OrgDataExportJob` retains the existing PENDING, PROCESSING, READY, FAILED and
EXPIRED lifecycle. A stale PROCESSING claim becomes eligible after the long-job
lease duration; an active claim stays ineligible. Reclaim updates `startedAt` to
a distinct millisecond value. That timestamp is the attempt identity, and every
terminal update requires both PROCESSING and that exact identity in its WHERE.

```mermaid
flowchart TD
  A[Pending or stale processing job] --> B[Conditional claim and exact artifact owner]
  B --> C[Build the authorized bundle]
  C --> D[Upload to an immutable attempt path]
  D --> E[Conditional READY plus audit and notification obligations]
  E --> F[Existing delivery relays]
  B --> G[Seven-day exact object expiry]
  G --> H[Remote delete and confirmed absence]
  H --> I[Retire artifact owner and expire matching published job]
```

A competing invocation that loses the claim does no export work. A superseded
attempt cannot publish READY or FAILED and cannot overwrite a newer attempt's
bytes: uploads use separate paths without upsert. The publication transaction
stages the existing delivery obligations along with READY and its audit. Vendor
notification delivery happens outside that transaction. A process death after
commit leaves the existing relays responsible for notification delivery.

Organization-visible failure text is a fixed safe message. Engineering-only
system events carry diagnostics keyed by export ID. Neither public results nor
outbox payloads should expose a storage bearer URL or raw database exception.
Generation still has a whole-bundle memory footprint; one selected job is a row
bound, not a proof of acceptable size or execution time for a large organization.

## Exact storage ownership and access

`OrgDataExportArtifact` records the bucket, immutable storage path, attempt
identity and expiry before upload. It deliberately has no organization/job
foreign key: deleting a parent must not erase the remote deletion obligation.
It is a purpose-specific object owner, not another queue or job-state machine.

All attempts retain their owner until the seven-day expiry, including an upload
whose publication failed or lost ownership. Cleanup does not treat an immediate
absence response as permission to forget a still-live upload. This grace relies
on the supported invocation and vendor transport bounds being far shorter than
seven days; changing those runtimes requires reviewing that assumption.

The same core processes a bounded expiry slice and rotates deletion attempts so
an unavailable object cannot monopolize the eligible prefix. A remove helper's
boolean alone is insufficient: the export path also requires a successful exact
presence read reporting absence. A failed, ambiguous or still-present result
keeps the owner eligible. Only after confirmed removal does a transaction retire
that owner and expire the matching published job. Failed notification delivery
never reverses READY.

Mail and bell links open the authenticated export panel. Download checks current
organization access, export kind, READY and expiry, then signs the owner's exact
path for a short interval. A role change prevents a new download grant; an
already issued signed link remains usable under the storage provider's token
and caching contract. Expiry of a download token is not deletion of its bytes.

## Expiry and refund responsibility

A pending consultation and an approved unallocated subscription can both have a
successful payment when they expire. Their winning transaction records EXPIRED,
history and the full remaining refund obligation using the existing payment
marker and arm-specific idempotency key. Failure to stage the complete marker
set rolls back that transition. Notification errors or process death after
commit cannot remove the owed refund.

After commit, `driveRefundOwed` invokes the canonical refund door. The existing
`retry-auto-refunds` sweep owns unfinished markers; stable keys preserve replay
identity after an uncertain gateway result. This does not change refund amounts,
rails, attempt ceilings or operator handoff. The already hardened 48-hour paid
unallocated arm keeps its existing contract. The unpaid pending-subscription
cohort continues to exclude successful payments in both selection and mutation.

## Failure boundaries and review evidence

| Interruption or race                          | Durable fact / recovery                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| Death after export claim                      | PROCESSING remains; the next eligible stale reclaim changes the attempt token |
| Death after upload, before READY              | Exact artifact owner survives and eventually deletes the unpublished object   |
| Old attempt finishes after reclaim            | Conditional finalization loses; separate upload path preserves the new bytes  |
| Publication transaction fails                 | READY and its audit/outbox do not partially commit                            |
| Notification provider fails after publication | READY remains; existing notification/email relays retry their rows            |
| Delete times out or presence read fails       | Owner stays eligible; no assertion that remote bytes were removed             |
| Organization/job is deleted                   | Artifact owner remains independently until confirmed deletion                 |
| Expiry commits and process dies before refund | Owed marker survives; refund relay continues with the same identity           |
| Another flow wins a booking transition        | Expiry CAS loses and creates no new refund obligation                         |

Mocked tests must exercise these interruptions through the actual core functions,
including losing ownership and error paths. They do not establish deployed
throughput, storage permissions, backlog drain or actual gateway behavior.

## Deployment and operating gates

1. The release owner reviews and applies only the additive artifact table/index
   DDL and exact legacy URL backfill supplied with the PR. Quiesce export work
   for the backfill. Unrecognized pointers are a stop condition; investigate
   their exact identity instead of guessing a bucket.
2. Read back the catalog, run the read-only schema-required check and verify the
   legacy rows have exact owners before deploying readers that require them.
   Prisma client generation does not apply the schema. Coding agents do not run
   this SQL, schema push, Redis writes or environment changes.
3. Deploy through the existing release flow. The old application must not resume
   writing legacy unowned artifacts during a rollback; reconcile that boundary
   before reverting code. Preserve artifact rows and bytes while investigating.
4. Verify actual worker completion and a bounded representative export on the
   deployed host, then inspect expiry retries, oldest eligible work and refund
   obligations. Whole-bundle size and outage catch-up need measured evidence.
5. `/api/health/jobs` requires `process-data-exports` and `expire-stale-requests`
   completion within 45 minutes, independently of other capabilities. The
   endpoint is environment scoped and read-only; a held or failed invocation
   does not refresh it. Independent monitoring must poll it and route an alert.

Monitor configuration and human alert receipt remain separate deployment gates.
The pending missed-run exercise is not completed by this code change. Existing
storage/retention safety PRs, reminder recovery, missing invoice-capture healing,
remaining Actions coverage, environment isolation and full-service restore proof
also retain their owners. This PR does not establish a readiness percentage.

## Primary references

Verified on 2026-10-26:

- [Supabase private asset downloads](https://supabase.com/docs/guides/storage/serving/downloads): signed URLs are temporary bearer access, distinct from application authorization.
- [Supabase standard uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads): enabling upsert permits overwrites; immutable attempt paths avoid shared-key replacement.
- [Prisma v7 transactions](https://docs.prisma.io/docs/orm/v7/prisma-client/queries/transactions): atomic writes and optimistic concurrency checks; keep interactive transactions short and use their transaction client.

## Deprecated & Superseded Approaches

The export worker previously selected PENDING only. A killed PROCESSING attempt
could remain invisible forever. It uploaded with upsert to a shared job path and
stored a seven-day bearer URL on the job; that URL was also sent in notifications.
Expiry checks blocked dashboard access but did not establish remote deletion.
The attempt owner, immutable path and confirmed expiry now carry those duties.

Export notices previously ran inside the generation catch boundary after READY
committed. A notice failure could overwrite the successful export as FAILED and
store raw error text in an organization-visible field. Atomic notification
staging and safe public errors replace that coupling.

The two older money-capable expiry arms previously retained IDs only in process
memory and called refunds after the transition and notices. Recording the owed
refund in the winning transaction closes that process-death gap. Existing
refund policies and the unpaid cohort remain unchanged.
