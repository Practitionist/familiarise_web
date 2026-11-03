---
title: GitHub Actions crons over Netlify scheduled functions
band: 70-design-decisions
audience: sde3
status: superseded
last-reviewed: 2026-10-23
---

# ADR 05 — Scheduled jobs run as GitHub Actions (superseded for money jobs)

## Decision, as originally taken

Scheduled jobs ran as GitHub Actions workflows, each a YAML file with a `schedule:` and a `workflow_dispatch:` trigger. A workflow checked out the repository and executed the job's TypeScript entry point directly, while the `CRON_SECRET`-gated routes under `app/api/cleanup/**` served as a manual fallback. Actions won over Netlify scheduled functions on observability, execution-time limits and portability.

## What replaced it

Every money job now runs on the Netlify five-minute ticker (`netlify/functions/cron-tick.mts`), which calls the `CRON_SECRET`-gated twins registered in `lib/cron/cleanup-registry.ts` and holds mutual exclusion in a Postgres lease. The reasoning, the fleet switch and the failure handling are in [ADR 27](27-state-as-outbox-and-scheduled-ticker.md); the job list is listed in [scheduled money jobs](../../finance/70-operations/01-scheduled-jobs.md).

The non-money housekeeping that Actions still scheduled after that (`cron-daily.yml`, `cron-weekly.yml` and `cron-intra-day.yml`) has moved to the same ticker, and those three workflows and their `tsx` wrappers are deleted. No workflow schedules a registry job; the remaining scheduled workflows are checks (heartbeat, live schema drift, security audit).

The ledger audit progresses through bounded canonical slices offered hourly at `:55`, yielding to other due work at the ticker design bound. It does not require an Actions backstop or a background driver.

## Delete if found

The per-job money workflows and any exit-code convention for a money job. To run a money job by hand, `POST /api/cleanup/<slug>` with `Authorization: Bearer $CRON_SECRET`, or use the admin system-jobs console.
