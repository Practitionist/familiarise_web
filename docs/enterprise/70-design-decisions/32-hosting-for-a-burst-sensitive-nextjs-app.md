---
title: Hosting for a burst-sensitive Next.js app
band: 70-design-decisions
audience: sde3
status: accepted
last-reviewed: 2026-10-03
---

# ADR 32 — Hosting for a burst-sensitive Next.js app

## Context

The application runs as a single Netlify server handler (`@netlify/plugin-nextjs` 5.15, Node 22, 1024 MB, region `sin`) in front of a Supabase Postgres project in Mumbai. Its warm performance is unremarkable in the good sense: the 2026-09-12 production logs record a p50 of 219 ms across 67 warm invocations. Its cold performance historically exhibited a ~24–32 s event-loop stall (#1124) that culminated in a 100% `504 Inactivity Timeout` outage on 2026-10-03 (#1972).

Before 2026-10-03, twelve-request bursts against a fresh deploy landed 11 of 12 requests at 27–39 s (`idleProbe.maxGapMs` ~24–26 s), even on the zero-import `/api/perf/probe-bare` route (PR #1656). Doubling memory and vCPU to 2048 MB did not help (11 of 12 at 35.9–37.6 s plus a platform 500) and was reverted; lazy SDK initialisation (#1221) changed nothing. Because `/api/perf/probe-bare` imported zero application modules and still saw a ~26 s event-loop freeze after its own module evaluated, both the 2026-09-15 research pass and Netlify Support (ticket #1112198) misattributed the stall to AWS Lambda container initialisation contention in `ap-southeast-1`.

## 2026-10-03 Root-Cause Breakthrough (`NextNodeServer` `unstable_preloadEntries()`, PR #1972)

On 2026-10-03, after PR #1948 (`2b54ca3a3`) bumped `@novu/api`, `@novu/nextjs`, `@sentry/nextjs`, and `prisma`, every cold Lambda start on production timed out at 31–38 s (`504 Inactivity Timeout` / `the edge function timed out`). Standalone profiling of `NextNodeServer` (`node_modules/next/dist/server/next-server.js` lines 518–616) uncovered the true mechanism behind both #1124 and #1972:

1. **Why Netlify hit this and Vercel did not (`minimalMode: false` vs `minimalMode: true`):**
   Vercel runs `NextNodeServer` with `minimalMode: true`, which bypasses the `if (!options.minimalMode)` startup preload block. `@netlify/plugin-nextjs` v5 instantiates `NextNodeServer` with `minimalMode: false`.
2. **Next.js 15's default `preloadEntriesOnStart: true` and `appDocumentPreloading: true`:**
   With `minimalMode: false`, `new NextNodeServer()` immediately launches an unawaited `this.unstable_preloadEntries()` promise that iterates over all **606 routes** (`pagesManifest` + `appPathsManifest`) and calls `loadComponents()` on every route — executing **1,676,071 `webpackRequire` calls** on the single-threaded Node.js event loop right in the middle of the first request (including `/api/perf/probe-bare`!).
3. **Node 22's 512 MB V8 Old-Space Heap Limit on 1024 MB Lambda Containers:**
   `[build.environment] NODE_OPTIONS = "--max-old-space-size=6144"` in `netlify.toml` applies only at build time. At runtime on 1024 MB Lambda containers, Node 22 sets V8's default old-space heap cap to `512 MB`. Preloading all 606 routes after #1948 reached **496–512 MB V8 heap (`642 MB RSS`)**, triggering fatal V8 `Mark-Compact` GC thrashing / OOM before any response byte could be sent.

## Options

1. **Stay on Netlify with `preloadEntriesOnStart: false` and `appDocumentPreloading: false` (PR #1972 — Accepted).** Disables `NextNodeServer`'s cold-start 606-route preload in `next.config.mjs` and externalises `@novu/api` in `serverExternalPackages` so routes load on demand. Cost: zero infrastructure migration; cold-start V8 heap drops from **512 MB to 33 MB (`123 MB RSS`)**, single cold start drops from **31.5 s (`504`) to 1.32 s (`200 OK`)**, and a 12-request concurrent cold burst across 8 brand-new Lambda instances in `ap-southeast-1` (`sin`) completes **12/12 `200 OK` in `0.97–1.90 s`** (`maxGapMs: 0–25 ms`).
2. **Vercel Fluid Compute.** Shares one warm process and connection pool across concurrent requests, offers `bom1` (Mumbai), and supports `maxDuration` up to 800 s on Pro. Remains the natural future upgrade if `PG_POOL_MAX=1` per-instance connection pooling or the ~55–70 ms Singapore-to-Mumbai database RTT becomes a bottleneck at higher concurrency.
3. **An always-on host** (Fly, Railway, Fargate; $6–33 per month). Removes cold starts and places the server in Mumbai, at the cost of owning preview environments and deployment pipelines.

## Decision

**Accepted: Option 1 (Stay on Netlify with `preloadEntriesOnStart: false` and `appDocumentPreloading: false`, PR #1972).**

Live verification on `deploy-preview-1972` (deploy `6ac1179a30acd900087d7e4a`, region `ap-southeast-1`, 1024 MB) proved that the cold-start burst stall was entirely caused by `NextNodeServer`'s eager 606-route preloading under `minimalMode: false`:

- **Single cold start (`/api/perf/probe-bare`):** `200 OK` in **`1.326 s`** (`moduleAgeMs: 21`, `maxGapMs: 1 ms`).
- **Single cold start (`/api/health`):** `200 OK` in **`1.714 s`** (`status: "healthy"`, `eventLoopStallMs: 9 ms`, `databaseLatencyMs: 66 ms`).
- **12-request concurrent cold burst (`/api/perf/probe-bare?burst=1..12`):** Spawned 8 brand-new cold Lambda instances (`moduleAgeMs: 4–62 ms`) + 1 warm instance; **12/12 succeeded (`200 OK`) in `0.97–1.90 s`** with `maxGapMs: 0–25 ms` and **0 timeouts**.
- **6-request concurrent burst (`/api/health?burst=1..6`):** **6/6 succeeded (`200 OK`, `status: "healthy"`) in `1.22–2.19 s`**.

## Consequences

1. The application remains on Netlify in `sin` (`ap-southeast-1`) without requiring an emergency platform migration before launch.
2. `__tests__/lib/next-config-preload.test.ts` permanently guards `experimental.preloadEntriesOnStart === false` and `experimental.appDocumentPreloading === false` in CI so the 606-route cold-start preload can never regress.
3. All Netlify architectural constraints, experimental dead ends, and Day-1 SaaS configurations are consolidated in `docs/deployment/netlify.md` (Section 14).

## Sources

`docs/deployment/netlify.md` (Section 14); `.claude/skills/deployment/netlify/platform-limits.md`; `.claude/skills/deployment/netlify/hosting-alternatives.md`; `.claude/skills/deployment/netlify/issue-ledger.md`; issue #1124; PR #1972; ADR 14; ADR 27.
