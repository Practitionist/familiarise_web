---
title: "Jobs runtime, app and database layout, and cold starts: review of 2026-11-13"
type: explanation
---

# Jobs runtime, app and database layout, and cold starts: review of 2026-11-13

This page is a first-principles review of three linked questions: what background jobs should run on, where the app and the database should sit relative to each other, and what a cold function instance still costs. It is research evidence, not a decision. The owner decisions are in [the job-runtime evidence and decision record](../decisions/2026-10-31-job-runtime-experiments.md), [the ticker scale-path record](../decisions/2026-10-31-ticker-scale-path-and-queue.md) and [ADR 32](../enterprise/70-design-decisions/32-hosting-for-a-burst-sensitive-nextjs-app.md); where this page disagrees with them, they win until the owner changes them. The open decisions it feeds are issues #2491 (job runtime), #2751 (app and database layout), #1124 (cold instances) and #2752 (CI runner).

The review read the code at `dev` `169a9e228`. The labels are:

- **MEASURED**: run on 2026-11-13, either against the code or against production.
- **RECORDED**: an earlier measurement kept in this repository, read and not re-run.
- **UNVERIFIED**: a web-search summary; no vendor page was opened.
- **ESTIMATE**: arithmetic or reasoning with no run behind it.

## 1. Summary

1. Keep the Netlify ticker and Background Functions for launch, and adopt no job engine. The jobs do not need one.
2. What limits jobs and user requests alike is the round trip between the app in Singapore and the database in Mumbai. That is a web-tier layout question, so the job runtime follows the web tier.
3. One layout was never evaluated: move the database to Singapore instead of moving the app to Mumbai. Issue #2751 holds the comparison and the measurements to run.
4. The route-preload fix removed the 28-second stall and still holds on the Turbopack build. A cold instance still takes about 2.7 s before a bare route runs and about 6.7 s before a signed-in route runs.
5. Co-locating the app and the database does not fix cold starts. Fewer cold boots need instances that serve more than one request, and a shorter boot needs more CPU or a smaller sign-in import graph.

## 2. The jobs runtime

### 2.1 What the system is

MEASURED from `lib/cron/schedule.ts`, `netlify/functions/cron-tick.mts`, `lib/cron/with-cron-lock.ts` and `lib/cron/cleanup-registry.ts`:

- `TARGETS` holds 81 scheduled targets. Six of them go to Background Functions.
- A simulation of 30 days of five-minute ticks gives 88,163 scheduled dispatches before idle skips, with 9, 10 or 11 targets due on every tick against the cap of 12 (`MAX_TARGETS_PER_TICK`).
- 20 targets run every 15 minutes, 9 every 30, 2 every 10, 33 hourly and 17 less often.
- Correctness does not come from the scheduler. It comes from the row's own status as the queue, the Postgres lease in `withCronLock`, compare-and-swap status writes and the constraints in `prisma/sql/`. All four work on any host.

RECORDED in [the experiment index](../maintenance/experiments/2026-10-31-job-runtime/README.md) and the ticker record: typical jobs take 79 to 490 ms, the slowest tick took 18.5 s, 0.07 percent of target calls failed over 36 hours, and 99.8 percent of runs in one week found nothing to do.

### 2.2 Why no engine is needed

The table asks the questions that decide whether a durable engine or a queue would earn its place.

| Question                                                          | Answer here                                                           | Consequence                                             |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| Are the jobs long?                                                | No. Sub-second, except recording copies                               | No long-running worker is needed                        |
| Are they multi-step, where repeating a finished step costs money? | Rarely. Each sweep re-reads state and is safe to repeat               | Step memoisation buys little                            |
| Do they need timers accurate to seconds?                          | No. Five to fifteen minutes is enough                                 | No delayed-message queue is needed                      |
| Is throughput outgrowing one sweep per tick?                      | Not measured. Only recording copies have a known ceiling (#2492)      | No queue is needed yet                                  |
| What is slow?                                                     | 62 to 64 ms per statement raw, about 95 ms through the app (RECORDED) | A ten-statement transaction holds its lock about 700 ms |

Every engine in the experiments ran some side effect more than once, and only the Postgres-native libraries could enqueue inside a transaction (RECORDED). An engine would therefore not remove the idempotency keys, the leases or the reconcilers. It would add a second system that also has to be right.

### 2.3 When to reopen the engine question

Reopen it on any one of these, observed and not predicted:

- a flow with three or more external, non-repeatable steps that an idempotency key cannot make safe;
- waits of hours or days per item in volume, where a five-minute poll is too coarse;
- a backlog whose oldest item keeps ageing between ticks, read from the pending-age gauges the ticker already records.

"A job needs more than 25 s" is not a sufficient trigger on its own, because a Background Function already runs for up to 15 minutes.

### 2.4 Where this differs from the recorded decisions

| Recorded                                                             | This review                                                                                                                                                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch on the ticker plus Background Functions                       | Agrees                                                                                                                                                                                   |
| Next, choose between Vercel with Workflows and a Mumbai VM with DBOS | The framing bundles a host choice with an engine choice. Neither engine is needed for these jobs, and nothing in the workload needs an always-on server                                  |
| A hand-written Prisma `Job` table as the phase 2 queue               | Prefers alternate 1 of [the queue prototype](./06-queue-prototype-owed-refunds.md): add a next-attempt column to the existing sweep, and add a table only when a second source needs one |
| `pg_cron` with `pg_net` rejected as a second scheduler               | As a replacement clock it is the one trigger that survives a host change unchanged. Hold it in reserve; do not adopt it while the Netlify schedule fires                                 |
| Lift the ticker's logic into a portable route (#2491)                | Do it at a host move, not before. On Netlify a Next route has a tighter time limit than the scheduled function                                                                           |

## 3. Where the app and the database sit

Netlify has no Mumbai functions region (RECORDED; re-checked by search on 2026-11-13, UNVERIFIED). The table compares the three layouts for a request that runs 30 statements in sequence.

| Layout                                            | App to database, per statement | Network time for 30 statements | Basis            |
| ------------------------------------------------- | ------------------------------ | ------------------------------ | ---------------- |
| Today: app in Singapore, database in Mumbai       | 62 to 95 ms                    | about 1.9 to 2.9 s             | RECORDED         |
| App in Mumbai (Vercel `bom1`), database in Mumbai | 1.0 to 2.1 ms                  | about 30 to 60 ms              | RECORDED (probe) |
| App in Singapore (Netlify), database in Singapore | about 1 to 3 ms                | about 30 to 90 ms              | ESTIMATE         |

The third layout needs no app migration. Its cost is the statement in `app/(pages)/privacy/page.tsx` that the database is hosted in Mumbai, and whatever weight Indian buyers put on in-country storage; `docs/compliance/01-india-first-posture.md` records that the law does not require it. A Supabase project cannot change region in place (UNVERIFIED), so the choice has to be made when [the database split](../deployment/db-split-plan.md) creates a project. Issue #2751 lists the two measurements to run first: a Singapore database probe from a Netlify function, and a time-boxed boot of the real app on Vercel `bom1`.

## 4. Cold starts

### 4.1 What a cold request costs

MEASURED on production on 2026-11-13, with one burst of 12 requests to `/api/perf/probe-bare` and one of 16 to `/api/perf/probe-full`. Production had one warm instance when the test began, because the job fleet is paused before launch. The measuring machine was not in India, so the end-to-end column includes a different network path from a user's; the boot column comes from the probe's own `uptimeAtEntryMs` and does not.

| Case                                                       | Boot before the handler runs | End to end   |
| ---------------------------------------------------------- | ---------------------------- | ------------ |
| Warm instance, code already loaded                         | none                         | 0.5 to 1.1 s |
| New instance, `probe-bare`                                 | 2.7 to 2.9 s                 | 4.2 to 4.9 s |
| New instance, `probe-full` (the sign-in import graph)      | 6.4 to 7.1 s                 | 7.8 to 8.7 s |
| Instance already running, first `probe-full` request on it | not applicable               | 4.8 to 6.1 s |

No event-loop gap passed 51 ms on any instance created during the test, and peak memory was 126 to 273 MB. The stall that #1972 fixed has not returned, and the figures agree with the 2026-11-05 and 2026-11-06 sections of ADR 32.

Three consequences:

- **A warm instance is warm only for the code it has loaded.** The fourth row is an instance that had already served `probe-bare`. A keep-warm ping of a light route does not help a signed-in user.
- **The ticker is the warm pool.** ADR 32 found no cold instance in production while the ticker ran. Its job routes authenticate with `CRON_SECRET`, so an instance kept alive by the ticker may still pay the sign-in graph on its first signed-in request (ESTIMATE; not measured).
- **One page load is a burst.** Netlify runs one request per instance, so the parallel fetches and prefetches of a single page can each start an instance on a quiet site (#2609).

### 4.2 What would shorten or avoid it

| Lever                                 | Effect                                                                                                                                                                                                  | Status                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| More CPU for the handler (2,048 MB)   | The boot is CPU-bound at about half a core (RECORDED). Module loading is single-threaded, so one full core is the ceiling: a signed-in boot of about 6.7 s should fall to roughly 3.5 to 4 s (ESTIMATE) | Unmeasured, and blocked on the plan: on 2026-11-13 Netlify failed a throwaway preview that set the memory key, with "Configuring function memory requires a Pro plan or higher with credit-based pricing". ADR 32 predicts 3.1 s, which assumes the work spreads past one core |
| A smaller sign-in import graph        | Up to about 3.6 to 4 s per cold boot, on any host                                                                                                                                                       | Better Auth, SSO and passkey are the bulk (RECORDED). No profile has been taken                                                                                                                                                                                                |
| Fewer server calls per page           | Fewer instances started per visitor                                                                                                                                                                     | Planned in #2609, including the `get-session` call that runs for signed-out visitors                                                                                                                                                                                           |
| Instances that serve several requests | Removes the one-visitor burst                                                                                                                                                                           | Not available on Netlify Functions                                                                                                                                                                                                                                             |

Keep-warm pings are not recommended: they bill as invocations, and they would have to reach a signed-in route on every instance.

### 4.3 What Vercel Fluid compute would change

| Factor                                 | Netlify Functions                     | Vercel Fluid compute                           | Basis              |
| -------------------------------------- | ------------------------------------- | ---------------------------------------------- | ------------------ |
| Requests per instance                  | One                                   | Several; 5 to 6 in flight in the lab           | RECORDED           |
| A burst onto a warm pool               | Each extra request starts an instance | 20 requests ran on 7 instances, none cold      | RECORDED           |
| A burst onto a cold project            | All new                               | 17 of 20 were still new instances              | RECORDED           |
| CPU while booting                      | About half a core at 1,024 MB         | One core by default                            | RECORDED           |
| Compiled-code cache across cold starts | None                                  | Yes, on Node 20 or later                       | RECORDED           |
| An instance kept warm in production    | No plan offers it                     | Pre-warming on production deployments          | RECORDED           |
| This app's cold boot                   | 2.7 s and 6.7 s                       | Not measured: the app has not booted on Vercel | MEASURED, RECORDED |

The Vercel rows are the ones `.claude/skills/deployment/netlify/hosting-alternatives.md` read on Vercel's pages on 2026-09-12. Fluid compute should make cold starts much less frequent and somewhat shorter. It does not remove them: the first request after a deploy, after idle or during a scale-out is still cold, and the sign-in graph is the app's own cost on any host. The lab figures come from a small test function on the Hobby plan ([report 08](../maintenance/experiments/2026-10-31-job-runtime/08-vercel-fluid-prisma-qstash-workflows.md)).

Netlify announced "Netlify Server" in early access on 2026-11-10: long-lived instances that serve many requests and scale to zero (UNVERIFIED). Whether the Next.js adapter can use it, which regions it runs in and which plans qualify are not known. It is a product to watch, not to build on.

## 5. CI minutes

MEASURED on 2026-11-13 through the GitHub API: the `CI` workflow was active and ran on pull requests into `dev`, although [the CI decision](../decisions/2026-11-07-ci-before-and-at-launch.md) records it as disabled. In the run that was inspected, one job took 34 minutes and its changed-files Jest step took 27 of them on a two-core runner. Docs-only changes are excluded by the workflow's path filter. Issue #2752 proposes moving only that pull-request job to a third-party runner, so that GitHub's included minutes are reserved for `Release Checks` and the scheduled workflows; the runner prices there are UNVERIFIED.

## Where in code

| Concern                           | Location                                                               |
| --------------------------------- | ---------------------------------------------------------------------- |
| The schedule and the tick cap     | `lib/cron/schedule.ts`                                                 |
| The ticker                        | `netlify/functions/cron-tick.mts`                                      |
| The lease                         | `lib/cron/with-cron-lock.ts`                                           |
| The job registry                  | `lib/cron/cleanup-registry.ts`                                         |
| The cold-start probes             | `app/api/perf/probe-bare/route.ts`, `app/api/perf/probe-full/route.ts` |
| The preload flags and their guard | `next.config.mjs`, `__tests__/lib/next-config-preload.test.ts`         |
| The connection pool               | `lib/prisma.ts`                                                        |

## Deprecated & Superseded Approaches

- **Six parallel issues on the runtime question.** #2472, #2484, #2485, #2488 and #1010 were closed on 2026-11-13 in favour of #2491.
- **"Moving compute to Mumbai is the only fix for statement latency."** Superseded by the three-layout comparison in section 3; the Singapore database layout is unmeasured but must be weighed.
- **"Memory does not help the cold boot."** That was true of the stall before #1972, which was a different failure. The boot is now CPU-bound. The 2,048 MB test is the open measurement, and it needs credit-based pricing first.
