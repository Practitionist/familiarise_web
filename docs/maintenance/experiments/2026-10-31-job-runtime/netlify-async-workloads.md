# Netlify Async Workloads measurement: BLOCKED, no measurements taken

Date: 2026-10-31. Site: fw-probe-jobs-9651 (site id redacted), functions in ap-southeast-1.

## Verdict

Items 1-9 were not measured. The extension's router, scheduler and API functions are injected only by a build that runs on Netlify's own buildbot (a Git-triggered build). A CLI deploy does not get them.

## Versions

- netlify-cli 26.0.2, node 26.9.0 locally.
- @netlify/async-workloads 0.0.106, @netlify/functions, pg 8.x.
- Runtime on Netlify: nodejs24.x.

## Evidence (MEASURED)

- AWL_API_KEY was already present on the site through the team-level auto-generated key, so no dashboard click was needed for the key.
- `netlify deploy --prod --build` uploaded 3 functions (send, wl-main, wl-long-background). Deploy `available_functions` had none of the extension's functions (no async-workloads-router, scheduler or api).
- The first `client.send` returned `sendStatus: "failed"` (event id redacted). No workload ran in 30 s.
- `netlify build` (production and dev context, also with NETLIFY=true) prints "Installing/Loading extensions - async-workloads" and "async-workloads-buildhooks onBuild completed in 4ms". It writes nothing to .netlify/functions-internal.
- `netlify api createSiteBuild` returned Not Found (the site has no Git repo, so no remote build is possible).
- MCP get-full-extension-details: installedOnTeam=true, sdkVersion 3.0.0, scopes site:write, site:read, env:read, env:write, env:delete, user:read.

## DOCS (https://docs.netlify.com/build/async-workloads/...)

- get-started/ and writing-workloads/: `asyncWorkloadFn(handler)` plus exported `asyncWorkloadConfig = { events: [...], eventFilter, maxRetries, backoffSchedule }`. The event has `eventName, eventId, eventData, attempt` (0 on the first run), `step.run(id, cb)` and `step.sleep(id, duration)`.
- Retries: default maxRetries is 4, so 5 attempts total. Default backoff is 5 s, 20 s, 1m20s, 8 min. The maximum backoff is 1 week. `ErrorDoNotRetry` and `ErrorRetryAfterDelay` exist.
- sending-events/: `new AsyncWorkloadsClient().send(name, {data, delayUntil, priority})` returns `{eventId, sendStatus}`. `delayUntil` can be at most 1 year ahead. There is also an HTTP router API at `/.netlify/functions/async-workloads-router` with a Bearer AWL_API_KEY header. Priority applies only to delayed events.
- multi-step-workloads/: the whole workload re-invokes after every new step, so code outside steps re-runs. Completed steps resolve from stored results and are not re-run.
- lifecycle/: dead letters are kept 30 days and visible in Blobs under `async-workloads-state-dead-lettered/*`. Retry and delete go through `/.netlify/functions/async-workloads-api/failed-events` and `/events`.
- optional-configuration/: the scheduler polls every 60 s by default (minimum 10 s, maximum 900 s), set with AWL_SCHEDULER_INTERVAL. Delayed events, retries and sleeps therefore likely carry up to about 60 s of lateness (inference from the docs, not measured). Non-production contexts run the scheduler only on stateful actions. Standard functions use a 60 s timeout (AWL_SERVERLESS_TIMEOUT). Background functions use 15 minutes.
- limitations/: keep payloads under 500 KB. Do not set `path` or `schedule` on a workload function.
- Docs say the extension's use of functions and Blobs is billed like other provisioned resources (overview/). No separate price figure was found.

## Code

Code is in this directory:

- lib/db.mjs, lib/handler.mjs: workload cases lat, conc, delay, retry-once, retry-always, sleep, multistep, db, dual, long.
- netlify/functions/wl-main.mjs, wl-long-background.mjs, send.mjs (a sync sender at /api/send).
- dbadmin.mjs: schema up/down.

## Unblock options (owner decision)

1. Create a throwaway private Git repo, link it to fw-probe-jobs-9651 (Project configuration -> Build & deploy -> Continuous deployment -> Link repository), and push this directory. The Netlify build then injects the router. I did not do this because it creates an external repo outside what was approved.
2. Use `netlify dev` for a local-only semantic check. This is not representative of hosted latency, so I did not do it.

## Dashboard URLs

- Deploys: https://app.netlify.com/projects/fw-probe-jobs-9651/deploys
- Function logs: https://app.netlify.com/projects/fw-probe-jobs-9651/logs/functions
- Blobs: https://app.netlify.com/projects/fw-probe-jobs-9651/storage (path not verified; I did not open a browser)

## Cleanup proof

- `DROP SCHEMA lab_naw CASCADE`, then `select nspname ... like 'lab_naw%'` returned 0 rows (printed "remaining lab_naw schemas: 0").
- Site env var PROBE_DB_URL removed. `netlify env:list` now shows only AWL_API_KEY, which came from the extension's team-level key. I left it, because deleting it would be changing the extension's config.
- Site redeployed without secrets. No local processes of mine are running.
- Site kept, extension still installed.

## Reminder

The owner should uninstall the extension at Team settings -> Extensions -> Async Workloads -> "Uninstall this extension", then watch the next `familiarise` deploy. I did not touch that site.
