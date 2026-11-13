---
title: Hosting for a burst-sensitive Next.js app
band: 70-design-decisions
audience: sde3
status: accepted
last-reviewed: 2026-11-13
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

## 2026-11-05 measurement: webpack versus Turbopack, and where cold time goes

On 2026-11-05 production moved to Turbopack builds (`docs/decisions/2026-11-05-turbopack-production-build-for-source-maps.md`). The same day, parallel 8-request bursts on `/api/perf/probe-bare` were sent from the same machine in India to two Netlify deploy permalinks (`https://<deploy_id>--familiarise.netlify.app`), so both builds were compared on equal terms:

| Build                          | Deploy                     | Cold `uptimeAtEntryMs` | Cold request, end to end | `idleProbe.maxGapMs` |
| ------------------------------ | -------------------------- | ---------------------- | ------------------------ | -------------------- |
| webpack (commit `424a8daec`)   | `6aeaf1b2dbfd86009ac2b8b3` | 2.9–3.7 s              | 6.4–8.1 s                | 0–30 ms              |
| Turbopack (commit `2b354c35f`) | `6aecc0c644358da5321acdda` | 2.5–2.7 s              | 3.9–4.6 s                | 1–32 ms              |

What it shows, with its limits:

- **This is an observation from two deploys, not a controlled bundler test.** The two commits differ by the Turbopack switch and nine other merged PRs (booking, payments, support and docs). The Turbopack deploy booted no slower than the webpack one, which is evidence against a Turbopack cold-start regression, but it does not isolate the bundler.
- **The #1124 stall has not returned.** No event-loop gap reached even 50 ms on either deploy, and `experimental.preloadEntriesOnStart: false` is intact. `__tests__/lib/next-config-preload.test.ts` still guards it.
- **No drift since 2026-10-03 is established.** From the measuring machine, even a warm request takes about 1.36 s, so the 2026-10-03 figures (0.97–1.90 s end to end) came from a different network path and cannot be compared directly. October recorded no `uptimeAtEntryMs`. Boot before the handler is 2.5–3.1 s on a 2026-10-29 webpack build and on current code alike, at Netlify's 1024 MB (about 0.5 vCPU). Most of the end-to-end gap between the two deploys in the table is outside Node: an idle, unpublished permalink spends 2.2–2.9 s on Lambda sandbox creation and fetching its 42–46 MB code package, while the published deploy, which cron-tick keeps exercising, spends about 0.7 s there.
- **The largest fixable cold cost is the authenticated route graph.** On the same production deploy, a cold instance reaches `/api/perf/probe-full` at 6.7–6.9 s against 2.5–2.6 s for `probe-bare`, so about 4 s goes on importing that graph. esbuild counts 3,615 modules in the `lib/auth` graph that every authenticated route reaches through `lib/auth-helpers`: Better Auth, SSO, passkey (added 2026-10-10) and the whole email stack, which `lib/auth.ts` pulls in through the `lib/email` barrel for `sendPasswordResetEmail`. The full investigation, with the measurements and the ranked fixes, was run on 2026-11-05.
- **Each 8-request burst also returned one Netlify platform error page** ("Error - Request ID …") on both deploys.

Measure any fix with the same burst against a deploy permalink. An idle wait does not guarantee cold instances, and a published deploy also receives cron-tick traffic, so classify each sample by its own fields: a fresh instance reports a small `uptimeAtEntryMs` (a few seconds) and a new `instanceId`. Compare only those rows, and the same route on both sides.

### 2026-11-06: the email stack leaves the auth graph, and the boot is CPU-bound

The authenticated route graph no longer loads the email stack at boot. `lib/auth.ts`, `lib/auth/account-lifecycle.ts`, `lib/auth/security-email.ts` and `lib/novu/stage-then-attempt.ts` now load their senders with `import()` at the moment they send, and `lib/time/viewer-zone.ts` imports `date-fns/locale/en-US` instead of the whole locale index. Every send still goes through `deliver()`. esbuild counts the static graph of `/api/perf/probe-full` at 2,896 modules (14.4 MB of source), down from 3,604 modules (17.8 MB). React Email and the templates are gone from it, and `date-fns` drops from 826 files to 304.

The same release added boot fields to both probes: `cpuAtEntry` (CPU time the process has used by the time the handler starts), `resourceAtEntry` (peak memory, file reads and context switches), `nodeTiming` (Node's own start-up milestones) and `nodeVersion`. The older fields are unchanged.

The measurement was one 12-request burst against each of two idle, unpublished deploy permalinks, fired at the same moment (01:55 IST). Each burst sent six requests to `probe-bare` and six to `probe-full`. The "before" deploy was the `dev` branch deploy of this change's base commit (`8b6f84530`, deploy `6aecd555aa0a5a895803e378`). The "after" deploy was this change's preview (deploy `6aece157bb152c479fd9b900`). Only rows from new instances count:

| Route                     | Before: cold `uptimeAtEntryMs` | After: cold `uptimeAtEntryMs` | Change in the median |
| ------------------------- | ------------------------------ | ----------------------------- | -------------------- |
| `probe-bare` (control)    | 2,485–2,722 ms (4 instances)   | 2,525–2,718 ms (6 instances)  | about +0.08 s, noise |
| `probe-full` (auth graph) | 6,315–6,604 ms (6 instances)   | 6,178–6,330 ms (5 instances)  | about −0.36 s        |
| Route graph (full − bare) | about 4.0 s                    | about 3.6 s                   | about −0.4 s         |

The published production figures from 2026-11-05 (`probe-full` 6.66–6.91 s, `probe-bare` 2.48–2.65 s) agree with the "before" column. A simultaneous burst on the production permalink found no cold instance at all: all twelve requests landed on instances between 126 s and 48 min old, which cron-tick keeps alive. So production cannot serve as a cold baseline. Cutting the email stack saved about 0.4 s of the 4 s route-graph cost. That is less than the 0.5–1.0 s first estimated. Better Auth, SSO and passkey are still the bulk of the graph.

**The boot is CPU-bound.** AWS gives a Lambda one vCPU at 1,769 MB, so the 1,024 MB handler gets about 0.58 vCPU. On every cold row, on both routes and both deploys that report the field, the process had used 0.58–0.62 CPU-seconds per second of uptime when the handler started. That is its whole CPU share from start to handler. A process waiting on disk or network would sit well below that line. Node's own start-up is short: the event loop starts about 0.23 s after the process. The remaining boot is CPU work in the Netlify handler, the Next server, Sentry and the route modules. Cold `probe-bare` instances peaked at 124–135 MB of memory and cold `probe-full` instances at 258–261 MB, far below 1,024 MB. Memory is therefore not the constraint, but CPU share scales with it. The runtime is Node `v22.23.4`.

This verdict is different from the August 2048 MB test. That test ran while the preload stall was blocking the event loop, so it measured a different failure. More CPU is now expected to shorten the boot roughly in proportion. A 2,048 MB setting (about 1.16 vCPU) would put cold `probe-bare` near 1.3 s and cold `probe-full` near 3.1 s. That is a prediction, not a measurement. Measure it on one preview before deciding anything.

The memory setting is per deploy. Netlify records memory per function on each deploy (`available_functions[].m` in `getDeploy`). It is set by `[functions."___netlify-server-handler"] memory = 2048` in the `netlify.toml` of the commit being built. In August this applied to a single deploy preview while production stayed at 1,024 MB. Netlify does not document `[functions]` as a context-aware key, so `[context.deploy-preview]` cannot scope it. The only safe scope is a throwaway branch that is never merged. The site record has no memory setting (`getSite` reports only `functions_region`). Compute bills by configured memory multiplied by duration ([Netlify functions configuration](https://docs.netlify.com/build/functions/configuration/)), so 2,048 MB would roughly double server-handler GB-hours, from about 53 to about 106 a month. That figure is extrapolated from a 35-minute sample of handler time at pre-launch traffic on 2026-11-05. The legacy Pro plan includes 1,000 GB-hours.

A fresh deploy preview is not idle when it turns ready. The function log of the preview above shows server-handler invocations with Prisma start-up lines from the second the deploy turned ready, about 20 s before any probe request. A burst fired straight after a deploy therefore lands mostly on instances that are already booted. Wait at least 15 minutes after a deploy is ready before bursting it.

### 2026-11-13: production re-measured, and a warm instance is warm only for loaded code

Production (Turbopack build, 1,024 MB, `ap-southeast-1`) was burst once with 12 requests to `probe-bare` and once, 25 seconds later, with 16 to `probe-full`. The job fleet was paused before launch, so only one warm instance existed and both bursts created new ones. Rows are classified by `instanceId` and `uptimeAtEntryMs` as above.

| Row                                                                 | `uptimeAtEntryMs` | End to end                                             | Peak memory |
| ------------------------------------------------------------------- | ----------------- | ------------------------------------------------------ | ----------- |
| New instance, `probe-bare` (6 instances)                            | 2,682–2,885 ms    | 4.2–4.9 s                                              | 126–136 MB  |
| New instance, `probe-full` (6 instances)                            | 6,352–7,071 ms    | 7.8–8.7 s                                              | 259–263 MB  |
| Instance from the first burst, its first `probe-full` (6 instances) | about 27–29 s     | 4.8–6.1 s                                              | 258–273 MB  |
| The one instance that was warm beforehand                           | about 49 min      | 0.5–1.4 s; one request queued behind others took 5.5 s | 424 MB      |

The end-to-end column was measured from outside India and is not comparable with the columns above; the boot column is. What it adds:

- **The #1124 stall has not returned.** No `idleProbe.maxGapMs` passed 51 ms on any instance created during the test.
- **The boot figures agree with 2026-11-05 and 2026-11-06.** Nothing has drifted.
- **A warm instance is warm only for the code it has loaded.** The third row had already served `probe-bare` and still took 4.8–6.1 s on its first request that loads the `lib/auth` graph. A keep-warm ping of a light route therefore does not help a signed-in user, and an instance the ticker keeps alive through a `CRON_SECRET` route may still pay this cost (not measured).
- **The warm pool is the ticker.** The 2026-11-06 burst found no cold instance in production; this one found a single warm instance, because the fleet is paused ([the pause record](../../decisions/2026-11-06-pause-scheduled-jobs-prelaunch.md)).

One caution on the 2,048 MB prediction above. Module loading is single-threaded, so one full core is the ceiling for most of the boot. At 0.58–0.62 CPU-seconds per second, a 6.3–7.1 s boot is about 3.7–4.4 CPU-seconds, which puts cold `probe-full` nearer 3.5–4 s than 3.1 s at any setting of one core or more. That is still an estimate. The measurement remains open, and [the 2026-11-13 review](../../infrastructure/08-jobs-runtime-and-cold-start-review.md) sets it beside the other levers.

## Sources

`docs/deployment/netlify.md` (Section 14); `.claude/skills/deployment/netlify/platform-limits.md`; `.claude/skills/deployment/netlify/hosting-alternatives.md`; `.claude/skills/deployment/netlify/issue-ledger.md`; issue #1124; PR #1972; ADR 14; ADR 27.
