# Lab: pg-boss drain mode from short functions, and Cloudflare Workers TLS to Supabase

Date 2026-10-31. Labels: MEASURED = observed in this lab; DOCS = from the cited page.
Shared Supabase DB (project reference redacted, Mumbai pooler). No repo changes.

## Versions

node 26.9.0, pg-boss 12.38.0, pg 8.23.1, postgres (postgres.js) 4.0.0, pg-cloudflare 1.4.1, wrangler 4.156.0, vercel CLI 65.9.0. pg-boss schema version 46 (MEASURED).
Code is in this directory: `lib/drain.mjs` (drain), `bench.mjs`, `abandon2.mjs`, `conc1.mjs`, `txsend.mjs`, `vercel-app/api/drain.mjs`, `cf/src/index.js`, `cf/wrangler.jsonc`.

## Part 1: pg-boss drain mode

### Drain function (lib/drain.mjs, core)

Lab only, not production guidance: `rejectUnauthorized: false` below turns off server-certificate verification against a mock database. Production code must keep verification on, with the Supabase CA.

```js
const boss = new PgBoss({
  connectionString,
  ssl: { rejectUnauthorized: false },
  schema: "lab_pgdrain",
  max: 2,
  supervise: false,
  schedule: false,
  registerInstance: false,
});
await boss.start();
while (elapsed < 20_000) {
  const jobs = await boss.fetch(QUEUE, { batchSize: 10 });
  if (!jobs.length) break;
  /* process */ await boss.complete(
    QUEUE,
    jobs.map((j) => j.id),
  ); // boss.fail(...) on error
}
await boss.stop({ graceful: false });
```

Option names (DOCS https://pgboss.io/api/constructor): `supervise:false` skips "flows, maintenance, and monitoring" on this instance; `schedule:false` stops it monitoring/creating scheduled jobs; `migrate:false` skips migrations on start; `registerInstance:false` is recommended for "short-lived processes such as serverless functions" because each start would otherwise register an instance row. `max` default is 10 (set 2). `fetch(name,{batchSize,includeMetadata})` per package types (dist/types.d.ts). fetch uses `FOR UPDATE OF j SKIP LOCKED` (MEASURED in dist/plans.js).
Works through both the session pooler (5432) and the transaction pooler (6543); no LISTEN/NOTIFY is used by fetch (LISTEN needs a session-pinned connection only for work(); DOCS constructor page).

### Results (200 jobs, batch 10, no-op handler, run from the laptop, about 40 ms RTT to Mumbai)

| Run                  | start()    | fetch avg | complete avg | per job     | total     |
| -------------------- | ---------- | --------- | ------------ | ----------- | --------- |
| session 5432, 3 runs | 435-522 ms | 41-52 ms  | 40-48 ms     | 8.3-10.3 ms | 2.1-2.6 s |
| txn 6543, 2 runs     | 416-558 ms | 43-68 ms  | 44-60 ms     | 8.9-13.1 ms | 2.2-3.2 s |
| session, batch 50    | 521 ms     | 57 ms     | 54 ms        | 2.5 ms      | 1.0 s     |

First-ever start() (installs schema, version 46): 1595 ms (MEASURED). Per-job overhead is dominated by round trips: two statements per batch (fetch, complete), so bigger batches amortise it.

### Abandoned (fetched, process exited before complete) jobs (MEASURED, abandon2.mjs)

Queue created with `expireInSeconds:15, retryLimit:3, retryDelay:0`. A process fetched 5 jobs and exited. A fresh "tick" (new instance: start, `supervise(queue)`, fetch, stop) ran every ~6 s:

| monitorIntervalSeconds | redelivered at                                              | retryCount |
| ---------------------- | ----------------------------------------------------------- | ---------- |
| 5                      | t+18.7 s (tick 4: first tick after the 15 s expiry)         | 1          |
| 60 (default)           | t+59.4 s (tick 11: first tick after the 60 s monitor claim) | 1          |

Findings:

- Plain `fetch()` NEVER redelivers an expired active job. With `supervise:false` and no supervise call, after 37 s the 5 jobs were still `active`, and also 45 s later in the table (MEASURED).
- Redelivery needs `boss.supervise()`, whose expiry step only runs when the per-queue monitor claim is due (`monitorIntervalSeconds`, default 60; DOCS https://pgboss.io/api/constructor, code in dist/boss.js `#monitor`/`trySetQueueMonitorTime`). So redelivery latency = max(`expireInSeconds`, `monitorIntervalSeconds`) rounded up to the next tick.
- `expireInSeconds` default is 15 min (dist/plans.js QUEUE_DEFAULTS), so with defaults an abandoned job comes back after about 15 min. Per-job `heartbeatSeconds` (>=10, workers must `touch()`) also exists (DOCS types.d.ts / https://pgboss.io/api/ops); not tested here, and pointless for sub-20 s handlers: just set `expireInSeconds` slightly above the handler budget.

### Two concurrent drains (MEASURED, 3 processes, 600 jobs)

Processed 600, unique 600, duplicates 0 (210/210/180 per process). All 600 ended `completed`. SKIP LOCKED holds.

### send with the `db` option inside the business transaction (MEASURED, txsend.mjs)

Adapter `{executeSql:(text,values)=>client.query(text,values)}` passed as `send(queue,data,{db})`, inside `begin ... commit`: the job exists after commit, and a rolled-back transaction leaves no job (a drain afterwards processed exactly 1 job). Same on 5432 and 6543. Drain-only instances (supervise/schedule off) are unaffected: sending needs no maintenance.

### Real serverless: Vercel function, bom1, Node, `fw-lab-pgdrain` (MEASURED; invoked via `vercel curl` because Vercel Authentication protects the URL)

Each invocation seeds 100 jobs then drains them (batch 10).

| #   | cold | start() | seed 100 | drain  | jobs | per job | fetch avg | complete avg | supervise             | total  |
| --- | ---- | ------- | -------- | ------ | ---- | ------- | --------- | ------------ | --------------------- | ------ |
| 1   | yes  | 115 ms  | 139 ms   | 188 ms | 100  | 1.9 ms  | 10.9      | 6.9          | -                     | 459 ms |
| 2   | no   | 17      | 27       | 85     | 100  | 0.8     | 4.2       | 3.8          | -                     | 140    |
| 3   | no   | 23      | 23       | 90     | 100  | 0.9     | 4.6       | 3.9          | -                     | 147    |
| 4   | no   | 19      | 19       | 82     | 100  | 0.8     | 4.5       | 3.2          | 249 ms (claim due)    | 380    |
| 5   | yes  | 54      | 27       | 119    | 100  | 1.2     | 6.4       | 4.9          | 34 ms (claim not due) | 250    |

Extra: 2000 jobs in one invocation (warm): drain 3494 ms, 200 batches, 1.7 ms/job, total 3.8 s, far below the 20 s budget. Transaction pooler (6543): start 30 ms, drain 100 jobs 186 ms, supervise 28 ms.

Local vs Vercel: start() 430-520 ms local vs 17-115 ms in bom1; per job 8-10 ms vs 0.8-1.9 ms. Region proximity, not pg-boss, is the cost. Estimated capacity per 20 s tick at 1.7 ms/job: about 10,000 jobs (extrapolated from the 2000-job run, not measured).

### What drain mode loses, and the maintenance tick (MEASURED + DOCS)

Lost with `supervise:false, schedule:false`: pg-boss cron (the ticker must be the scheduler), expiry/retry of abandoned jobs, archive/delete of completed jobs (maintenance, default daily; DOCS constructor `maintenanceIntervalSeconds`), queue stats/monitoring and warnings (backlog, slow query), and `work()` push/notify.
Current API for the same tick: `await boss.supervise(queueName?)` (DOCS https://pgboss.io/api/ops: "runs one maintenance pass immediately... call it directly when you have set supervise:false and drive maintenance yourself"). It is claim-gated, so calling it every tick is cheap and several concurrent callers do not duplicate work. Cost: 28-34 ms when nothing is due, 249-564 ms when the monitor/maintain claim is due (cloud 249 ms; laptop 270-560 ms). Tick recipe: start, supervise(), drain, stop.
Caveat: `supervise()` also runs the instance-table maintenance and reindex tail (code in dist/boss.js); leave `registerInstance:false`.

## Part 2: Cloudflare Workers TLS to Supabase

Worker `fw-lab-tls`, `placement.region = "aws:ap-south-1"`, nodejs_compat, Free plan, plan untouched. Supabase pooler certificate chain (MEASURED with openssl): leaf `*.pooler.supabase.com` -> Supabase Intermediate 2021 CA -> Supabase Root 2021 CA (private CA, openssl verifies it with `prod-ca-2021.crt` from https://supabase.com/docs/guides/platform/ssl-enforcement, file https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt, sha256 80:70:25:AD:...:CA:FA). The direct host `db.<ref>.supabase.co` is IPv6-only (AAAA only, no A record; MEASURED with dig).

| Variant                                                                        | Result | Exact error                                                                                                                                                                                                                                        | Verified?                     |
| ------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| (a) pg, `ssl:{rejectUnauthorized:true, servername}` -> session pooler          | FAIL   | `Connection terminated unexpectedly` (14 ms)                                                                                                                                                                                                       | n/a                           |
| (a2) pg + `ca: <Supabase root>`                                                | FAIL   | same                                                                                                                                                                                                                                               | n/a, `ca` is not honored      |
| (a3) pg, direct host, + ca                                                     | FAIL   | same                                                                                                                                                                                                                                               | n/a                           |
| (a4) pg, `rejectUnauthorized:false`                                            | FAIL   | same                                                                                                                                                                                                                                               | n/a, cannot skip verification |
| (b) postgres.js `ssl:'require'`                                                | FAIL   | `TLS_HANDSHAKE_FAILED: The TLS connection to aws-0-ap-south-1.pooler.supabase.com:5432 was lost before the server answered. Workers could not complete the TLS handshake, most often because the server certificate is not trusted by a public CA` | n/a                           |
| (b2) postgres.js verify with `ca` / `servername`                               | FAIL   | same TLS_HANDSHAKE_FAILED                                                                                                                                                                                                                          | n/a                           |
| (c) Hyperdrive -> direct `db.<ref>.supabase.co:5432`, `verify-full`, custom CA | WORKS  | -                                                                                                                                                                                                                                                  | YES (below)                   |
| (c2) Hyperdrive -> session pooler 5432, `verify-full`, custom CA               | WORKS  | -                                                                                                                                                                                                                                                  | YES                           |
| baseline: pg, TLS off (earlier lab)                                            | works  | -                                                                                                                                                                                                                                                  | no encryption                 |

Root cause (MEASURED + DOCS): a Worker's own TLS stack (`startTls`, used by both pg via pg-cloudflare and postgres.js) trusts public CAs only, takes no custom CA, and has no skip-verify mode; the Supabase certificate chains to a private CA, so the handshake dies. This is the earlier hang/1101. It cannot be fixed in driver options (a)/(b). Cloudflare's TCP sockets page: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ . Supabase SSL page: https://supabase.com/docs/guides/platform/ssl-enforcement .
Hyperdrive fix (DOCS https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/ and changelog https://developers.cloudflare.com/changelog/post/2025-04-09-hyperdrive-custom-certificate-support/): `wrangler cert upload certificate-authority --ca-cert prod-ca-2021.crt --name ...` then `wrangler hyperdrive create ... --ca-certificate-id <id> --sslmode verify-full`. Supabase guidance to use the Direct connection: https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/ . The Worker then uses plain `new Client({connectionString: env.HD.connectionString})` with pg >= 8.16.3.

Certificate verification proof (MEASURED): creating the same direct-host config with a wrong CA (ISRG Root X1) was rejected: `Failed to connect to the provided database: TLS handshake failed: cert verification failed - self signed certificate in certificate chain [CERTIFICATE_VERIFY_FAILED] [code: 2015]`; with the Supabase Root 2021 CA it was accepted. Hyperdrive (direct) also reached the IPv6-only host. `pg_stat_ssl` on the direct path showed `ssl=true TLSv1.3 TLS_AES_256_GCM_SHA384`. On the pooler path `pg_stat_ssl` shows false because Supavisor terminates TLS and the last hop to Postgres is internal; the Hyperdrive-to-pooler leg is still verify-full.
Note: the Worker-to-Hyperdrive hop is not TLS-to-DB; the TLS-protected leg is Hyperdrive-to-Supabase.

Performance (MEASURED, caching disabled on the configs, Worker in aws:ap-south-1, 50x SELECT 1 per run):

| Variant                                              | connect  | SELECT 1 median / p95          | 10-round-trip lock hold (begin, FOR UPDATE, 10 updates, commit; 14 statements incl. DDL-if-not-exists) |
| ---------------------------------------------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| (c) Hyperdrive direct, verify-full (5 runs)          | 3-4 ms   | 4 ms / 5-21 ms (typically 5-6) | 60-89 ms (first 89)                                                                                    |
| (c2) Hyperdrive session pooler, verify-full (2 runs) | 3-4 ms   | 4 ms / 5 ms                    | 68-73 ms                                                                                               |
| baseline pg TLS off, direct to pooler (4 runs)       | 11-42 ms | 2 ms / 3 ms                    | 37-159 ms (typically 40)                                                                               |

Hyperdrive costs about +2 ms per round trip over the unencrypted baseline, but its connect is 3-4 ms because the real connection is pooled. A Worker-to-DB path with certificate verification therefore exists, but only via Hyperdrive. Its interaction with transaction-heavy locking (Hyperdrive holds a connection per transaction) was fine for the 14-statement transaction tested.

## Verdicts

- pg-boss drain mode from short functions: WORKS. 0 duplicates over 600 jobs and 3 concurrent drainers; about 1-2 ms/job from bom1; 2000 jobs in 3.8 s. Requirements: (1) call `boss.supervise()` once per tick or abandoned jobs are never redelivered (fetch alone does not); (2) set `expireInSeconds` just above the handler budget and `monitorIntervalSeconds` near the tick period (redelivery latency = max of the two, rounded up to the next tick); (3) `registerInstance:false`; (4) pg-boss cron is not available, the ticker is the scheduler. `send({db})` in the business transaction works.
- Cloudflare TLS: direct Worker TLS to Supabase is IMPOSSIBLE with pg or postgres.js (private CA, no custom CA or skip-verify in Workers). Hyperdrive with the Supabase Root 2021 CA and `verify-full` works against both the direct host and the session pooler, and verification is proven by the negative test. Production-safe Cloudflare numbers are the Hyperdrive rows above, not the TLS-off baseline.

## Cleanup proof (MEASURED)

- `wrangler delete --name fw-lab-tls`: "Successfully deleted fw-lab-tls"; `https://fw-lab-tls.fw-lab-cloudflare.workers.dev/` now returns 404; `wrangler versions list --name fw-lab-tls` errors (script not found). wrangler 4.156 has no Worker list command; no other `fw-lab-tls`/`fw-lab-*` script was created by this lab.
- `wrangler hyperdrive delete` for both configs, then `wrangler hyperdrive list` returned an empty table. Both uploaded CA certs deleted; `wrangler cert list` shows 0 entries.
- Vercel: `fw-lab-pgdrain` project kept (up to 48 h); env vars DATABASE_URL and DIRECT_URL removed (`vercel env ls production` count 0); local `.env.local` removed. Vercel applies environment-variable changes only to new deployments, so the retained deployment was built with those variables and may still hold them. Cleanup is not complete until the project is deleted (`vercel project rm fw-lab-pgdrain --scope kaustav-ghoshs-projects`) or the database password is rotated; both are open owner actions.
- `drop schema lab_cftls cascade; drop schema lab_pgdrain cascade;` then `select nspname from pg_namespace where nspname in ('lab_cftls','lab_pgdrain')` returned `[]` (0 rows).
- Temp file /tmp/direct_url.txt holds a DB URL: removed below.
