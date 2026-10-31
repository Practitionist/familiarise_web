# Vercel bom1 probe: Postgres latency, lock-hold, duration and cron limits

Date: 2026-10-31. Plan: Hobby (personal scope, no teams).

## Versions

- Vercel CLI 65.9.0
- Function runtime: Node v26.13.0 (project setting 26.x), `pg` ^8.13
- Region pinned with `"regions": ["bom1"]`. Every response returned `region: "bom1"` (from `process.env.VERCEL_REGION`).
- Target: Supabase Mumbai pooler, port 6543 (ap-south-1), `rejectUnauthorized:false`, one `pg.Client` per invocation.
- Laptop to Vercel was invoked with curl. The client wall time includes laptop to bom1 plus the function's own total.

## Code

`vercel.json`

```json
{
  "regions": ["bom1"],
  "functions": {
    "api/long.js": { "maxDuration": 300 },
    "api/db-probe.js": { "maxDuration": 60 }
  }
}
```

`api/db-probe.js` (condensed)

- connect, timed.
- 50 x `SELECT 1`, median and p95.
- 20-query mix (round robin of 5 queries): `SELECT id,"paymentStatus" FROM "Payment" ORDER BY "createdAt" DESC LIMIT 50`; `SELECT id,"createdAt" FROM "Appointment" ORDER BY "createdAt" DESC LIMIT 50`; `SELECT id,status FROM "SystemJobExecution" ORDER BY "createdAt" DESC LIMIT 50`; `count(*)` on `"Payment"` where `"paymentStatus"::text='SUCCEEDED'`; `count(*)` on `"SystemJobExecution"` where `status::text='SUCCEEDED'`. (`Payment` and `Appointment` have no `status` column; the first deploy errored on that and was fixed.)
- Lock-hold, 10 loops in schema `lab_vlock`, table `account(id int pk, balance bigint, version int)`: `BEGIN`, `SELECT ... WHERE id=1 FOR UPDATE`, then the clock starts. 8 statements follow: `SELECT 1`, count, select balance, CAS `UPDATE ... WHERE id=1 AND version=$1`, select version, `SELECT 1`, `now()`, select balance. Then `COMMIT`, then the clock stops. This is lock acquired to commit acknowledged, so it includes the COMMIT round trip.

`api/long.js`: `setTimeout(n*1000)` then returns JSON.

## Results (5 invocations, all HTTP 200, region bom1)

Run 1 followed a fresh deploy, so it is the cold start. Runs 2-5 were 3 s apart; the instance is reused under Fluid compute, so they are warm. The connection is opened per invocation, so connect time is not a warm-pool figure.

| #   | cold/warm | client wall | connect | SELECT 1 median / p95 | 20-query total | lock-hold median / p95 | fn total |
| --- | --------- | ----------- | ------- | --------------------- | -------------- | ---------------------- | -------- |
| 1   | cold      | 1.27 s      | 35.6 ms | 1.12 / 1.31 ms        | 506.6 ms       | 11.45 / 18.04 ms       | 849 ms   |
| 2   | warm      | 0.96 s      | 12.9 ms | 1.14 / 1.26 ms        | 377.9 ms       | 11.91 / 12.54 ms       | 602 ms   |
| 3   | warm      | 1.19 s      | 17.6 ms | 2.06 / 2.29 ms        | 334.1 ms       | 19.07 / 20.27 ms       | 698 ms   |
| 4   | warm      | 0.63 s      | 12.2 ms | 1.01 / 1.16 ms        | 304.6 ms       | 10.57 / 11.31 ms       | 499 ms   |
| 5   | warm      | 1.19 s      | 17.7 ms | 2.07 / 2.38 ms        | 395.5 ms       | 19.55 / 36.45 ms       | 820 ms   |

Summary:

- Region: bom1 (confirmed at runtime).
- Connect: 12-18 ms warm, 36 ms cold.
- `SELECT 1`: median 1.0-2.1 ms. It was bimodal (about 1.1 ms or about 2.1 ms per run), which looks like different pooler backends or instances.
- 20-query mix: 305-507 ms total (about 15-25 ms per query). The three `LIMIT 50` reads dominate; the `count(*)`s are slower than `SELECT 1` by a wide margin.
- Lock-hold with 8 statements plus COMMIT: median 10.6-19.6 ms, p95 11.3-36.5 ms. This matches roughly 10 round trips at 1.1 ms or 2.1 ms each, plus commit.
- The lock-hold figure is from a single connection with no contention, so it is the hold time, not the wait time.

The numbers are about 2 orders of magnitude below the cross-region figures that motivated the probe (about 95 ms per Prisma round trip from elsewhere). Prisma overhead is not included here; this is raw `pg`.

## Function duration limit (Hobby, Fluid compute, `maxDuration` 300 set in vercel.json)

| request | status                            | wall     |
| ------- | --------------------------------- | -------- |
| n=30    | 200                               | 30.47 s  |
| n=60    | 200                               | 60.18 s  |
| n=290   | 200                               | 290.17 s |
| n=310   | 504 `FUNCTION_INVOCATION_TIMEOUT` | 300.20 s |

Deploy with `maxDuration: 800` was rejected: `The value for maxDuration must be between 1 second and 300 seconds, in order to increase this limit upgrade your plan: https://vercel.com/pricing`.

Measured maximum on Hobby: 300 s (5 min).

Docs (https://vercel.com/docs/functions/limitations, section "Max duration", page last updated per fetch on 2026-10-31):

- "Hobby: 300s default and maximum. Pro and Enterprise: 300s default, 800s maximum, and 1800s extended maximum (Beta)."
- With Fluid compute enabled, Hobby is 300 s default and 300 s maximum. See also https://vercel.com/docs/functions/configuring-functions/duration.
- Hobby also pins to a single region by default; multiple regions are Pro/Enterprise only (same page, "Regions" row).

## Cron

Tested with `vercel deploy` (preview, so nothing could run):

- `*/5 * * * *` rejected at deploy: `Error: Hobby accounts are limited to daily cron jobs. This cron expression (*/5 * * * *) would run more than once per day. Upgrade to the Pro plan to unlock all Cron Jobs features on Vercel.`
- `0 3 * * *` (daily) accepted; deployment reached READY. It was a preview deploy, so no cron ran. No cron was ever on a production deployment.

Docs (https://vercel.com/docs/cron-jobs/usage-and-pricing, last_updated 2026-07-15):

| Plan       | Cron jobs per project | Minimum interval | Scheduling precision     |
| ---------- | --------------------- | ---------------- | ------------------------ |
| Hobby      | 100                   | once per day     | per-hour (up to +59 min) |
| Pro        | 100                   | once per minute  | per-minute               |
| Enterprise | 100                   | once per minute  | per-minute               |

- "Vercel cannot assure a timely cron job invocation. For example, a cron job configured as `0 1 * * *` will trigger anywhere between 1:00 am and 1:59 am."
- Cron invocations are ordinary function invocations, so function limits and pricing apply.

## Cleanup proof

- `DROP SCHEMA IF EXISTS lab_vlock CASCADE` ran. Then `select nspname from pg_namespace where nspname like 'lab_%'` returned 1 row, `lab_nlock`, not 0. That schema is not from this probe (the Netlify probe's naming); I did not touch it. Please drop it when that probe is done. `lab_vlock` is absent.
- `vercel env rm DATABASE_URL production --yes`: "Removed Environment Variable". (Vercel notes this does not revoke the credential.)
- `vercel project rm <throwaway-project> --yes`: "Deleted <throwaway-project>". `vercel project ls | grep -c lab-vercel-probe` returned 0.
- Local `.vercel/`, `.env.local`, `node_modules/` and temp result files were removed. No background processes are left. The familiarise_web repo was not modified and nothing was committed.
- Redacted: laptop IP, project ids, deployment URLs (`<project>.vercel.app`).
