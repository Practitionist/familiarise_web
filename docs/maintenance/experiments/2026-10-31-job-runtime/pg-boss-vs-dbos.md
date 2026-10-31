# pg-boss vs DBOS Transact: local experiment (2026-10-31)

Versions: pg-boss 12.38.0, @pg-boss/dashboard 1.13.0, @dbos-inc/dbos-sdk 5.4.0, pg 8.23.1, Postgres 16.15 (local, port 54329), Node v26.9.0, PgBouncer 1.26.1.
Everything ran on Node 26 without install problems. DBOS emits a pg deprecation warning ("client.query() while already executing").
Code: `boss.mjs` and `dbos.mjs` in this directory (modes `worker`, `send <delayed|immed|crash|conc|tx>`). Databases `boss` and `dbos`, each with `booking`, `side_effect` and `events` tables. Raw logs: `bossA.out`, `dbosA.out`, `pgb.log`, `dash.out`. Cron schedule was `* * * * *`; two worker processes A and B per library.
Laptop-local: no network latency, so all latencies are best-case.

**Q10 (Supabase pooler test)** was not run by the original experiment, whose rules forbade connecting to any remote database. The main session ran it afterwards with the user's approval; the results are in the last section of this report.

## 1. Cron with two workers (every minute)

- pg-boss (`boss.schedule`, both workers call it, 7 min observed): exactly one job per minute, alternating winners.

```
15:23 B | 15:24 B | 15:25 B | 15:26 B | 15:27 A | 15:28 A | 15:29 A   (count=1 each)
```

- DBOS (`DBOS.applySchedules`, both workers): exactly one workflow per minute, id `sched-every-minute-<ISO minute>` (a primary key, so dedupe is structural). 15:27..15:32 all count 1 (winners A,B,A,A,B...).
  - Caveat: my first minute shows 2 rows (09:55 and 09:56 UTC). That was a catch-up backlog from my own app-version mistake (see footguns), not a double fire.
- Verdict: both fire exactly once per minute in steady state with 2 workers on local Postgres. This is steady-state behaviour only: on Supabase (Q10 below) pg-boss fired a second job 30 s after `schedule()` in the first minute in 2 of 2 runs, so handlers must stay idempotent.

## 2. Delayed job (30 s)

- pg-boss `startAfter: Date`, 4 runs, lateness: 11, 1422, 128, 907 ms (polling, default 2 s interval, so up to ~2 s).
- DBOS `delaySeconds: 30` via DBOSClient.enqueue: lateness 461 ms (one clean run; the polluted runs were discarded).
- Verdict: both fire within about 2 s of target; neither fires early.

## 3. Transactional enqueue

- pg-boss: `boss.send(name, data, { db: { executeSql: (t, v) => client.query(t, v) } })` on a caller-owned client.

```
ROLLBACK send returned id e30e75b0..   after rollback jobs found: 0 []
COMMIT   send returned id 279e7c88..   after commit   jobs found: 1
```

- DBOS: `DBOSClient.enqueueInTransaction(pgClient, opts, ...args)`, which requires the business table to be in the same database as the DBOS system DB.

```
ROLLBACK workflow rows: 0 []
COMMIT workflow rows: 1 [{"workflow_uuid":"tx-commit","status":"ENQUEUED"}]
```

- Verdict: both supported and correct. Both also worked through PgBouncer transaction mode (Q8).

## 4. Crash recovery (3 steps, step 2 sleeps 20 s, kill -9 during step 2)

- pg-boss (no steps; whole job reruns). Queue `crash_q` with `heartbeatSeconds=10`, `crash_q2` with `expireInSeconds=45` and no heartbeat. Killed 15:31:00, worker restarted at 15:31:06.
  - Both jobs restarted at 15:32:05, about 65 s after the kill. The 60 s monitor interval is the floor for both modes (heartbeat 10 did not recover faster than expire 45).
  - Default `expireInSeconds` is 900 s, so with no heartbeat or expiry config recovery would take about 15 min (not run; from source defaults).
  - Step 1 side effect ran twice per job:

```
step1:1ba7e0c3 | pid 49171 | 15:30:54.615
step1:1ba7e0c3 | pid 49219 | 15:32:05.192   (same for c1c89439)
```

- DBOS: killed at 15:32:22 (during step2), both workers restarted. Executor B ran "Recovering 1 workflows from application version v1" and resumed on launch.
  - step 1 was not rerun (side_effect has 1 row: `step1:crash-1 | pid 48310`). Step 2 restarted 15:32:25 and completed, step 3 ran once.
  - Recovery was about 3 s from restart. It only happens when the same executor id (`DBOS__VMID`) restarts; no other live executor recovered it.
- Verdict: DBOS gives step-level exactly-once-ish checkpointing and fast recovery on restart; pg-boss reruns everything after about 60 s, so jobs must be idempotent.

## 5. Concurrency (20 jobs, each 2 s, limit 2, two workers)

- pg-boss `localConcurrency: 2`: max parallelism 4 (it is per process), span 10.05 s.
- DBOS queue `concurrency: 2` (global across workers): max parallelism 2, span 21.67 s.
- Verdict: DBOS enforces the limit globally. pg-boss does not (per-node). pg-boss has `groupConcurrency` (DB-tracked global) and singleton queue policies, which I did not test.

## 6. Connections (per idle worker, app-name filtered)

- pg-boss (pool max 10, no LISTEN): idle 3-5 per worker (A 5, B 3); under load A 5, B 3 (pool grows lazily). With `useListenNotify` there is one more dedicated connection.
- DBOS (pool size 10): idle 3 to 4 per worker (A: 3 idle + 1 "idle in transaction"; B: 3 idle). Under load A 4, B 3.
- Verdict: both are small, 3-5 per worker. Note DBOS's persistent "idle in transaction" connection; `idle_in_transaction_session_timeout` is a hazard (the client defaults to 60 s).

## 7. Poll vs notify, enqueue-to-start latency (20 immediate jobs, 1.5 s apart)

- pg-boss polling (default): median 964-1020 ms, min 293-414, max 1878-1958 ms.
- pg-boss LISTEN/NOTIFY: only works with BOTH `useListenNotify: true` on the instance AND `notify: true` per queue (via `updateQueue`). With only the instance flag, latency got worse (median 4.7 s). With both: median 7 ms. (21 rows, one stale leftover from the earlier run.)
- DBOS: polling for queues (minPollingIntervalMs 1000): median 203 ms, min 13, max 754 ms. LISTEN is used only for recv/events/notifications and has a startup self-test.
- Verdict: pg-boss defaults to polling, notify opt-in and fast; DBOS polls.

## 8. PgBouncer 1.26.1, `pool_mode = transaction` (brew install took under a minute)

- pg-boss through port 6432 (LN off): started, cron fired, 16-20 immed jobs processed (median 1079 ms for first), tx rollback/commit test passed. No pgbouncer errors. Docs say LISTEN/NOTIFY will not work through it (not tested here).
- DBOS through port 6432: launched. Printed "LISTEN/NOTIFY self-test failed ... transaction-mode pooler ... fall back to polling" and "Could not verify the existence of database dbos, continuing". Cron fired, tx test passed, 20 immed jobs median 503 ms, the workflow ran SUCCESS.
- Verdict: both work through a transaction pooler (with polling), subject to the single-pool sanity check. This is local PgBouncer only; the Supabase run is in the Q10 section.

## 9. UI

- pg-boss: `@pg-boss/dashboard` 1.13.0 started (`DATABASE_URL=... PORT=3456 node .../bin/cli.js`): "listening on http://127.0.0.1:3456". `curl /` returned HTTP 200, 54169 bytes, `<title>pg-boss Dashboard`, and the queues page lists `conc_q crash_q crash_q2 cron_q delayed_q immed_q`. Stopped afterwards. Also `api/queues` and `api/jobs` guesses returned 404 (the page is server rendered; I did not find a JSON API).
- DBOS: no UI without paid Conductor, but the system tables in schema `dbos` are queryable (13 tables: workflow_status, operation_outputs, workflow_schedules, queues, ...). Steps with outputs:

```
 workflow_uuid | wf      | status  | function_id | function_name | output                            | started      | completed
 crash-1       | crashWf | SUCCESS | 0           | step1         | {"json":null,...}                 | 15:32:15.732 | 15:32:15.74
 crash-1       | crashWf | SUCCESS | 1           | step2         | {"json":"two",...}                | 15:32:25.156 | 15:32:45.182
 crash-1       | crashWf | SUCCESS | 2           | step3         | {"json":"three",...}              | 15:32:45.184 | 15:32:45.185
```

Query: `select ... from dbos.workflow_status s join dbos.operation_outputs o using(workflow_uuid) where s.workflow_uuid='crash-1' order by o.function_id`.

## Summary table

| #                 | pg-boss 12.38                                                                 | DBOS 5.4                                                  |
| ----------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1 cron x2 workers | once/minute in steady state (7 min); first-minute duplicate on Supabase (Q10) | once/minute (6 min)                                       |
| 2 delayed 30 s    | 11-1422 ms late                                                               | 461 ms late                                               |
| 3 tx enqueue      | yes (`db` option), correct                                                    | yes (`enqueueInTransaction`), correct                     |
| 4 crash           | whole job reruns, side effect x2, about 65 s                                  | step 1 not rerun, side effect x1, about 3 s after restart |
| 5 concurrency 2   | 4 with two workers (per node)                                                 | 2 (global)                                                |
| 6 connections     | 3-5 per worker                                                                | 3-4 per worker (one idle in transaction)                  |
| 7 latency median  | about 1000 ms polling, 7 ms with notify                                       | 203 ms polling                                            |
| 8 PgBouncer txn   | works (no notify)                                                             | works, self-test falls back to polling                    |
| 9 UI              | official dashboard works                                                      | SQL only                                                  |
| 10 Supabase       | works on 6543 and 5432 (see Q10)                                              | works; pool 2 crashes, pool 10 is stable (see Q10)        |

## Surprises and footguns

- DBOS app versioning: a workflow enqueued by a client has no `appVersion`, so only a worker on the LATEST registered version dequeues it. I accidentally started a worker without `DBOS__APPVERSION`, which registered a hash version as latest; the `v1` workers then logged "Current version 'v1' is not the latest" and nothing ran (cron rows stayed ENQUEUED) until I deleted the stray `dbos.application_versions` row. Pin the version in deploys, or rolling deploys can strand work.
- DBOS: `registerQueue` must come after `launch()`; `concurrency` must be >= `workerConcurrency`; recovery only for the same executor id.
- pg-boss: global `useListenNotify` is not enough; each queue needs `notify: true`. Without it, latency got worse.
- pg-boss recovery has a 60 s monitor floor, regardless of heartbeat or expire settings.
- pg-boss concurrency is per process; two replicas double it.
- BSD sed on macOS: `sed -i ''`.

## Cleanup

All node processes, the dashboard, pgbouncer and Postgres (`pg_ctl stop`) are stopped; `ps` shows none of them. No git commits, nothing outside this directory touched.

## Q10 — Supabase pooler (run by the main session on 2026-10-31, user-approved, shared DB)

Script: `q10.mjs`. Hosts `aws-0-ap-south-1.pooler.supabase.com` port 6543 (transaction) and 5432 (session). Schemas `lab_pgboss`, `lab_dbos`, `lab_biz` only.

| Check                                       | pg-boss 6543                                       | pg-boss 5432                             | DBOS 6543                                   | DBOS 5432     |
| ------------------------------------------- | -------------------------------------------------- | ---------------------------------------- | ------------------------------------------- | ------------- |
| Install / migrate                           | OK                                                 | OK                                       | OK                                          | OK            |
| 10 jobs, enqueue→start median (p95), laptop | 472 (569) ms                                       | 307 (562) ms                             | 845 (1105) ms                               | 725 (1058) ms |
| Tx enqueue rollback → 0, commit → 1         | pass                                               | pass                                     | pass                                        | pass          |
| Every-minute cron                           | 3 jobs in ~2 min: 10:11:01, **10:11:31**, 10:12:31 | 3 jobs: 10:13:56, **10:14:26**, 10:15:26 | fired at +71 s and +129 s (once per minute) | not run       |
| LISTEN/NOTIFY                               | not enabled                                        | not enabled                              | self-test failed → polling                  | worked        |

Findings:

- pg-boss fired a second job 30 s after the first in the first minute after `schedule()` was created, in 2 of 2 runs, on both poolers. Steady state afterwards was once per minute. The cause was not determined (DB vs laptop clock skew measured at 80 ms, so not skew). Handlers must stay idempotent.
- DBOS with `systemDatabasePoolSize: 2` crashed on both poolers: "terminating connection due to idle-in-transaction timeout", then a pool connect timeout in `registerQueue`. DBOS holds an advisory-lock transaction with a 5 s idle timeout (`BACKGROUND_JOB_LOCK_IDLE_TIMEOUT_MS`), and a 2-connection pool starves it. With the default pool of 10 it was stable.
- Laptop → pooler `SELECT 1`: median 39.6 ms (6543) and 39.3 ms (5432); connect 174 / 164 ms. Laptop only, not representative of a Mumbai worker.

Cleanup: `remaining lab_ schemas: 0 []`, no lab connections in pg_stat_activity, no lab processes.
