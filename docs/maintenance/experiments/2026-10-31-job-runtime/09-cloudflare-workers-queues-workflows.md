# Cloudflare Workers, Queues, Cron Triggers and Workflows to Supabase Mumbai (2026-10-31)

Labels: MEASURED = observed in this lab. DOCS = from the cited Cloudflare page. Plan: **Workers Free** (not changed). Code and raw data were kept in the job's scratch folder `lab-cloudflare/` (`src/probe.js`, `src/jobs.js`, `cfg/*.toml`, `results/*`).

## Headline

- **Best per-statement latency to Mumbai: 2–3 ms median (p95 3–4 ms) per `SELECT 1`**, with placement `region = "aws:ap-south-1"` and a direct connection to the 6543 pooler; the response carried `cf-placement: remote-BOM`. MEASURED.
- **Smart Placement never moved the Worker.** It stayed `local-MRS` (the laptop's Marseille entry point) at about 98 ms per statement after about 600 requests per Worker over 45 minutes; the API status stayed `INSUFFICIENT_INVOCATIONS`. DOCS say it needs traffic from multiple locations. MEASURED.
- **Queue consumers, cron handlers and Workflow steps ignore placement.** They ran in DFW, SEA, SJC, AMS, ORD, KIX, LAX, MAD, IAD, CDG and MRS at 125–266 ms per statement. DOCS: placement applies only to `fetch` handlers.
- **Workaround that worked:** the consumer, cron or workflow step calls a region-pinned Worker over a service binding. That hop ran in `remote-BOM` and finished connect plus 5 queries in 22–31 ms, including from a consumer in SEA whose own direct latency was 250 ms. MEASURED.
- **Plan:** Queues, Cron, Workflows and Hyperdrive all worked on Free. A deploy with `limits.cpu_ms` was rejected: `CPU limits are not supported for the Free plan ... [code: 100328]`.

## A. Workers to Postgres

Five invocations per variant from the laptop, which enters Cloudflare at Marseille. `request.cf.colo` shows the entry point; the `cf-placement` header shows where the code ran. All MEASURED.

| Variant                            | Ran in           | Connect (ms) | `SELECT 1` median / p95 (ms) | 20-query mix (ms) | Lock hold median (ms) |
| ---------------------------------- | ---------------- | ------------ | ---------------------------- | ----------------- | --------------------- |
| v1 default, direct                 | MRS              | 397–412      | 97–100 / 97–101              | 2,470–3,859       | 1,009–1,036           |
| v2 default + Hyperdrive            | MRS              | 4–8          | 134–136                      | 3,183–5,310       | 1,206–1,223           |
| v3 Smart, direct                   | `local-MRS`      | 406–436      | 97–99                        | 2,255–3,405       | 1,009–1,032           |
| v4 Smart + Hyperdrive              | `local-MRS`      | 3–5          | 134–135                      | 3,012–3,269       | 1,207–1,220           |
| **v5 `aws:ap-south-1`, direct**    | **`remote-BOM`** | 10–41        | **2–3 / 3–4**                | **336–439**       | 65–75                 |
| v6 `aws:ap-south-1` + Hyperdrive   | `remote-BOM`     | 2–6          | 4 / 5–7                      | 383–627           | **36–39**             |
| v7 `placement.host` (experimental) | `local-MRS`      | about 400    | not measured                 | not measured      | not measured          |

Notes:

- Cold and warm runs were indistinguishable within these ranges.
- Hyperdrive wins on connect time and lock hold (37 ms vs 67 ms in the same region), not on per-statement latency, and without a region hint it is worse than direct.
- Hyperdrive query caching was off for every number; with it on, `SELECT 1` showed 2 ms because the edge served it from cache.
- Hyperdrive pointed at the 5432 session pooler; the Hyperdrive Supabase docs recommend the true direct connection. This deviates from the docs.
- `pg` with TLS from Workers hung (error 1101), so the direct variants connected without TLS. Acceptable for mock data, not for production, and it makes the direct connect times slightly optimistic against the Vercel and Netlify baselines.

## B. Queues

Two queues plus dead-letter queue `fw-lab-dlq`. Latency = handler entry time minus the producer's send timestamp. All MEASURED.

| Test                                                      | Result                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Latency, `fw-lab-q-fast` (batch 1, 20 messages 3 s apart) | Median 404 ms, p95 4,153 ms. The first 6 took 2.3–4.6 s (ramp-up); the other 14 took 107–915 ms, median 175 ms. |
| Latency, `fw-lab-q` (batch 10, wait 5 s)                  | Median 4,046 ms, p95 5,739 ms, batches of 2; the 5 s batch timeout dominates.                                   |
| Consumer throws on attempt 1                              | Redelivered about 2.4 s later; the side-effect row was written twice, once per attempt.                         |
| Dead-letter queue (`max_retries = 2`)                     | Handler ran 3 times, then the message reached the DLQ about 21 s after send.                                    |
| Consumer sleeping 30 s                                    | One attempt, 31.2 s, no retry.                                                                                  |
| Consumer sleeping 300 s                                   | One attempt, 301.3 s, no redelivery while it ran, no duplicate side effects.                                    |
| Consumer CPU spin                                         | 3e8 iterations finished; 3e9 was killed on every attempt (3 starts, no end row), then went to the DLQ.          |
| Dual write (insert row, fail before `send`)               | Row exists, no message. Queues are not transactional with Postgres.                                             |
| Where consumers ran                                       | DFW, SJC, SEA; 229–250 ms per statement to the DB.                                                              |

On Free the HTTP CPU limit is documented as 10 ms but was not enforced that tightly: a 6e8-iteration spin (about 2.2 s) passed and 1e9 or more failed with error 1102. Do not rely on the slack.

## C. Cron Triggers

- First fire about 5 minutes after deploy (DOCS: up to 15 minutes).
- 13 fires in 13 consecutive minutes, no misses, no duplicates, exactly 60.0 s apart; the handler started 1.6–2.8 s after `scheduledTime` (median 2.3 s). MEASURED.
- Every fire ran in a different colo (AMS, ORD, KIX, LAX, MAD, SJC, IAD) at 147–266 ms per statement. MEASURED.
- After removal the API showed no schedules immediately, but fires continued for about 4 minutes, then stopped. MEASURED.

| Limit (DOCS, workers/platform/limits) | Free   | Paid                                                     |
| ------------------------------------- | ------ | -------------------------------------------------------- |
| Cron Triggers per account             | 5      | 250                                                      |
| CPU per invocation                    | 10 ms  | 30 s (interval under 1 hour) / 15 min (1 hour or longer) |
| Wall time per invocation              | 15 min | 15 min                                                   |

## D. Workflows

Five instances completed. All MEASURED unless marked.

- Per-step DB latency: 5-query median 125–174 ms; connect 392–601 ms.
- Step-to-step gap: 271–354 ms.
- A step that throws on attempt 1 was retried after about 2.3 s (configured 2 s); completed steps did not re-run.
- `step.sleep("10 seconds")`: 10.01 s, plus about 0.3 s before the next step.
- A 30 s step: 30.7 s, one attempt.
- Dual write: `create()` inside a transaction, then rollback: the row was gone, but the workflow was queued and later completed. Starting a Workflow is not transactional with Postgres; an outbox row is still needed.
- Steps ran in CDG and MRS, near the request that created the instance, not near the DB.
- State: DOCS describe a `jurisdiction` setting (instances "run and persist data" within it) and per-instance state limits, without naming a storage engine.

| Limit (DOCS, workflows/reference/limits and pricing) | Free            | Paid                                  |
| ---------------------------------------------------- | --------------- | ------------------------------------- |
| CPU per step                                         | 10 ms           | 30 s default, up to 5 min             |
| Wall time per step                                   | Unlimited       | Unlimited                             |
| Steps per Workflow                                   | 1,024           | 10,000                                |
| Concurrent instances                                 | 100             | 50,000                                |
| Step billing                                         | 3,000 steps/day | 500,000/month, then $0.80 per 100,000 |

## Other plan limits (DOCS)

- Workers: Free 100,000 requests/day; Paid 10 million/month included. HTTP CPU 10 ms on Free; 30 s default, up to 5 min on Paid. Subrequests 50 on Free, 10,000 on Paid. Cron, queue-consumer and alarm wall time 15 min on both.
- Queues: Free 10,000 operations/day and fixed 24 h retention; Paid 1 million operations/month then $0.40 per million, retention up to 14 days. Both allow 128 KB messages and 15 min consumer wall time; consumer CPU above 30 s is Paid only.
- Hyperdrive: Free 100,000 queries/day and about 20 origin connections per config; Paid unlimited queries and about 100 connections.

## Dashboards (deleted on 2026-10-31)

All Workers, Queues and the Workflow were deleted on 2026-10-31 at the owner's request, because the Workers were public with no auth. The URLs below now show empty lists.

- Workers: `https://dash.cloudflare.com/<account-id>/workers/services/view/<name>/production` (add `/observability/logs` or `/metrics`). Names: `fw-lab-jobs`, `fw-lab-v1-direct`, `fw-lab-v2-hd`, `fw-lab-v3-smart`, `fw-lab-v4-smart-hd`, `fw-lab-v5-region`, `fw-lab-v6-region-hd`, `fw-lab-v7-host`.
- Queues: `https://dash.cloudflare.com/<account-id>/workers/queues` (`fw-lab-q`, `fw-lab-q-fast`, `fw-lab-dlq`).
- Workflows: `https://dash.cloudflare.com/<account-id>/workers/workflows` → `fw-lab-wf`.
- Hyperdrive: `https://dash.cloudflare.com/<account-id>/workers/hyperdrive` (empty; the config held DB credentials and was deleted).
- Workers Logs enabled on all eight Workers via `[observability] enabled = true`.

## Cleanup proof

- Deleted on 2026-10-31 (owner request): 8 Workers, the `fw-lab-wf` Workflow and its instances, and 3 Queues (consumers removed first). `wrangler queues list` and `wrangler workflows list` show no `fw-lab` resources. The account-wide workers.dev subdomain `fw-lab-cloudflare` remains and can only be renamed in the dashboard.
- Every Worker shows `secrets: 0`; probe Workers carry only a `VARIANT` variable.
- Hyperdrive config `fw-lab-hd` deleted; 0 configs.
- Cron schedules empty; last fire 12:26:58Z, none after 12:29:32Z.
- `lab_cflock` dropped; the `lab_cf%` query returned 0 rows.
- No local processes; no connection URL or password in the lab folder; no repo changes.

## Caveats

- The kept Workers listed in this report (`fw-lab-*` other than `fw-lab-tls`, which a later report deleted) are public on workers.dev with no auth, including `/send` and `/wf/start`. They can no longer reach Postgres, but anyone with a URL can enqueue messages or start workflows against the Free quotas (failing into `fw-lab-dlq`).
- The first `wrangler deploy` on this account registered the account-wide workers.dev subdomain `fw-lab-cloudflare`; cleanup does not remove it.
