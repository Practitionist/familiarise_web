# Job history and messaging retention

`pruneSystemJobExecutions` in `scripts/cleanup/prune-system-job-executions.ts` owns job-history retention and messaging payload/history cleanup. The registered `prune-system-job-executions` cleanup route, driven by the ticker, and the admin System Jobs door call this same implementation. This worker does not deliver messages or replay dead letters. The windows it enforces are listed in [the retention table](../compliance/02-dpdp-and-privacy.md#retention-windows).

| Cohort                                             | Existing policy                                 | Write condition                                                                |
| -------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `SystemJobExecution` without a renewed heartbeat   | `RUNNING` with `startedAt` older than six hours | Selected ID, still `RUNNING`, heartbeat still old; mark `FAILED`               |
| No-op job history                                  | `startedAt` older than 14 days                  | Selected ID, still a no-op run (below), still outside retention                |
| Other finished job history                         | `startedAt` older than 180 days                 | Selected ID, still outside retention, status is not `RUNNING`                  |
| `FailedEmail` and `FailedEmailBatch` sent payloads | Scrub after seven days                          | Selected ID, still `SENT`, delivery timestamp still old, payload still present |
| Sent email and batch outbox rows                   | Delete after 30 days                            | Selected ID, still `SENT`, delivery timestamp still old                        |
| Dead-letter email, batch and notification rows     | Delete after 90 days                            | Selected ID, still `DEAD_LETTER`, `updatedAt` still old                        |
| Sent `NotificationOutbox` rows                     | Delete after 30 days                            | Selected ID, still `SENT`, `updatedAt` still old                               |
| `EmailEvent` history                               | Delete after 1 year (calendar)                  | Selected ID, `receivedAt` still old                                            |
| `OrgDataExportJob` (`READY`, `FAILED`, `EXPIRED`)  | Delete after 1 year by `createdAt`              | Selected ID, status still terminal, `createdAt` still old                      |
| Anonymous `CookiePreference` rows (`userId` null)  | Delete after 13 months by `consentUpdatedAt`    | Selected ID, `userId` still null, `consentUpdatedAt` still old                 |
| `MeetingPresence` and `MeetingAttendance`          | Delete 3 years after the occurrence's `endsAt`  | Selected ID, the occurrence still ended before the cutoff                      |
| Settled `AdminRunRequest` rows                     | Delete `DONE`/`FAILED` after 30 days            | Selected ID, still `DONE` or `FAILED`, `finishedAt` still old                  |

For sent email/batch rows, the delivery timestamp is `sentAt`, falling back to `updatedAt` only for legacy rows without `sentAt`. Parameterized SQL scrubs the body/payload without updating either timestamp. `htmlBody` becomes an empty string, `textBody` becomes null, and batch payload becomes an empty JSON array. A scrub must not postpone deletion of a legacy row by restarting its age.

## Bounded execution and continuation

Every call has a positive integer row limit: default 100, maximum 500. The HTTP route accepts `?limit=N`, uses the shared parser, rejects malformed limits with 400, and clamps values above 500. The core also validates direct callers. The limit applies **per phase**, rather than across the whole job.

A no-op run is one that is `COMPLETED`, processed zero or null items with zero or null errors, has no `errorLog`, was not triggered by an admin (`admin:*`), has no `checkpoint` key in its `result`, has no non-empty `idle` array (a tick-claim row that recorded idle skips is kept), and is not its job's newest `COMPLETED` row.

Run history is drained differently from the other phases. After the bounded pages, it deletes with raw `DELETE ... WHERE id IN (SELECT ... ORDER BY startedAt LIMIT 1000)` batches until a batch comes back short or the shared 16-second deadline passes, and the 180-day tier starts only once the no-op tier is drained. A run therefore deletes tens of thousands of rows in a good evening, against an inflow of about 3,400 a day, and the overrun past the deadline is at most one statement.

The other phases are: stale-heartbeat closure, settled admin run request deletion, two payload scrubs, three outbox deletions, email-event deletion, and the three secondary pages (export jobs, anonymous cookie choices, meeting presence and attendance). Open (`REQUESTED` or `CLAIMED`) admin run requests are never retention candidates. Each reads at most `limit + 1` IDs and mutates at most `limit` selected rows. Results include each mutation count and `hasMore`. The extra row detects another page; it is never mutated by that slice. A successful slice with `hasMore: true` does not establish a drained backlog.

A fixed 16-second start budget is passed from the HTTP request or batch driver
through the core, including setup and lease admission. Every batch slice reuses
the original start time rather than starting a new budget. Before starting a read or write, the worker checks the deadline. Unattempted phases report continuation. An already-running SQL statement can outlive that deadline; database query/connection timeouts and runtime limits still apply. Row bounds and a start budget are not a measured latency guarantee.

Each ticker request runs one bounded slice (`?limit=500`, at most 500 rows per phase) within a 16-second start budget, and `hasMore` reports a remaining backlog for the next slice. It does not sleep, spawn another worker, or silently drain forever. A SQL failure propagates to the route/runner; an incomplete cohort remains discoverable on a later invocation. Repeated daily throughput and oldest-eligible age still need deployment observation before a scheduler handoff.

## Replay, concurrency and crashes

The core uses the existing Postgres cron lease in fail-closed mode. That lease excludes another admitted copy of this job while valid. It does not exclude an admin replay, a notification relay, or another domain worker. Eligibility therefore belongs in the final mutation's `WHERE`, alongside the selected IDs.

For example, an admin replay changes an old dead letter to `PENDING`. If replay commits before retention's delete obtains the row, retention must preserve it. PostgreSQL re-evaluates the delete condition after waiting for a concurrent update; the repeated terminal-state and age predicates make the new pending row ineligible. If retention deletes first, the admin receives a zero-row replay result. There is no guarantee that an already expired dead letter remains available for replay indefinitely.

Each phase commits independently. A crash after history deletion leaves later email obligations untouched and discoverable. Retry selects remaining eligible rows, without a volatile cursor or a new queue. Active `PENDING` and `RETRY` obligations are excluded from retention. A failure is reported once by the existing run/HTTP boundary rather than captured per row.

The six-hour check detects a missing lease heartbeat. Marking an execution `FAILED` does **not** cancel its process or fence its external side effects. Never shorten this threshold to the ticker request timeout or use it to justify simultaneous schedulers.

## Ownership and validation

The automatic owner is the ticker target `prune-system-job-executions` (every 30 minutes at offset 25, in the 20:00 to 23:30 UTC window, limit 500). The daily Actions step and its wrapper under `jobs/` were removed in the same change, so there is one clock. Verify completion and backlog age after deployment. CI/CD remains a separate responsibility from runtime maintenance scheduling.

Mock tests cover row bounds, invalid limits, the retention windows above, eligibility in final writes, heartbeat renewal, and retry after a later-phase failure. `__tests__/db/messaging-retention.db.test.ts` exercises a real blocked-delete/replay interleaving, legacy timestamp preservation, and multi-slice progress. Its guard permits only a disposable localhost `/ci` database with `CI=true`; never point it at the shared database.

Sources: [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED), [PostgreSQL DELETE](https://www.postgresql.org/docs/current/sql-delete.html), and the implementation and tests linked above. These establish database behavior, not a new statutory retention interpretation.

## Deprecated & Superseded Approaches

The earlier implementation bounded individual SQL batches but repeated them until exhaustion, so an HTTP invocation could still drain an arbitrary backlog. Several mutations deleted selected IDs without repeating eligibility, allowing an admin replay to race with deletion. Optional delegate checks also made incomplete mocks resemble a successful production run. The current implementation uses required typed delegates, one page per phase, and conditional writes. Legacy payload scrubbing updated `updatedAt`; the current SQL preserves the timestamp used by fallback retention.
