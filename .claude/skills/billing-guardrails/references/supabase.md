# Supabase

## 1. Plan and limits

One Supabase project serves dev and production (`docs/supabase/setup-guide.md`, project notes). The plan is not stated in repo docs; the recordings decision (`docs/decisions/2026-10-09-recording-storage-retention-visibility.md`) records that the Free plan's 50 MB per-object cap ruled out Supabase Storage for recordings, which suggests the project was on Free when that was written (INFERRED; confirm in the Supabase Console — the project-scoped MCP cannot read organization or cost data). Region is Mumbai (`ap-south-1`).

VERIFIED 2026-10-17 from [Supabase pricing](https://supabase.com/pricing) and [billing](https://supabase.com/docs/guides/platform/billing-on-supabase): Free is $0 with 500 MB database and projects pause after a week of inactivity; Pro starts at $25 a month with $10 compute credit covering one Micro instance, 250 GB egress ($0.09 per GB after), 100 GB storage ($0.021 per GB after) and 100,000 MAU; compute is Micro $10, Small $15, Medium $60, Large $110, XL $210 a month; PITR is $100 a month per 7 days; branching is $0.01344 per branch per hour. [Cost control](https://supabase.com/docs/guides/platform/cost-control) (VERIFIED): the spend cap exists only on Pro; with it on, an item that passes quota is blocked until the next cycle; it does not cover compute, branching compute, read replicas, custom domain, extra IOPS, IPv4, log drains or PITR.

## 2. What causes surprise bills or outages

- A free project pauses after inactivity; on Free there is no bill but also no availability guarantee.
- Spend cap on means a Storage or egress overrun blocks that feature (uploads fail) rather than billing; cap off means unbounded overage.
- Compute upgrades and PITR are never capped; a branch left running bills hourly (about $9.68 a month each).
- Direct connections are limited (60 on small tiers); the pooler (Supavisor, port 6543) allows more clients, so serverless must use it.
- Egress from large downloads proxied through functions.

## 3. Exposure in this repo

- `lib/prisma.ts` builds a `PrismaPg` pool on `DATABASE_URL` (the transaction pooler). Pool size comes from `PG_POOL_MAX`, which must be set on Netlify (`1` there); connection and query timeouts come from `PG_CONNECT_TIMEOUT_MS` and `PG_QUERY_TIMEOUT_MS`, and `statement_timeout` is set one second below the query timeout. The earlier rule naming `connection_limit=5` and `pool_timeout=10` URL parameters is superseded by this code.
- Build concurrency under Netlify in `next.config.mjs` (`staticGenerationMaxConcurrency: 2`, `cpus: 1`, `enablePrerenderSourceMaps: false`) bounds pooler load during prerender; the build prerenders against the live database.
- Background jobs (`app/api/cleanup/[job]/route.ts`, `scripts/reconcile/reconcile-ledgers.ts`) must use set-based SQL and bounded `LIMIT` batches under `withCronLock`; no N+1 loops. Prisma round trips cost about 95 ms each, so statement count is latency and compute.
- Dev, preview and production share the database, so a preview load test spends production compute.
- Uploads over 4 MB use `createSignedUploadUrl` so bytes bypass functions and egress through them.

## 4. Guardrails to set

Organization, Billing, Cost Control: turn the Spend Cap ON (Pro). Set usage alerts in the organization Usage page. Delete idle branches in the Supabase Console. Never enable PITR or a larger compute without the owner confirming the monthly line in the Console.

## 5. Monitor

Supabase MCP: `get_advisors`, `get_logs`, `list_tables`, read-only `execute_sql`. Console: Organization, Usage, branches and cost.
