---
name: maintenance
description: Operational plumbing for this repo's Next.js-on-Netlify deployment — the state-as-outbox cron architecture and the five-minute Netlify scheduled ticker, every job's CRON_SECRET-gated HTTP twin under app/api/cleanup/*, how Next.js App Router routes render/cache/revalidate on Netlify (static vs ISR vs dynamic, the traps that make a route silently dynamic), syncing environment variables between .env and the Netlify production deployment, keeping the modular Prisma seed suite in sync with the schema, and hard-won serverless-only failure modes (the react-pdf two-React clash, the PG_POOL_MAX=1 deadlock, after() as best-effort, CodeRabbit review mechanics, strict-protection PR trains). Use when the user says "cron", "scheduled job", "Netlify env", "ISR", "revalidate", "seed data", "500 only on the deployed build", or is touching netlify/functions/, app/api/cleanup/, jobs/, lib/cron/, or prisma/seed.ts.
---

# Maintenance

This is the index for operational and deployment plumbing that is not specific to any product domain — crons, environment sync, caching, seeds, and the Netlify/serverless failure modes that only show up on a deployed build.

| Reference                              | Purpose                                                                                                                                                                                                                                                              | Read it when                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `references/cron-ticker.md`            | State-as-outbox (ADR 27), why every job has an HTTP twin, the Netlify scheduled ticker, `?limit=` semantics, workflow concurrency groups, the checklist for adding a scheduled job.                                                                                  | Adding, changing, or debugging a scheduled job or a `/api/cleanup/*` route.                              |
| `references/netlify-env-sync.md`       | Auditing and synchronizing environment variables between the local `.env` and the Netlify production deployment.                                                                                                                                                     | Asked to sync env vars to Netlify, or after adding a new service key.                                    |
| `references/nextjs-netlify-caching.md` | Deciding and verifying how an App Router route renders and caches on Netlify — static vs ISR vs dynamic, revalidate windows, the traps that make a route silently dynamic.                                                                                           | Adding or changing `dynamic`/`revalidate`/`generateStaticParams`, or a page is slow or SSR looks empty.  |
| `references/prisma-seed-sync.md`       | Bringing the modular seed suite back in sync with the Prisma schema after a schema change.                                                                                                                                                                           | Seeds fail to compile, a schema change needs coverage, or seed data needs updating.                      |
| `references/serverless-gotchas.md`     | Hard-won runtime facts specific to Next.js on Netlify with Prisma/Postgres — the react-pdf two-React failure, the single-connection pool deadlock, `after()` as best-effort, Netlify scheduling and log facts, CodeRabbit mechanics, strict-protection merge chains. | Debugging a 500 that only happens on the deployed build, wiring server-side PDFs, or running a PR train. |

## Non-negotiables

Use one registered implementation per job and keep the required Netlify standby.
`lib/cron/schedule.ts` owns configured cadence, windows and HTTP request bounds;
the registry does not define phase or timeout fields. Regenerate the AST-derived
inventory with `npm run cron:reference` and verify `npm run cron:reference:check`.
The catalog has no worker, database or environment imports. Its ten-target figure
is a tested design bound, not a runtime dispatch cap. Configured Actions ownership
remains migration work until bounded replacements have actually run.

Recording transfer is ticker-owned every 15 minutes through its existing background adapter. Keep 202 admission separate from successful core completion and retain its fail-closed 15-minute lease. Session recovery runs via HTTP at :10/:40. The five daily lifecycle targets queue the narrow `stream-maintenance-background` worker in staggered daily windows; their Actions steps are removed. All six migrated cores fail closed, and daily completion health has a 27-hour budget. See `docs/stream/09-background-sync.md` for slice bounds and continuation.

Cron leases are Postgres-backed. Closed jobs never run when acquisition fails,
including Prisma import failures. Completion is conditional on the same execution
still being RUNNING; only successful owned completion advances freshness. Typed
outcomes and `X-Job-Outcome` distinguish partial failure and intentional holds.
Different jobs can still touch the same row: preserve CAS, transactional staging
and vendor idempotency, and test cross-job races and sequential replay.

The scheduled ticker has a 30-second budget, distinct from its HTTP workers.
A timeout or expired lease does not cancel vendor effects. Fleet selection fails
open on absent/unreadable `ops:active_cron_platform`, so it is not an exactly-once
guarantee. Verify accepted Sentry check-ins and independent per-capability absence
alerts; the shared heartbeat and HTTP200 alone do not prove complete health.

Maintenance bypass cookies remain short-lived HMAC-SHA256 tokens verified via Web
Crypto. Follow the active maintenance implementation and recovery instructions;
never infer that a cached phase quiesces work already in flight. See the linked
references for transaction-client, deployed-runtime and environment constraints.

PATCH updates require a validated non-empty reason, including ETA-only changes; use that value for incident and audit text. Maintenance retries preserve the active window's configuration and repeat OFFLINE setup until its completion stamp exists. Recovery checks database, Redis and chat before incident resolution and phase change. Preserve sequential session and channel-batch admission checks, paced vendor batches, transaction-client writes and ordered sidecar statements; a loop await is required when the next step depends on its predecessor or remaining budget.

Mocks of `maintenance-cron` must provide both exported error constructors: cleanup error mapping uses `instanceof` to distinguish unreadable state from planned holds.

Capture assertions that mock `@sentry/nextjs` must alias `@sentry/core` to the same mock, so native-worker helpers and Next.js routes share the asserted capture functions. Partial mocks spread the actual Core module, avoiding a circular import through the actual Next.js SDK.

Revalidate a confirmed booking’s live overlap inside the cancellation transaction before loading its full graph. Bootstrap missing maintenance edge state from the durable platform state before deploying fail-closed readers; never overwrite an active window with OFF. The release owner applies the exact reviewed SQL and performs the conditional no-TTL edge bootstrap immediately before merge; coding agents do not perform either operation. Unreadable-state GET protection on checkout verify applies only to `sync=true`, because the plain status poll is read-only.

The 48-hour paid-unallocated arm of `expire-stale-requests` commits EXPIRED,
history, `sub-unalloc:<paymentId>` full-refund markers and its bell together.
Its legacy recovery filters eligible payments before LIMIT with no liability
lookback. Keep existing markers/attempts, hold an oversized payment envelope
without partially expiring its liabilities, and preserve visible backlog on
errors or deadline truncation. Exhausting only the remaining invocation allowance
is a deferral, not an envelope error; stop the ordered page for the next run. Its shared 16-second admission budget covers
only this family; earlier expiry arms and nudge fairness remain separate work.
Do not describe the entire worker as deadline-bounded or its backlog as drained. `unallocatedHasMore` includes retired/foreign-owned obligations needing operator review; it is not a signal to keep automatically driving retries.
When extracting these phases, retain the same deadline closure and ordered fresh
payment allowance; keep earlier staged markers available for the delivery phase.

Raw SQL must follow Prisma's physical `@map`/`@@map` identifiers; the subscription
status column is `requestStatus`. Derive disposable SQL fixture identifiers from
the generated schema metadata, and verify query planning read-only before making
production capacity claims.

## Worktree verification

The Jest configuration keeps an explicit `@/` source mapping while retaining Next.js’s default mocks and transforms. Run targeted suites through the repository config. A CLI `--moduleNameMapper` replaces the entire map and can discard `server-only`, asset and Redis-edge mocks; do not use it as a shortcut for alias resolution.

When merging a worker migration, port its roster, limit, timeout and ledger-yield changes into the shared catalog; do not restore the adapter’s former inline schedule. Check generated output against the same inputs before and after generator refactors. Keep blank workflow names within their own source block and preserve escaped Markdown pipes. See `references/cron-ticker.md` for the current document-purge schedule and mocked verification boundary.

Stream background adapters currently target Netlify function URLs. Automatic
execution requires Netlify as active cron host; a host switch needs an equivalent
execution target. Keep lifecycle worker imports free of request authentication
and check actual native packaging, including CLI guards, before scheduling.

## Worker recovery contracts

Read [worker recovery](../../../docs/maintenance/11-worker-recovery.md) before changing export claims, artifact expiry or booking-expiry refunds. Export attempts use the exact `startedAt` token for claim and finalization CAS, an independently retained exact storage owner before upload, and immutable paths. Preserve READY with its audit and existing notification outboxes; never let postcommit delivery write FAILED or expose raw errors. Expiry requires successful exact remote absence evidence before retiring the owner. The operator applies the reviewed additive schema and legacy backfill before deploying the new reader.

Pending-consultation and approved-unallocated expiry commit full-remaining owed-refund markers in the same transaction as the winning EXPIRED transition. Reuse existing arm keys and refund retry ownership. Unpaid pending-subscriptions still exclude successful payments; do not broaden money eligibility. Completion freshness for these workers is not proof of backlog drain or actual alert receipt.
