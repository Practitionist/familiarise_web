# State-as-outbox and the Netlify ticker

This page covers how scheduled work runs in this repository: why there is no message broker or generic outbox table, how the Netlify scheduled ticker closes the gap GitHub Actions leaves, and the checklist for adding a new scheduled job.

## State-as-outbox (ADR 27)

No generic outbox table exists, because the durable state an outbox exists to provide already lives on the domain rows the platform writes anyway: `WebhookEvent` is an inbox with a processed flag, `OutboundWebhookDelivery` and `FailedEmail` are outboxes with their own retry state, and every money-bearing follow-up is keyed on a row that already exists — `Payment`, `Appointment`, `Refund`, `WalletTopUp`. A follow-up that must survive a crash is expressed as a nullable stamp on the row it belongs to, such as `Appointment.chatChannelEnsuredAt`, plus an idempotent ensure-step in an existing sweeper that checks the stamp before doing the work again. The missing piece this ADR closes was never a table; it was a scheduler reliable enough to re-check those stamps on a short interval.

## Dynamic `/api/cleanup/[job]` route and Postgres cron lease

Scheduled HTTP jobs are registered in `lib/cron/cleanup-registry.ts` (`CLEANUP_JOB_BUILDERS`) and dispatched through the single dynamic route `app/api/cleanup/[job]/route.ts` (built by `lib/cron/cleanup-route.ts` and gated by `CRON_SECRET`). Do **not** create per-job `app/api/cleanup/<name>/route.ts` files.

`withCronLock` (`lib/cron/with-cron-lock.ts`) provides distributed mutual exclusion backed by a **Postgres lease on `SystemJobExecution`** (`status = 'RUNNING'` with a 15-minute default TTL and 35 minutes for payout/reconcile jobs), keeping Upstash Redis off the cron path. A financial job (`lib/cron/financial-jobs.ts`) additionally checks `abortIfMaintenance()` / `assertNotInMaintenance()` and exits during a `DEGRADED` or `OFFLINE` maintenance phase; a non-financial job exits only on `OFFLINE`. Unreadable or missing phase state refuses guarded work with `MAINTENANCE_STATE_UNREADABLE` and HTTP 503 without a `phase` marker, so the ticker records an operational failure rather than a planned hold.

## The Netlify scheduled ticker

`netlify/functions/cron-tick.mts` runs every five minutes and POSTs latency-sensitive recovery sweeps to `/api/cleanup/<job>?limit=N` with `CRON_SECRET`. Sub-hourly recovery sweeps run **only** on the Netlify ticker (their duplicate GitHub Actions YAML twins were removed in `#1920` after handlers were updated to loop within a time budget).

Money reconcilers, money batch jobs and the TDS draft export also run on the ticker: `reconcile-disputes` hourly, `reconcile-ledgers` daily at 03:55 UTC, and `tds-return-draft` on the 5th of Jan/Apr/Jul/Oct (windows in `TARGET_WINDOWS`). Each tick first reads the Upstash key `ops:active_cron_platform` (one GET) and skips every target when it names another host; an absent key or a Redis failure runs the tick.

GitHub Actions is retained only for non-money batch crons, plus manual `workflow_dispatch` runs; GitHub Actions is currently budget-blocked, so those jobs are not running. When a job is already running, `withCronLock` returns `409`, which the ticker records as `lockHeld` rather than `failed`. A 503 carrying an explicit `DEGRADED`/`OFFLINE` phase is a planned maintenance hold; an unreadable-state 503 remains `failed`.

The ticker always returns HTTP `200` so Netlify does not retry the entire tick 3x on a single target failure; failures are logged on the structured `{"event":"cron-tick",...}` line.

`netlify/functions/keep-warm.mts` (PR #1685) was retired and deleted in PR #1972 once `preloadEntriesOnStart: false` reduced Next.js cold starts to `0.97–1.90 s`.

## Explicit maintenance booking remediation

Selecting OFFLINE never cancels bookings. Maintenance-control lease results carry the HTTP command outcome; rejected or incomplete commands must not refresh successful execution evidence. ADMINs preview at most 20 whole bookings in an explicit interval up to 24 hours, then confirm a signed five-minute preview with a fresh session and an audit reason. `MaintenanceRemediation` and its items persist the confirmed request; `maintenance-booking-remediation` processes one item per fifteen-minute ticker slice. It belongs to `FINANCIAL_JOB_NAMES` and resumes only after maintenance ends. Cancellation stages refund-owed and notification obligations in its domain transaction; canonical relays deliver them. Item and request completion commit together, so a lost completion transaction replays safely. Preview, confirmation and execution also reject bookings beyond the conservative per-booking recipient/session/payment envelope; do not truncate obligations or claim large-roster remediation is supported.

Maintenance ETA is informational, and active Redis keys do not expire into an automatic reopening. ADMIN recovery must succeed before OFF is published. OFFLINE setup and recovery are serialized with the Postgres `maintenance-control` lease. `Meeting.maintenanceWindowId` preserves the exact operation scope even if later webhooks change the end reason. `maintenanceChannelFrozenAt` records acknowledged freezes; recovery includes all linked group meetings lacking `maintenanceChannelRecoveredAt`, including uncertain freeze outcomes, and advances only acknowledged unfreezes. Partial setup must be acknowledged through Retry Offline Setup before OFFLINE can end or downgrade. Partial drain or channel batches remain retryable and cannot complete setup/recovery.

## `?limit=` semantics

Every route the ticker invokes accepts an optional `?limit=` (via `parseLimitParam`), capping the batch a single tick processes (default 50, or 10 for `abandoned-payments`; max 500; `400 INVALID_LIMIT` on malformed input).

## Workflow concurrency groups

Every scheduled GitHub Actions workflow declares `concurrency: { group: ${{ github.workflow }}, cancel-in-progress: false }` so overlapping runs queue rather than cancel mid-flight.

## Adding or modifying a scheduled job

1. **Single implementation**: Put the job logic in one domain module and register it in `lib/cron/cleanup-registry.ts` (`CLEANUP_JOB_BUILDERS`) wrapped in `withCronLock`.
2. **Never create 3-layer wrappers**: Do not add parallel `app/api/cleanup/<job>/route.ts` + `jobs/<domain>/<job>.ts` + `scripts/<domain>/<job>.ts` files.
3. **Single scheduler**: Put sub-hourly recovery sweeps in `netlify/functions/cron-tick.mts` (`TARGETS`), and daily/weekly/monthly jobs in a `TARGET_WINDOWS` slot or, if they cannot run bounded inside the ticker's timeout, in GitHub Actions — never both. Every tick must stay at or under `MAX_TARGETS_PER_TICK`.
4. **Financial jobs**: If the job mutates money or payouts, include its slug in `FINANCIAL_JOB_NAMES` (`lib/cron/financial-jobs.ts`).

## Sources

`AGENTS.md`, `lib/cron/cleanup-registry.ts`, `lib/cron/cleanup-route.ts`, `lib/cron/with-cron-lock.ts`, `netlify/functions/cron-tick.mts`.
