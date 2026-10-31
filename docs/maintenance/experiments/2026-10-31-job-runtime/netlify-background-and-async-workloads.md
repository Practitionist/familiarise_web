# Netlify Background Functions vs Async Workloads, Netlify (Singapore) -> Supabase Mumbai

Date 2026-10-31. Site `fw-probe-jobs-9651` (team Practitionist-Deploys, plan nf_team_pro, functions region ap-southeast-1; site id redacted). netlify-cli 26.0.2, function runtime node v22.23.4, pg 8.x, DB = shared Supabase pooler :6543 (ap-south-1).
Code: `netlify/functions/{job,probe,flaky,flakyv1,flakyexit}-background.*`, `netlify/lib/lab.{mjs,cjs}`, `setup.mjs` (this dir). The four earlier functions (db-probe, inngest, qs, wf) were kept and redeployed. Labels: MEASURED = my runs, timestamps from `lab_nbg.events` (clock_timestamp in Postgres); DOCS = official page.

## Verdict

1. Background functions work as advertised for admission (202 in ~0.3-0.85 s from a laptop) and as a 15-minute runtime (840 s completed, 960 s killed at exactly 900 s).
2. DB latency inside a background function is identical to a sync function: 63.9 ms per round trip.
3. **Retries are NOT what the docs imply for the modern handler.** A thrown error in a v2 default-export (`export default async (req) => {throw}`) was never retried (observed 20+ min). A legacy `exports.handler` that throws, a `process.exit(1)` crash, and a timeout kill ARE retried: 1 initial + 2 retries (about +1 min, then about +2 min later) = 3 attempts, then dropped silently.
4. Retries re-run side effects: no idempotency, no dedupe. Each attempt wrote its side-effect row.
5. The caller can never learn status. Use DB run rows (`SystemJobExecution`).
6. Concurrency: 10 at once all ran in parallel (start spread 0.51 s).
7. Async Workloads: this experiment did not install the extension. A later check found it already installed on the team (it is team-level, so it applies to every site on the team including `familiarise`); see [netlify-async-workloads-measured.md](./netlify-async-workloads-measured.md) for the measurements. Docs research only here.

## A1. Admission and runtime (MEASURED)

Caller `curl` to `/.netlify/functions/job-background?s=N`.

| N (s)      | HTTP | caller wait | ran to completion?                                                                                  | start -> end (db ts)             |
| ---------- | ---- | ----------- | --------------------------------------------------------------------------------------------------- | -------------------------------- |
| 10 (smoke) | 202  | 0.76 s      | yes                                                                                                 | 10.0 s                           |
| 60         | 202  | 0.85 s      | yes                                                                                                 | 12:06:09 -> 12:07:10 (60.001 s)  |
| 300        | 202  | 0.68 s      | yes                                                                                                 | 12:06:11 -> 12:11:11             |
| 840        | 202  | 0.65 s      | yes, and survived two prod redeploys mid-run                                                        | 12:06:11 -> 12:20:12 (840.001 s) |
| 960        | 202  | 0.68 s      | **no**: killed, no `end` row; last heartbeat el=870 s (12:20:43); Netlify log `Duration: 900324 ms` | killed ~12:21:12 (900 s)         |

Cap = 900 s (15 min). DOCS: "up to 15 minutes" https://docs.netlify.com/build/functions/background-functions/
The killed run was retried (below): second start 12:22:12 (+60 s after the kill), third start 12:39:18 (+2 min after the second kill at ~12:37:12). Each was killed again at 900 s (heartbeats end 12:40:49 for the third in progress when checked). So a timeout = 3 attempts of 15 min each, no `end` ever.

## A2. DB latency inside a background function (MEASURED, probe-background, warm-ish, run probe1)

| metric                                  | background fn                           | sync fn (earlier report A2) |
| --------------------------------------- | --------------------------------------- | --------------------------- |
| connect                                 | 387.5 ms                                | 377-396 ms                  |
| SELECT 1 x50 median / p95               | **63.9 / 64.3 ms** (min 63.7, max 66.1) | 62.1-64.1 / 62.8-64.6       |
| 20-query mix                            | 1752.6 ms (~88 ms/query)                | 1639-3686 ms                |
| lock-hold (10 round trips) median / p95 | 704 / 776.8 ms                          | 685-706 / 693-707           |

Matches the sync figure (62-64 ms per round trip). Total 12.7 s. Runs in ap-southeast-1.

## A3. Retries (MEASURED; docs DOCS)

DOCS: "If function invocation returns an error, a retry happens after one minute. If it fails again, another retry happens two minutes later." (same page above; the page states no further retries.)

| function shape                                       | behaviour                         | attempt times (UTC)                           | attempts | side-effect rows |
| ---------------------------------------------------- | --------------------------------- | --------------------------------------------- | -------- | ---------------- |
| v2 default export, throws on attempt 1 (`flakyonce`) | **not retried** (checked 20+ min) | 12:06:14                                      | 1        | 1                |
| v2 default export, throws always (`flakyalways`)     | **not retried**                   | 12:06:15                                      | 1        | 1                |
| same, on a draft deploy (`previewflaky`)             | not retried                       | 12:08:19                                      | 1        | 1                |
| v1 `exports.handler` throws on attempt 1 (`v1once`)  | retried once, then succeeded      | 12:11:53, 12:13:02 (+69 s)                    | 2        | 2                |
| v1 handler throws always (`v1always`)                | retried twice, then stopped       | 12:11:54, 12:13:02 (+68 s), 12:15:04 (+122 s) | **3**    | 3                |
| v2 `process.exit(1)` once (`exonce`)                 | retried, then succeeded           | 12:11:55, 12:13:03                            | 2        | 2                |
| v2 `process.exit(1)` always (`exalways`)             | retried twice                     | 12:11:55, 12:12:51 (+56 s), 12:14:41 (+110 s) | 3        | 3                |
| v2 timeout kill at 900 s (`len960`)                  | retried twice                     | 12:06:12, 12:22:12, 12:39:18                  | 3        | n/a              |

Interpretation: the v2 wrapper catches handler exceptions and returns a 500 response, which is not an "invocation error" for the async invoke, so no retry; real invocation failures (v1 uncaught rejection, process crash, timeout) retry at ~1 min and ~2 min. This is my inference from the measurements; Netlify does not document the v2 difference. A repo background job must therefore catch its own errors and record failure itself, and be idempotent because the 3 attempts are real.

## A4. Visibility

DOCS: only "monitor them along with your other functions" via logs; no status API, caller gets only the empty 202. MEASURED: nothing returned to the caller beyond 202; the invocation id is not exposed. The CLI `netlify logs --function job-background` shows only one `Duration: N ms  Memory Usage` line per invocation (e.g. 61054, 301460, 900324 ms) timestamped near invocation start, and lagged by minutes. Workaround in this repo: write a run row (start/heartbeat/end) in Postgres, as `SystemJobExecution` does; a sweep marks rows with no heartbeat as dead.

## A5. Concurrency (MEASURED)

10 requests fired together (xargs -P10), all 202 in 0.31-0.85 s. Start rows 12:06:19.741 -> 12:06:20.251, spread **0.51 s**; each ran 20.51-20.64 s; all 10 in parallel (no queueing). Starts include the ~400 ms DB connect before the row is written.

## A6. Deploy previews

DOCS: the background-function page says nothing about deploy previews (https://docs.netlify.com/build/functions/background-functions/); a search found no statement either way. MEASURED: on a **draft deploy** (`netlify deploy --alias bgpreview`, https://bgpreview--fw-probe-jobs-9651.netlify.app) background function returned 202 and ran to completion (`preview1` start 12:08:18, end 12:08:38, 20 s). So the earlier note "silently do not run" is not reproduced for draft deploys. Caveat: this was not a PR Deploy Preview; env vars scoped only to `production` first produced a no-DB-env situation (env must be set for all contexts). Retries on the draft deploy not observed for a v2 throw (same as prod).

## B. Async Workloads

### Not installed by this experiment (reason)

It is a **team-level extension** (docs: "install the Async Workloads extension for your team. After you install the extension, all sites on your team will be able to build Async Workloads functions", https://docs.netlify.com/build/async-workloads/get-started/). The team Practitionist-Deploys also owns `familiarise`, so installing would change the build of a site I was told not to touch, and billing is "as any other provisioned resources". I did not try `change-extension-installation`. MCP `get-full-extension-details` shows the extension exists (slug `async-workloads`, UI surfaces: site build-and-deploy configuration and team configuration, sdk 3.0.0) but I could not tell whether it is installed.
**Owner click path (written before the extension was found installed):** https://app.netlify.com/teams/<team-slug>/extensions -> Async Workloads -> Install (team-wide). A later check found it already installed on the team, so the click path is only needed if it is uninstalled; see [netlify-async-workloads.md](./netlify-async-workloads.md). Then per site: Project configuration > Developer settings > Async Workloads (API key; automatic on non-Starter plans). This team is `orb-pro` (credit-based plan; knowledge-base prerequisite "a project on a credit-based plan").

### Docs findings (DOCS)

| topic                           | finding                                                                                                                                                                                                                                               | URL                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| what                            | "resilient, scalable, and event-driven applications without the need to manage infrastructure and queues"                                                                                                                                             | /build/async-workloads/overview/                                                                     |
| plans                           | "provided as a Netlify Extension so that it can be enabled on any site and plan level"; Starter needs an API key                                                                                                                                      | overview, get-started                                                                                |
| pricing                         | "billed as any other provisioned resources"; no figures; credit-based plan                                                                                                                                                                            | overview; https://www.netlify.com/knowledge-base/background-jobs-and-workflows-with-async-workloads/ |
| send                            | `new AsyncWorkloadsClient().send('EVENT', {data})` returns `{eventId, sendStatus: succeeded\|failed}`; also HTTP router `/.netlify/functions/async-workloads-router?events=NAME` with bearer key; "send returns as soon as Netlify accepts the event" | /build/async-workloads/sending-events/                                                               |
| consumer                        | `asyncWorkloadFn(handler)` default export + `asyncWorkloadConfig.events`; cannot set `path`/`schedule`, cannot be invoked directly                                                                                                                    | get-started, limitations                                                                             |
| retries                         | default `maxRetries` 4 (5 attempts); backoff 5s, 20s, 1m20s, 8m, ... (x4), max 1 week; configurable; `ErrorDoNotRetry`, `ErrorRetryAfterDelay`; dead-letter retention 30 days                                                                         | /build/async-workloads/writing-workloads/, /lifecycle/                                               |
| delay                           | `options.delayUntil` up to 1 year (ms, timestamp or ms-string); `priority` -50..50 applies only to delayed; FIFO                                                                                                                                      | sending-events, lifecycle                                                                            |
| multi-step                      | `step.run(id, fn)`, `step.sleep(id, dur)`; "If a step succeeds, it won't be repeated on a retry"; code outside steps re-runs every invocation                                                                                                         | /build/async-workloads/multi-step-workloads/                                                         |
| per-step duration               | not stated on the step page; site setting `AWL_SERVERLESS_TIMEOUT`: standard functions 60 s default, background functions 15 min                                                                                                                      | /build/async-workloads/optional-configuration/                                                       |
| state                           | "stored exclusively as Blobs on the site"; dead letters under Data & Storage > Blobs `async-workloads-state-dead-lettered/*`                                                                                                                          | lifecycle                                                                                            |
| limits                          | payload under 500 KB per event (batches of up to 10 within the 6 MB function limit), chain limit 20, pending limit 2000, scheduler interval 60 s (10-900); non-production scheduler runs only on stateful actions                                     | limitations, optional-configuration                                                                  |
| transactional send / dual write | not documented. `send` is an HTTP call to Netlify, independent of your DB transaction, so commit-then-fail-before-send loses the job unless you add your own outbox (this repo's state-as-outbox sweep is the answer). Inference, not measured.       |                                                                                                      |

Not measured by this experiment: event-to-start latency, backoff timing, delay accuracy, crash-in-step-2 re-run counts, 60 s/300 s steps and the dual-write test. See [netlify-async-workloads-measured.md](./netlify-async-workloads-measured.md).

## Dashboard URLs

- Function logs (all functions, incl. background; filter by function): https://app.netlify.com/projects/fw-probe-jobs-9651/logs/functions
- Draft deploy logs: https://app.netlify.com/projects/fw-probe-jobs-9651/logs/functions?scope=deploy:<deploy-id>
- Deploys: https://app.netlify.com/projects/fw-probe-jobs-9651/deploys
- Async Workloads UI: no dedicated events dashboard in the docs; extension config at the team Extensions page, site Developer settings > Async Workloads, events/dead letters via Data & Storage > Blobs.

## Cleanup proof

- `DROP SCHEMA lab_nbg CASCADE` run; `select nspname from pg_namespace where nspname like 'lab_nbg%'` returned 0 rows (printed `remaining lab_nbg schemas: 0` and an empty table).
- Site env var `PROBE_DB_URL` unset (`netlify env:list`: "No environment variables set"), production redeployed without secrets.
- Site kept. The draft deploy alias `bgpreview` still exists. Extension: not installed by me (a later check found it installed on the team).
- Note: the third `len960` attempt (started 12:39) was still running at cleanup; it will fail on DB writes (schema gone) and does no harm. No other site was touched. No repo changes, no commits. Earlier-run schema `lab_nlock` (previous task) not touched here.
