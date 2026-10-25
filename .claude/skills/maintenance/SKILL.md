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

Recording transfer is ticker-owned every 15 minutes through its existing background adapter. Keep 202 admission separate from successful core completion and retain its fail-closed 15-minute lease. Remaining Actions-only Stream lifecycle jobs are still migration work.

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

## Worktree verification

The Jest configuration keeps an explicit `@/` source mapping while retaining Next.js’s default mocks and transforms. Run targeted suites through the repository config. A CLI `--moduleNameMapper` replaces the entire map and can discard `server-only`, asset and Redis-edge mocks; do not use it as a shortcut for alias resolution.

When merging a worker migration, port its roster, limit, timeout and ledger-yield changes into the shared catalog; do not restore the adapter’s former inline schedule. Check generated output against the same inputs before and after generator refactors. Keep blank workflow names within their own source block and preserve escaped Markdown pipes. See `references/cron-ticker.md` for the current document-purge schedule and mocked verification boundary.
