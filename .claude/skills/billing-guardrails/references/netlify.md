# Netlify

## 1. Plan and limits

The site `familiarise` is on the legacy Pro plan: the account API reports `type_slug: orb-pro` and `credit_features: false`, with 125,000 function invocations, 1,000 GB-hours, 25,000 build minutes and 3 concurrent builds as plan capability flags (`.claude/skills/deployment/netlify/platform-limits.md`, measured 2026-09-12). The legacy pricing table lists Pro bandwidth at 1 TB with $55 per extra 100 GB, build minutes at $7 per extra 500, and edge functions at 2M invocations then $2 per million ([legacy pricing plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/legacy-pricing-plans/), read through a search result summary; INFERRED for exact overage). The overage rate for serverless invocations was not found in the docs (unknown). Netlify's current credit-based Pro plan is a different model ($20 a month, 3,000 credits; compute 10 credits per GB-hour, bandwidth 20 credits per GB, deploys 15 credits each; [netlify.com/pricing](https://www.netlify.com/pricing/), VERIFIED); moving to it is irreversible, so decide deliberately.

## 2. What causes surprise bills or outages

- A cold-start stall bills as wall-clock duration: a 28 s stall at about 1.2 GB bills about 33.6 GB-seconds (28 s x 1.2 GB) per request. Measured and fixed in PR #1972.
- Keep-warm pingers bill like user traffic (about 32,400 invocations a month at a five-minute ping) and race the reclaim window anyway.
- Pages marked `force-dynamic` invoke the server handler on every visitor instead of being served by the CDN.
- Scheduled functions: a 5xx answer makes Netlify retry up to three times, tripling invocations.
- Bandwidth from uncached large assets; build minutes on every deploy preview, including those nobody looks at.

## 3. Exposure in this repo

- `netlify/functions/cron-tick.mts` fires every five minutes (`*/5 * * * *`), about 8,640 ticks a month, each fanning out to due `TARGETS` (27 today) capped at 8 targets per tick through `TARGET_EVERY_MINUTES` and `TARGET_OFFSET_MINUTES`. It always answers 200 (`statusFor`) precisely to avoid Netlify's 3x retry.
- `next.config.mjs` sets `experimental.preloadEntriesOnStart: false` and `experimental.appDocumentPreloading: false`; turning either on makes `NextNodeServer` load all 606 routes on every cold container (20 to 34 s of GB-seconds and 504 timeouts). `__tests__/lib/next-config-preload.test.ts` pins this.
- Do not raise `___netlify-server-handler` memory: a 2048 MB A/B on 2026-08-22 doubled GB-hour billing without fixing the stall.
- `app/page.tsx` uses `revalidate = 3600`, not `force-dynamic`, so the CDN serves marketing traffic.
- Cacheable global polling endpoints must send CDN `Cache-Control`: `app/api/announcements/route.ts` sends `public, s-maxage=60, stale-while-revalidate=300`; `app/api/health/route.ts` sends `public, s-maxage=30, stale-while-revalidate=60` when healthy and `no-store` otherwise; `app/api/cookie-preferences/route.ts` now answers `private, no-store` for every caller, so it is a per-visitor function call (do not poll it from the root layout).
- Build tuning under `NETLIFY === "true"` in `next.config.mjs`: `staticGenerationMaxConcurrency: 2`, `cpus: 1`, `enablePrerenderSourceMaps: false`. They slow builds (more build minutes) to avoid exit 137; the tradeoff is accepted.
- `netlify.toml` ignores deploy previews for Dependabot branches, which saves build minutes.
- Standby: Netlify is also the hot standby host; keep `netlify.toml` and `netlify/functions/cron-tick.mts` intact.

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
