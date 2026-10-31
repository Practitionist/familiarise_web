---
title: Job machinery, what a host move removes, and portability
type: explanation
---

# Job machinery, what a host move removes, and portability

This page answers three questions that the runtime comparison on [page 14](./14-background-job-runtime-options.md) and the layer view on [page 15](./15-job-runtime-layer-matrix.md) leave open. How much code is job machinery? How much of it would a move to another host remove? And what has to stay portable so that a move is a trigger swap and not a rewrite? It is evidence for decisions already taken and does not take a new one. The brief on machinery and portability is also carried by issue #2491. The owner decision is in [the evidence and decision record](../decisions/2026-10-31-job-runtime-experiments.md). Labels follow page 14, and ESTIMATE means arithmetic or reasoning with no run behind it.

## 1. The machinery

The table lists the job machinery by file group. The line counts were taken with `wc -l` on the current tree before publishing, and the "why it exists" column says whether the code survives a host move.

| Files                                                                                                                                                                                                                                            |  Lines (`wc -l`) | What it does                                                                                 | Why it exists                                   | On a move              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------: | -------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------- |
| `lib/cron/cleanup-registry.ts`                                                                                                                                                                                                                   |            2,410 | Maps the registered job names (about 76) to their cores                                      | One implementation per job (`AGENTS.md` rule 1) | Keep on any platform   |
| `netlify/functions/cron-tick.mts`                                                                                                                                                                                                                |              881 | Fan-out, the fleet switch, retry and de-dupe, outcome parsing and the Sentry check-in        | Netlify's single 30 s scheduled function        | Mostly removed         |
| `lib/cron/schedule.ts`                                                                                                                                                                                                                           |              655 | Offsets, windows, limits and timeouts, and the 12-per-tick cap (`MAX_TARGETS_PER_TICK`)      | Packing all the jobs into one tick              | Mostly removed         |
| `lib/cron/cleanup-route.ts`, `with-cron-lock.ts`, `run-record.ts`, `run-outcome.ts`, `run-context.ts`, `run-counters.ts`, `job-outcome.ts`, `cron-lock-errors.ts`, `cas-notice.ts`, `failure-streak.ts`, `dispatch-refusal.ts`, `run-display.ts` | 1,656 (12 files) | Lease, run rows, outcomes, counters and refusal rules. This is correctness and observability | Needed on every host                            | Keep                   |
| `lib/cron/run-deadline.ts`, `dispatch-background.ts`, `background-worker.ts`, `netlify/functions/recording-transfer-background.mts`, `netlify/functions/stream-maintenance-background.ts`                                                        |    324 (5 files) | Per-run deadlines and hand-off to Netlify Background Functions                               | Netlify's time limits                           | Removed if limits lift |

The registry job count is about 76. The registry carries 77 `@cleanup-twin` markers and the generated cron reference is the source for the exact figure.

## 2. What a move to Vercel removes

A per-job Vercel Cron (Pro allows 100 cron jobs per project, DOCS; we have about 76) or a single cron entry, together with 300–800 second functions, removes about 1,500–2,000 lines (ESTIMATE): the ticker fan-out in `cron-tick.mts`, the packing in `schedule.ts`, `run-deadline.ts` and the background adapters. Vercel Workflows itself only helps the few genuinely multi-step jobs, because most jobs are idempotent sweeps that read database state. Leases, compare-and-swap writes, run records, the registry and the outbox stay on every platform. They are the correctness layer (layer 6 on page 15), and the Postgres constraints in `prisma/sql/` enforce the final state wherever the code runs.

## 3. The Netlify-specific surface

The Netlify-specific code is small. It is the files in `netlify/functions/`, `next.config.mjs` (the `NETLIFY` build flags), `lib/runtime-host.ts`, `lib/api/cdn-cache.ts` (the `Netlify-Vary` header helper), `lib/cron/schedule.ts`, `netlify/functions/cron-tick.mts`, and the routes that set `Netlify-Vary` (health, currency and the consultant routes). The dual-boot rules in `AGENTS.md` already cover client-IP trust by runtime, `Vary: Cookie`, the `sharp` exclusion and presigned uploads, so the same build runs on Netlify and elsewhere.

The real work of a move is the ticker replacement plus the build issues the [real-app attempt](./experiments/2026-10-31-job-runtime/real-app-vercel-bom1-attempt.md) found: middleware loading as an ES module under Node 26, the static-generation hang on Node 22, Node pinning and build memory. The estimate is a few hundred changed lines plus build debugging (ESTIMATE). It is not a rewrite, and the jobs and the money logic do not change.

## 4. Portability as ports and adapters

The picture shows the shape that makes the move a trigger swap. Each platform supplies only a trigger adapter. Everything to the right of it is portable.

```text
  TRIGGER ADAPTERS (thin, one per platform)            PORTABLE CORE
  ┌──────────────────────────────────────┐
  │ Netlify Scheduled Function (today)   │──┐
  │ Vercel Cron (per job or one entry)   │──┤
  │ GCP or AWS scheduler                 │──┼─►  POST /api/cleanup/[job]
  │ In-process cron on a VM              │──┘     (one HTTP route per job, CRON_SECRET)
  └──────────────────────────────────────┘                    │
                                                              ▼
                                         the registry handler for that job name
                                         (lib/cron/cleanup-registry.ts)
                                                              │
                                                              ▼
                                         withCronLock: one RUNNING row per job
                                                              │
                                                              ▼
                                         the job core: claim rows, CAS-in-WHERE,
                                         call Razorpay / Stream / Resend
                                                              │
                                                              ▼
                                         Postgres: leases, run rows, outbox state,
                                         constraints and triggers (prisma/sql/)
```

- **Keep portable:** the registry, the handler invocation (the same one the admin Run door uses), leases, compare-and-swap, the outbox and the HTTP route per job.
- **Keep thin per platform:** the trigger, `lib/runtime-host.ts`, the `next.config.mjs` flags and the cache headers.
- **Not portable:** Vercel Workflows and Cloudflare Workflows are proprietary to their hosts. For portable durable steps use DBOS, pg-boss or the planned Prisma `Job` table. Whether the Workflow DevKit's pluggable "Worlds" backends make Vercel Workflows portable is UNVERIFIED.
- **Handle limits, regions and egress through configuration**, not code branches: a per-job time budget, the region, and the egress proxy (`RAZORPAYX_EGRESS_PROXY_URL`).

## Where in code

| Concern                | Location                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------- |
| The registry           | `lib/cron/cleanup-registry.ts`                                                      |
| The ticker and its cap | `netlify/functions/cron-tick.mts`, `MAX_TARGETS_PER_TICK` in `lib/cron/schedule.ts` |
| The HTTP route per job | `app/api/cleanup/[job]/route.ts`, `cleanupRoute` in `lib/cron/cleanup-route.ts`     |
| Lease                  | `withCronLock` in `lib/cron/with-cron-lock.ts`                                      |
| Host detection         | `lib/runtime-host.ts`                                                               |
| Cache headers          | `lib/api/cdn-cache.ts`                                                              |

## Deprecated & Superseded Approaches

- **Treating the ticker as part of the job logic.** The ticker, its packing and its background adapters exist because of one host's limits. They are the part of the machinery that a move retires; the registry, leases and run records are not.
