# Netlify (Singapore) -> Supabase Mumbai latency, Inngest serve mode, QStash and Upstash Workflow on real Netlify

Date 2026-10-31. Versions: netlify-cli 26.0.2, function runtime node v24.22.2, laptop node v26.9.0, pg 8.x, inngest SDK 4.26.2 (`inngest/edge` adapter inside a Netlify Functions v2 handler), inngest-cli 1.49.0 dev server, @upstash/qstash 2.12.1, @upstash/workflow 1.5.0, qstash-cli dev server 2.40.12.
Code: <local-path> netlify.toml, trig.mjs. Raw data: results/, results2/, logs/.

## IMPORTANT deviations (read first)

1. **The first throwaway site was deleted before the "keep the site" instruction arrived.** Everything in Parts A, B, C was measured on that site (`fw-probe-jobs-27089`, now gone, deletion confirmed: getSite returns 404). To honour the 48-hour browse request I created a second site with the same code, `fw-probe-jobs-9651`, and re-ran Part A there (table A2). **The Inngest and QStash/Workflow evidence exists only as log excerpts in this report; those runs are not browsable in the Netlify dashboard.**
2. **Part C was run against the local QStash dev server (through an anonymous ssh tunnel), not the owner's real EU QStash.** The task originally said never to use the owner's real Upstash tokens; the reversal arrived only as a coordinator message, not from the owner, so I did not fetch or use real credentials. This report did not run the real QStash EU tests. They were run later and are in [netlify-real-qstash.md](./netlify-real-qstash.md).
3. Site regions: functions region was settable via API (`updateSite` body `functions_region: ap-southeast-1`) and confirmed by `AWS_REGION=ap-southeast-1` and `context.server.region` inside the function.

## Part A: raw Postgres latency, Netlify function (ap-southeast-1) -> Supabase ap-south-1, pooler :6543

Method: `pg.Client`, 1 connection, 50 sequential `SELECT 1`, 20-query read mix (Payment/Appointment/SystemJobExecution LIMIT 50 + 2 counts, cycling 5 queries), lock-hold = BEGIN; SELECT FOR UPDATE; 8 statements incl. CAS update `WHERE id=1 AND version=$v`; COMMIT, x10 (10 round trips). Column fixes: Payment status column is `paymentStatus`; Appointment has no status column, so its queries use `createdAt`.

A1 (site 27089, deleted), invoked from laptop with curl:

| #   | cold? | connect ms | SELECT 1 median / p95 ms | 20-query mix ms | lock hold median / p95 ms | fn total ms | client wall s |
| --- | ----- | ---------- | ------------------------ | --------------- | ------------------------- | ----------- | ------------- |
| 1   | cold  | 405        | 61.6 / 62.9              | 3426            | 678 / 691                 | 14169       | 15.5          |
| 2   | warm  | 386        | 63.4 / 63.6              | 2459            | 700 / 702                 | 13292       | 14.0          |
| 3   | warm  | 371        | 61.3 / 61.9              | 1508            | 676 / 816                 | 12105       | 12.8          |
| 4   | warm  | 381        | 62.7 / 63.1              | 1482            | 692 / 692                 | 12166       | 12.9          |
| 5   | warm  | 390        | 64.0 / 65.0              | 1450            | 707 / 711                 | 12378       | 13.0          |

A2 (site 9651, kept), same code:

| #   | cold? | connect ms | SELECT 1 median / p95 ms | 20-query mix ms | lock hold median / p95 ms | client wall s |
| --- | ----- | ---------- | ------------------------ | --------------- | ------------------------- | ------------- |
| 1   | cold  | 396        | 62.5 / 62.8              | 3686            | 689 / 700                 | 16.4          |
| 2   | warm  | 377        | 62.1 / 63.8              | 2763            | 685 / 693                 | 14.5          |
| 3   | warm  | 388        | 64.1 / 64.6              | 1639            | 706 / 707                 | 13.3          |

Comparison (per round trip): Netlify Singapore ~62-64 ms (the lock hold of 10 round trips is ~690 ms, 69 ms per trip) vs Trigger.dev eu-central-1 ~125 ms (hold 1258 ms), us-east-1 185 ms, laptop India 39.5 ms (hold 395 ms). The earlier extrapolation of 95 ms per statement for Netlify Singapore (Prisma level) was pessimistic for raw pg: 62 ms measured. Connect is ~380-400 ms (about 6 round trips); the cold-start overhead showed up mainly in the first 20-query mix (3.4-3.7 s vs 1.5 s warm, i.e. slower query planning/first-touch on the pooler connection), not in SELECT 1. The 20-query mix is 1.45 s when warm = ~70 ms per query. Note no non-determinism in p95: p95 within ~1-3 ms of median except one 816 ms lock hold.

## Part B: Inngest serve mode on Netlify (dev server on laptop calls the deployed function over the internet)

Setup: `inngest/edge` `serve()` wrapped in a Netlify Functions v2 default export (Request/Response); env `INNGEST_DEV=1` only (no signing key). Dev server: `npx inngest-cli@latest dev -u https://<site>.netlify.app/api/inngest --no-discovery --no-poll`. Footguns found:

- The dev server cannot sync a remote app by itself: it PUTs the site, and the SDK in dev mode tries to register with `127.0.0.1:8288` from inside Netlify (`ECONNREFUSED`, PUT returns 500). I had to do an in-band sync by hand (`PUT` with header `x-inngest-sync-kind: in_band` and body `{url}`), then POST the returned function list to `localhost:8288/fn/register` with `appName`, `v`, `sdk`, `framework`.
- The dev server keeps PUT-polling the site every ~5 s even with `--no-poll`; each is a billable function invocation (`Duration` lines) and buries real logs.
- The deployed function cannot reach the dev server's checkpoint/side channel (localhost), so each request carried ~1.7 s of extra duration after the step body (6.7 s for a 5 s step) and checkpointing did NOT combine steps: one request per step.

1. Sweep (read 50 Payment rows; then 5 per-row reads), run Completed. Netlify log:

```
11:09:29.939 REQ> POST ?fnId=lab-netlify-sweep&stepId=step
11:09:30.487 [sweep] read-batch rows=50 connectMs=401 totalMs=536
11:09:32.204 REQ< POST ... status=206   (request lasted 2.27 s)
11:09:32.640 REQ> POST ... (2nd request)
11:09:33.431 [sweep] per-row rows=5 connectMs=389 totalMs=786
11:09:33.433 [sweep] DONE batch=50 perRow=5
```

Step durations: read-batch 536 ms (401 ms of it is connect), per-row 786 ms (389 connect + 5 reads ~79 ms each). 2 POSTs seen (a third finalizing POST/the response line of the second were not in the retrievable Netlify log; log retrieval dropped some lines). Run Completed in 6.6 s. 2. 30 s step (retries 2). Verdict: **edge returned 504 and Inngest retried; the step ran twice.**

```
11:11:51.474 REQ> POST (long30)           [long30] step start attempt=0
11:12:20.775 dev server: "invalid status code: 504"   (~29.3 s after the function received the request)
11:12:21.521 [long30] step END after 30s attempt=0 ; DONE   (function kept running to the end)
11:12:23.289 REQ< status=206  (response discarded)
11:12:47.435 REQ> POST  [long30] step start attempt=1     (retry 26.7 s after the 504; step re-executed from scratch)
11:13:18.158 run Completed (attempt 1 returned within the window; no second 504 logged)
```

Side effect ran twice. Attempt 1 completed without a logged 504 although it also lasted ~30 s: the cutoff is right at the boundary (see QStash below: 30.1 s passed, 31.3 s failed). 3. 10 x 5 s steps with default checkpointing (maxRuntime 10 s): **completed on Netlify, but with 10 requests** (one per step, each ~6.7 s, none near the limit), total ~71 s (11:11:50.4 -> 11:13:01.7). `ten5` log shows REQ> / t{n} start / t{n} end / REQ< status=206 for each n.

## Part C: QStash and Upstash Workflow (LOCAL dev server via ssh tunnel; not the real EU QStash)

The dev server was reached by the Netlify functions through an anonymous `ssh -R` tunnel (localhost.run) because Workflow and the dual-write need Netlify to call QStash. The default public dev-server token was used. Tunnel and servers stopped afterwards.

1. Publish to a function sleeping 30 s (default retries). Dev-server events:

```
11:18:20.925 ACTIVE  /api/qs-target
11:18:52.182 ERROR   504 "HTTP status 504", RETRY next=11:19:04.182   (31.3 s after dispatch)
11:19:04.891 ACTIVE  (retried=1)
11:19:35.023 DELIVERED 200                                           (30.1 s)
```

Netlify log: `QS-TARGET start retried=0` 11:18:22.4, `side-effect END retried=0` 11:18:52.4, `start retried=1` 11:19:05.0, `side-effect END retried=1` 11:19:35.0. **Side effect written twice.** The 504 body is Netlify's "Inactivity Timeout - Too much time has passed without sending any data"; the cutoff is between 30.1 s and 31.3 s here (not 26 s, which the repo's production site shows). 2. Delay 30 s: created 11:18:20.441, due 11:18:50.441, ACTIVE 11:18:50.741, delivered 11:18:51.525 (+0.3 s dispatch, +1.1 s to 200). Schedule `* * * * *` created 11:18:20: fired 11:19:00.27, 11:20:00.99, 11:20:...; 11:21:00.24, 11:22:00.97 = exactly 1 per minute, fire latency 0.24-0.99 s after the minute, delivered 0.1-0.9 s later. Schedule deleted (200). 3. Workflow (`@upstash/workflow/nextjs` serve inside a Netlify function; `WF_BASE_URL` set):

| Case                                     | Netlify requests         | Result                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3 steps (`wf3`)                          | 4 (one per step + final) | RUN_SUCCESS in 6.5 s                                                                                                                                                                                                                                                                                 |
| 30 s `context.run` (`wflong`, retries 0) | 1                        | **RUN_FAILED at 31.4 s**: step body ended at exactly 30.0 s but Netlify cut the request, no later request; with default retries the step would re-run (not tested)                                                                                                                                   |
| `context.sleep("10s")`                   | 3                        | RUN_SUCCESS 16.7 s; the wait costs no function time, resumed 10 s later                                                                                                                                                                                                                              |
| `context.call` to a 40 s URL             | 2 (+ the callee)         | QStash made the HTTP call, workflow request returned in 1.6 s; the **callee still hit the Netlify edge limit and the call result was `504 Inactivity Timeout`**, the workflow then continued ("WF wfcall after status=504"). So `context.call` offloads the caller's wait but not the callee's limit |

4. Dual write (insert row into `lab_nlock.dual_demo`, publish, injected failure between): `?fail=1` -> HTTP 500, `qs-hit` CREATED count stayed 5 -> 5 (no message), while the table query returned `[{id:804750459,note:"fail-case"},{id:761436432,note:"ok-case"}]`: **row committed with no message, the outbox case.** `?fail=0` -> HTTP 200 and CREATED 5 -> 6.
   Netlify log retrieval (`netlify logs --since ISO --until ISO --function X`) dropped some lines (e.g. several WFREQ< lines); the dev-server event and workflow-log APIs were used to cross-check.

## Not in this report

- Real QStash EU runs (tests 1 and 3 rerun and the 20-message publish-to-receive median). They are in [netlify-real-qstash.md](./netlify-real-qstash.md).

## Cleanup proof

```
DROP SCHEMA lab_nlock CASCADE
select nspname from pg_namespace where nspname like 'lab_%'  ->  []   (0 rows)
```

- Dev servers (inngest, qstash), the ssh tunnel and all lab processes stopped (ps count 0).
- First site fw-probe-jobs-27089: deleted ("successfully deleted", then getSite 404).
- Kept site `fw-probe-jobs-9651` (team Practitionist-Deploys, account slug teetangh, functions region ap-southeast-1): `PROBE_DB_URL` unset and the site redeployed so the live deploy holds no secrets; `netlify env:list` returns no variables. The db-probe now just returns an error. No QStash env vars exist on this site (they only existed on the deleted one).
- Dashboard URLs (kept site; logs there show only the Part A2 probes):
  - Overview: https://app.netlify.com/sites/fw-probe-jobs-9651/overview
  - Deploys: https://app.netlify.com/sites/fw-probe-jobs-9651/deploys
  - Function logs: https://app.netlify.com/sites/fw-probe-jobs-9651/logs/functions
- Remember to delete the kept site after the 48 hours: `netlify sites:delete <id>` (id in .siteid, not shown here).
- Reminder from the earlier Trigger.dev probe: the shared DB pooler password was passed through my environment only as a site env var, never printed.
