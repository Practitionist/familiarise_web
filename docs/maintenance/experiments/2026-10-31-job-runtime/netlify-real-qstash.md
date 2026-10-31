# Real QStash (EU) -> real Netlify function (Singapore) — 2026-10-31

Site: `fw-probe-jobs-9651` (https://fw-probe-jobs-9651.netlify.app), functions in Singapore, Node 26.9 local / Netlify Lambda.
Versions: @upstash/qstash 2.12.1, @upstash/workflow 1.5.0, pg ^8.23, netlify-cli 26.0.2. QStash EU base URL https://qstash-eu-central-1.upstash.io (paid plan, $20 budget, no prod pack; none changed).
Code: `netlify/functions/lab.mjs` (routes /api/receive, /api/long, /api/wf/wf3, /api/wf/wfsleep), drivers `t1.mjs`..`t4.mjs`, `ev.mjs`, `cnt.mjs`, `setup.mjs`, `db.mjs` in this directory. `receive` verifies the QStash signature (Receiver, current+next key) and inserts one row in `lab_nq.events` (kind, message id, `upstash-retried`, schedule id, publish ts, receive ts). Workflows use `serve()` from `@upstash/workflow/nextjs` (it verifies signatures itself). Laptop IP redacted; secrets never written to this report.
Caveats: clocks are laptop vs Lambda (NTP, skew assumed small, not measured). The QStash account is shared with another agent's runs on a Vercel app, so account-wide stats are not mine alone.

## 1. Delivery latency, 20 messages, EU QStash -> Netlify SG — MEASURED

Latency = Lambda receive time minus the laptop timestamp taken just before `publish()`. So it includes the publish API round trip (median 185 ms, min 178, max 717 for the publish call itself).

- All 20 delivered, 20 rows, 0 retries, HTTP 200 in the QStash log.
- **median 1366 ms, p95 2115 ms**, min 731, max 2801 (the max is the first message, likely a cold start).
- Raw ms: 2801,1340,1811,1268,1391,1414,1599,1063,1511,749,967,1276,1753,1894,1277,992,2115,1771,731,1261.
- Subtracting the ~185 ms publish call, queue-to-receive is roughly 1.2 s median (estimate).
- QStash's own log `duration` for the delivered request was e.g. 922 ms for the last one (receive handler includes a DB insert from Singapore).

## 2. 30 s function through real QStash — MEASURED

Function `/api/long` verifies signature, writes `long_start`, sleeps 30 s, writes `long_effect`, returns 200. Message `msg_7YoJxFpwkEy5zBp3mQhVntNr99...` published 11:32:11Z, default retries 3.

- What Netlify's edge returned: **HTTP 504 after about 30.1 s, body "Inactivity Timeout ... Too much time has passed without sending any data for document"**, headers `Server: Netlify`, `Cache-Status: "Netlify Edge"; fwd=miss`. It is the Netlify edge, not QStash and not the function. The QStash event shows `ERROR  HTTP status 504`, duration 30060 / 30498 / 30181 ms.
- The function was NOT killed: each attempt still wrote its `long_effect` row about 30.5 s after start.
- QStash retries (from the events API; timeline relative to publish):
  - +0.5 s ACTIVE -> +30.6 s ERROR 504 -> RETRY scheduled for +42.6 s
  - +43.3 s ACTIVE -> +73.8 s ERROR 504 -> RETRY scheduled for +233.8 s (gap ~160 s)
  - +234.5 s ACTIVE -> +264.7 s ERROR 504 -> RETRY scheduled for +2011.7 s (about 33 min)
  - So backoff is roughly 12 s, 160 s, 1747 s. I cancelled the message (DELETE /v2/messages, 202) before the fourth attempt, state CANCELED.
- **Side-effect rows: 3 completed `long_effect` writes (retried=0,1,2) for one message** — 3x duplication, proving the handler must be idempotent / must ack fast. (Direct unsigned curl to /api/long returned 500 in 1.7 s, no row.)

## 3. 30 s delay and per-minute schedule — MEASURED

Delayed messages (3, delay=30 s): lateness vs publish-timestamp + 30 s = **1.68 s, 2.05 s, 1.96 s** (includes ~0.2 s publish call and ~1 s delivery as in test 1).
Schedule `scd_4b5BfoQPhJUhRGWz6AF16t9ixENj`, cron `* * * * *`, created 11:34:21Z, observed ~3.5 min:

- fires at 11:35:01.25, 11:36:01.43, 11:37:00.87 — **1 per minute, 3 in 3 min, lateness after the minute boundary 1.25 s, 1.43 s, 0.87 s**.
- Deleted via MCP `qstash_manage_schedule delete` at ~11:37:45; afterwards GET `/v2/schedules/<id>` = 404 and GET `/v2/schedules` = `[]`.

## 4. Upstash Workflow on Netlify — MEASURED

`wf3`: three `context.run` steps. `wfsleep`: run, `context.sleep("nap","10s")`, run. Triggered via `@upstash/workflow` Client.trigger. Two rounds (first without my request counter, second with):

- **HTTP requests to Netlify per run: 4 for each workflow** (1 init + 3 steps; for wfsleep the sleep is itself one of the 4). Confirmed from `wf_http` rows: wf3=4, wfsleep=4.
- Workflow body executions: 8 per run (the body is replayed on every request); each step body ran exactly once (wf_step rows = 1 each). Top-level code outside `ctx.run` therefore runs N times.
- Run states in the Workflow log: all four runs `RUN_SUCCESS`, every step `STEP_SUCCESS` (init, then s1,s2,s3 / before,nap,after).
  - wf3: 9.6 s and 13.2 s end to end (3 trivial steps, about 2-3 s per hop).
  - wfsleep: 19.4 s and 21.8 s end to end (10 s sleep plus about 2 s per hop; the sleep step reports `sleepFor: 10`).
- Run ids: wfr_nq-wf3-1793446682306, wfr_nq-wfsleep-1793446682880, wfr_nq-wf3-1793446792494, wfr_nq-wfsleep-1793446793066.
- Note: workflow-internal messages do NOT appear in `/v2/events` (only the Workflow log shows them).

## Console and log URLs

Upstash console (EU QStash; I used the API/MCP, so these are the standard pages, not deep links I clicked): https://console.upstash.com/qstash (Logs, Schedules, DLQ tabs), https://console.upstash.com/qstash?tab=workflow (Workflow runs). Message ids and run ids above are the search keys. Schedules page is empty now (deleted). Messages in the console Logs: filter url `fw-probe-jobs-9651.netlify.app`.
Netlify function logs: https://app.netlify.com/projects/fw-probe-jobs-9651/logs/functions
Deploys: https://app.netlify.com/projects/fw-probe-jobs-9651/deploys

## Usage / cost — MEASURED (partial)

`/v2/stats` returned no billing series (`daily_billings` and month `daily_requests` empty), so no dollar figure is available; budget remained $20, DLQ 0. Account-wide today (includes the other agent's traffic) was 232 QStash messages and 30 workflow messages in the stats window. My own volume: 20 + 3 + 3 (retries) + ~3 delayed + 3 schedule fires + 8 workflow requests, roughly 40 billable messages, a few cents at most (DOCS: pay-as-you-go ~ $1 per 100k messages; not verified on the console).

## Cleanup proof

- `drop schema lab_nq cascade`, then `select nspname from pg_namespace where nspname like 'lab_nq%'` -> **0 rows**. Another schema, `lab_v2lock`, was left alone.
- My schedule deleted (404); `/v2/schedules` empty. The long message was cancelled; DLQ empty.
- All 6 env vars (QSTASH_URL, QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY, PROBE_DB_URL, WF_BASE_URL) removed: `netlify env:list` -> "No environment variables set ... production context". Site redeployed without secrets (endpoint now returns 500, as expected). Local `.secrets.env` deleted.
- Site `fw-probe-jobs-9651` kept; no other Netlify site, no repo files, no tokens/plan/budget/prod pack touched.
