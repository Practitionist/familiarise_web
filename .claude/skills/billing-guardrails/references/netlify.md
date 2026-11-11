# Netlify

## 1. Plan and limits

Rechecked 2026-10-23 using getSite and listAccountsForUser: familiarise belongs to Practitionist-Deploys (teetangh), whose account reports type_slug=orb-pro, credit_features.included=false, functions.included=125000, functions_gb_hour.included=1000, build_minutes.included=25000 and concurrent_builds.included=3. These are plan capability fields, not metered usage; used=0 does not establish a zero bill.

The account explicitly reports background_functions.included=true. Current [general documentation](https://docs.netlify.com/build/functions/usage-and-billing/) restricts legacy-plan background availability, so preserve the account-specific evidence and require deployed manifest/runtime verification. Do not assume availability or impossibility from the general plan name alone.

Netlify distinguishes legacy request billing from credit-based compute and web-request meters (section 1.2). Use actual provider usage and invoices before quoting an overage or changing plans. The [credit model](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/) has multiple meters; fewer function calls need not reduce total credits if compute or bandwidth grows. Current plan price and exact overage are not established by the capability response.

## 1.1 What the bill is made of (legacy Pro)

MEASURED from receipts and usage (what we pay: value kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend)):

- $19 per member per month (public legacy Pro price). The seat count and the resulting bill: value kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend).
- Function invocations of the `familiarise` site by billing period: May 24,804; June 48,552; August 75,897; September 4 to October 3 282,162. Crossing the 125,000-per-site tier adds a flat $25 (125,000 to 2,000,000).
- Nothing else is close: bandwidth 1.29, 1.60, 8.26 and 8.36 GB against 1 TB; edge function invocations 52,000 rising to 284,000 against 2,000,000 free; build minutes up to 9,777 of 25,000. Invocations are the only meter that has crossed a line.

DOCS (Netlify support ticket #1112198, 2026-09-17, and [legacy plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/legacy-pricing-plans/)):

- Keep-warm pings bill like real invocations (about 26,000 a month for three pings every five minutes). That keep-warm was retired on 2026-10-03. Both keep-warm figures were real at different times: 32,400 a month was the 4-minute configuration (three pings every four minutes), and about 26,000 a month is the support ticket's figure for three pings every five minutes.
- A cold-start stall bills as duration: 28 seconds at 1,024 MB is about 28 GB-seconds against the 1,000 GB-hour allowance.
- Legacy Pro has no hard spend cap, only usage alerts at 50, 75, 90 and 100 percent. Overage above 2,000,000 invocations is billed per 500,000.

The ticker used to be the largest controllable source: MEASURED about 94,850 invocations a month on `dev` (8,640 ticks plus 86,210 target calls) plus 8,640 slot-claim calls, with 99.8 percent of runs in a 7-day window processing zero items. After the skip-idle change the estimate was about 22,450 a month (`docs/decisions/2026-11-01-ticker-skip-idle-targets.md`); MEASURED on 2026-11-03/04 (10-minute `netlify logs` windows on the published deploy): about 57,000 a month, made of about 11,100 ticks, 11,200 slot-claim calls, 33,800 target calls and about 2,000 streak reads. Two causes keep it above the estimate: eight probed jobs whose probe almost never reports idle (about 16,000 calls a month that process zero items), and Netlify firing about 29 percent of five-minute slots twice since 2026-11-02 (the Postgres claim stands the duplicate down, but each still costs two invocations). Both are tracked in #2613. For the whole site the run rate was about 195,000 a month (about 71,000 from deploy previews and the `dev` branch deploy, 57,000 ticker, 29,000 external pollers, 39,000 other production traffic), which exceeded the 125,000 included and cost one $25 step (covering up to 2,000,000) on invoice CFJUKK-00022 (2026-11-04). Middleware runs as an Edge Function, a separate meter, so editing the matcher does not reduce function invocations. Every new job must declare an idle probe or an `alwaysRun` reason (`lib/cron/cleanup-registry.ts`); a job that always runs is a permanent monthly invocation cost.

Better Stack checks `familiarisenow.com` and `/api/health` every 3 minutes (`docs/maintenance/00-betterstack-setup.md`). The homepage is ISR (`revalidate = 3600` in `app/page.tsx`) and served from the CDN, so its check is not a function invocation; the `/api/health` check is, at about 14,400 a month per checking region. The owner decided on 2026-11-01 to keep both monitors unchanged.

## 1.2 Credit-based plans (PENDING, not decided)

DOCS ([pricing](https://www.netlify.com/pricing/), [how credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/)):

- Pro is $20 flat with 3,000 credits and unlimited members. Packs are 1,500 credits for $10; auto-recharge is off by default; free-plan sites pause when credits run out.
- Costs: a production deploy 15 credits; Deploy Previews and branch deploys free; compute 10 credits per GB-hour (Serverless, Scheduled and Background Functions; Edge Functions do not count); web requests 2 credits per 10,000; bandwidth 20 credits per GB; forms free.
- The switch is permanent: "You cannot revert to a Legacy plan from a Credit-based plan."
- Our usage estimate in credits and the status of the support email are kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend). Do not recommend the switch as decided.

## 2. What causes surprise bills or outages

- Compute usage depends on allocated memory and execution duration, not observed heap usage. Entry-preloading is disabled to avoid unnecessary cold-start work; do not infer a bill by multiplying heap measurements by time.
- Keep-warm pingers bill like user traffic: one route pinged every five minutes is 8,640 invocations in a 30-day month, multiplied by every route the pinger hits and race the reclaim window anyway.
- Pages marked `force-dynamic` invoke the server handler on every visitor instead of being served by the CDN.
- The ticker deliberately returns 200; its status is not a worker-health signal. Background functions have documented asynchronous failure retries after one and then two minutes, which ours avoid: `runBackgroundWorker` (`lib/cron/background-worker.ts`) never throws, so a failed run is recorded and logged, not retried. Do not apply that retry contract to every function type without evidence.
- Bandwidth from uncached large assets; build minutes on every deploy preview, including those nobody looks at.

## 3. Exposure in this repo

- `netlify/functions/cron-tick.mts` fires every five minutes (`*/5 * * * *`), about 8,640 ticks a month, each fanning out to due targets in `lib/cron/schedule.ts`. Cadence tests bound planned waves to `MAX_TARGETS_PER_TICK=12`. If the due wave exceeds that ceiling, `dueTargets` omits `reconcile-ledgers` for that tick and retains the other targets. This specific ledger deferral is not a general truncation or worker concurrency queue. It answers 200 regardless of individual target results. Use completed capabilities and the structured failure buckets for health.
- `next.config.mjs` sets `experimental.preloadEntriesOnStart: false` and `experimental.appDocumentPreloading: false`; turning either on makes `NextNodeServer` load route entries on every cold container (20 to 34 s of GB-seconds and 504 timeouts). `__tests__/lib/next-config-preload.test.ts` pins this.
- A prior memory increase did not resolve the entry-preloading stall. Changing allocation needs new latency measurements and account-specific pricing; usage growth alone does not establish the invoice delta.
- `app/page.tsx` uses `revalidate = 3600`, not `force-dynamic`, so the CDN serves marketing traffic.
- Cacheable global polling endpoints must send CDN `Cache-Control`: `app/api/announcements/route.ts` sends `public, s-maxage=60, stale-while-revalidate=300`; `app/api/health/route.ts` sends `public, s-maxage=30, stale-while-revalidate=60` when healthy and `no-store` otherwise.
- Build tuning under `NETLIFY === "true"` in `next.config.mjs`: `staticGenerationMaxConcurrency: 2`, `cpus: 1`, `enablePrerenderSourceMaps: false`. They slow builds (more build minutes) to avoid exit 137; the tradeoff is accepted.
- `netlify.toml` ignores deploy previews for Dependabot branches, which saves build minutes.
- Preserve `netlify.toml` and `netlify/functions/cron-tick.mts` for standby compatibility when another host is adopted; operational standby readiness requires a deployed artifact and a drill.

Execution-history rows are not a billing meter. `abandoned-payments` records three named lease acquisitions per HTTP request. Counting distinct job/minute pairs can merge retries and omit lock losers, startup failures and ticker invocations; report it as an estimate only. Use provider usage and invoices for actual cost. Capability API `used` fields returning zero do not establish zero billed usage. Current credit plans also meter web requests as well as compute; changing plans requires a separate cost comparison.

## 4. Guardrails to set

- Team settings, Billing, Usage: enable usage notifications. On this legacy plan there are no credits, so the old rule about 50, 75 and 90 percent of credit allocation applies only if the team moves to credit-based billing.
- Never re-introduce the keep-warm function file or any external pinger. The file does not exist today.
- Skip builds you do not need: extend the `ignore` command in `netlify.toml` rather than building every bot branch.
- Keep production, `deploy-preview` and `branch-deploy` env values separate for Upstash and Novu.

## 5. Monitor

```bash
netlify api listAccountsForUser | python3 -c "import sys,json; [print(a['slug'], a['type_slug'], a['capabilities']) for a in json.load(sys.stdin)]"
netlify logs --url <deploy-permalink> --json
```

The Netlify MCP reads projects, deploys and env vars only; it cannot read usage or logs. Usage is in the console under Team, Billing.

## Retired rule

The earlier rule that `/sw.js` must carry `Cache-Control: public, max-age=0, must-revalidate` is retired: no `sw.js` exists in `public/`, `netlify.toml` or `next.config.mjs`. Re-add the header only if a service worker returns.
