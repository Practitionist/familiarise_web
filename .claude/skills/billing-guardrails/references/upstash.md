# Upstash Redis

## 1. Plan and limits

One database, `Familiarise`, region `ap-south-1`, on pay-as-you-go since 2026-09-25 with a monthly budget set in the console (the amount and the run rate: value kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend), with the trigger in Familiarise / Finance and Pricing / Finance Lever Register), per issue #2145. VERIFIED 2026-10-17 from [Upstash Redis pricing](https://upstash.com/pricing/redis): Free is 500K commands a month, 250 MB and 10 GB bandwidth; pay-as-you-go is $0.20 per 100K commands; a monthly budget applies to pay-as-you-go only, emails at 70 and 90 percent and rate-limits the database at the cap. The pricing page does not say what the Free plan does at 500K; in this repo it returned `ERR max requests limit exceeded. Limit: 500000` on every command (observed 2026-09-21). The older table in `docs/upstash/00-pricing-overview.md` was verified in April 2026 and predates the PAYG move.

## 2. What causes surprise bills or outages

- Every Redis call over REST is a billed command; a loop of GETs at five-minute cadence across dozens of targets adds up silently.
- At the cap the database rejects commands. Anything that fails closed fails everywhere at once: before 2026-10-02 that was every cron job, and today `lib/rate-limit.ts` limiters and the maintenance-mode read are the exposure.
- A budget protects the bill but also rate-limits the database when reached, which is an outage by another name.
- Sharing one database between production and previews spends the production budget on QA.

## 3. Exposure in this repo

- The 2026-09-21 incident: with cron locks in Redis, the 18-target ticker spent about 430,000 of 500,000 monthly commands (derived from code; Upstash keeps five days of history). Locks moved to a Postgres lease on `SystemJobExecution` (`lib/cron/with-cron-lock.ts`, `withCronLock`), so cron mutual exclusion no longer spends commands; only the heartbeat write (`cron:heartbeat:last`) remains.
- `lib/redis.ts` wraps the client in a per-service circuit breaker (failure threshold 5, 30 s reset) and exposes lock helpers used for short interactive mutexes (`utils/appointmentlock.ts`).
- `lib/rate-limit.ts` `makeLimiter` builds sliding-window limiters with a `LIMITER_TIMEOUT_MS` constant of 500 ms (fail-open on timeout) and does not enable `analytics`, saving one command per request. Keep it that way.
- Do not run rate-limit Redis calls on static assets (`/_next/static/*`, `/_next/image/*`, `/favicon.ico`) or CDN-cached health and announcements endpoints.
- `lib/maintenance-edge.ts` reads `maintenance:phase` with a 200 ms timeout; failed reads cache OFF for 30 s, so slowness multiplies reads.
- The usage alarm is a section of the daily `ops-digest` (`upstashSection` in `lib/observability/ops-digest.ts`), not an Actions step. It reads the Upstash management API with `UPSTASH_MANAGEMENT_API_KEY`, `UPSTASH_EMAIL` and `UPSTASH_DATABASE_ID`, compares against `UPSTASH_MONTHLY_COMMAND_CAP`, and lists a standing item from 70 %. All four settings must be in the Netlify production environment, or the section reads "unknown".
- The cron platform switch `ops:active_cron_platform` lives here; the standby design reads it on every tick.
- Production, deploy previews and branch deploys still share this database (issue #2145, item A4: a separate preview database is decided but not created).

## 4. Guardrails to set

Upstash console, database, Details: keep pay-as-you-go with Max Monthly Budget; set it above expected spend but low enough to bound an incident (the chosen amount is in Notion; lower it only deliberately because the cap itself rate-limits). Create a second database for previews and point the `deploy-preview` and `branch-deploy` Netlify contexts at it.

## 5. Monitor

Upstash MCP: `redis_list_databases`, `redis_get_stats` (daily commands, cost), `redis_run_command` for `DBSIZE`. Console: Database, Usage.
