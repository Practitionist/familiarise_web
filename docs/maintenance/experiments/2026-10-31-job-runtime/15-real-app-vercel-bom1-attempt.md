# Lab: real familiarise_web on Vercel (bom1) vs Netlify dev

Date 2026-10-31. Source: origin/dev 28d1672e1 (clean detached worktree, nothing committed or pushed, worktree removed).

> **Label.** Everything below is MEASURED except the hypothesis in this note. Hypothesis, not root-caused and UNVERIFIED: the static-generation hang could come from prerendering running queries against the live database (see the build-prerender note in the deployment skill), made slow by a Vercel build machine outside India. The report's own test with an unreachable database also hung, which argues against that, so the cause is open.

## Verdict

BLOCKED. The app did not reach a servable state on Vercel Hobby without code changes, so Vercel route and job latency could NOT be measured. Only the Netlify baseline was measured.

## Versions (MEASURED from build logs)

Vercel CLI 65.9.0 (laptop) / 65.4.0 (build). Next.js 15.5.28. Prisma 7.10.0. Project default Node was 26.x; repo .nvmrc is 22. Build machine: 2 cores, 8 GB, built in iad1 (Washington); functions pinned to bom1 via `--regions bom1` (deployment regions = ["bom1"], x-vercel-id showed bom1). Vercel plan: Hobby, scope kaustav-ghoshs-projects.

## Build result (MEASURED)

Seven preview builds in total (the first was an accidental production-target deploy, cancelled before it finished; see blockers). Outcomes:

| #                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Config                                                              | Result                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                                                                                                                                                                                                                                                                                                                                                                                                                                                              | defaults, Node 26                                                   | ERROR after 7 min: webpack compile SIGKILL, Vercel "OOM event detected" (8 GB container)                                                                                                                                                                                                          |
| 2                                                                                                                                                                                                                                                                                                                                                                                                                                                              | CI_LEAN_BUILD=true, NODE_OPTIONS=--max-old-space-size=6144, Node 26 | READY. Build 846 s (webpack 10.7 min, type check and lint skipped by CI_LEAN_BUILD, 252 static pages in ~15 s). Build report: no memory problems, input 51 MB, output files 8 MB, node_modules 1532 MB. 675 dynamic (ƒ), 32 static, 3 SSG routes; shared first-load JS 112 kB; middleware 165 kB. |
| 3                                                                                                                                                                                                                                                                                                                                                                                                                                                              | same, project Node set to 22.x                                      | HUNG at "Generating static pages (0/252)" for 17+ min (build 2/3 of the way, normally 5 s); cancelled                                                                                                                                                                                             |
| 4                                                                                                                                                                                                                                                                                                                                                                                                                                                              | same Node 22                                                        | HUNG at the same step; cancelled                                                                                                                                                                                                                                                                  |
| 5                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Node 22 + build-time DATABASE_URL pointed at a dead address         | OOM SIGKILL in webpack                                                                                                                                                                                                                                                                            |
| 6                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Node 22, heap 5632, dead DB URL                                     | webpack passed, HUNG at static pages 0/252 again; cancelled                                                                                                                                                                                                                                       |
| Function count and size: NOT exposed by the Vercel API (builds API lists only middleware, 1.4 MB). Warnings (MEASURED): Edge-runtime warnings for @upstash/redis (process.version) and jose (CompressionStream) imported via lib/rate-limit.ts and better-auth cookies; no sharp or @img message appeared in the log; I did not inspect NETLIFY/VERCEL branches beyond reading next.config.mjs (NETLIFY-only checks, lean build via NETLIFY or CI_LEAN_BUILD). |

## Runtime on the one READY build (Node 26) (MEASURED)

Every route, including /api/health, /api/topics, pages and /api/cleanup/prune-system-events, returned 500 `MIDDLEWARE_INVOCATION_FAILED`. Runtime log: `Failed to load the ES module: /var/task/middleware.js. Make sure to set "type": "module"` on runtime nodejs26.x. Node 22 builds (which might avoid this) never finished building (hang above). Server-side TTFB of the failing 500s was 0.28-0.9 s from the laptop (not a meaningful latency).

## Route latency table

Vercel bom1: NOT MEASURED (blocker). Netlify baseline, MEASURED from this laptop, TTFB ms, 12 sequential requests per path: the first 2 are shown as "first two" (cold status not controllable on Netlify, so they are only "first requests"), p50/p95 over the following 10. The laptop address is not recorded.

| Path                         | HTTP | first two   | p50 | p95  |
| ---------------------------- | ---- | ----------- | --- | ---- |
| /                            | 200  | 2182 / 384  | 763 | 1127 |
| /explore/experts             | 200  | 4285 / 4196 | 600 | 2002 |
| /explore/experts/<seeded id> | 200  | 335 / 369   | 339 | 849  |
| /explore/programs            | 200  | 3829 / 584  | 681 | 1038 |
| /pricing                     | 200  | 342 / 353   | 331 | 584  |
| /api/health                  | 200  | 1863 / 328  | 334 | 608  |
| /api/topics                  | 200  | 461 / 1106  | 438 | 934  |
| /api/currency                | 200  | 314 / 367   | 327 | 723  |
| /sitemap.xml                 | 200  | 490 / 378   | 331 | 632  |
| /api/announcements           | 200  | 3900 / 373  | 332 | 398  |

Netlify response headers carry `server: Netlify` and an x-nf-request-id (no region evidence in headers). Vercel evidence: the failing responses carried `x-vercel-id: bom1::...`, confirming bom1 routing only. Raw data was not kept.

## Job duration table

Vercel: NOT MEASURED (blocker; the cleanup route is behind the same failing middleware). Netlify reference, MEASURED from SystemJobExecution.durationMs, last 24 h on the shared dev DB (read-only psql): reconcile-payment-status p50 490 ms / avg 509 / n=101; reconcile-orphaned-confirmations p50 275 / avg 312 / max 2507 / n=101; prune-system-events avg 90 / p50 79 / n=5 (all triggeredBy cron). Only one invocation of one job was attempted on Vercel (prune-system-events?limit=5) and it was rejected by the middleware 500 before reaching the job.

## Cost

Hobby plan: free allowance (DOCS). The Vercel billing charges endpoint returned 404 "Costs not found" for the project, so no usage figure is available (MEASURED: 404). Seven builds consumed on the order of 90 build-minutes; 8 GB / 2-core standard build machine.

## Blockers hit

1. `vercel deploy` on the first deployment of a no-Git project defaulted to the Production target (CLI printed "Production"). It had no Preview envs. I cancelled it and used `--environment preview` thereafter. No prod alias was assigned.
2. Webpack compile OOM-killed on the 8 GB Hobby build container with default settings, and again intermittently with lean settings. Workaround used is configuration only: build-env CI_LEAN_BUILD=true plus NODE_OPTIONS heap cap. Netlify uses a 6144 MB heap cap too.
3. Project default Node 26.x: the built middleware fails to load at runtime. No code workaround attempted (rule: do not change repo code).
4. Node 22.x build hangs at static page generation (reproduced 3 times, also with the database unreachable at build time). Cause unknown; I did not debug further and stopped near the 120 minute budget.
5. `vercel link` modified `.gitignore` and wrote `.env.local` in the throwaway worktree only (removed with the worktree).
6. Function count and size could not be read from the API.

## Environment used (names only, no values)

Copied from .env into Preview: DB URLs, auth secrets and OAuth ids, Supabase, R2, Razorpay (TEST keys verified `rzp_test_`), Upstash REST, PAN and auth-config encryption keys, webhook secret. Overrides: PG_POOL_MAX=5, EMAIL_DELIVERY_MODE=allowlist, NEXT_PUBLIC_SENTRY_ENVIRONMENT=lab-vercel, a generated CRON_SECRET. Left out: Sentry (all), Novu, Stream, Resend, Stripe, REDIS_URL, seed passwords, Supabase access token. No `crons` existed (no vercel.json in the repo). No schedulers ran. The shared DB was only read; no jobs executed on Vercel.

## Dashboard URLs

- Project: https://vercel.com/kaustav-ghoshs-projects/fw-lab-app-bom1
- Build logs of the READY (Node 26) deployment were at .../fw-lab-app-bom1/ and are now deleted with it.

## Cleanup proof (MEASURED)

- All 31 Preview env vars removed: `vercel env ls` -> "No Environment Variables found".
- All 7 deployments deleted: `vercel ls` -> "No deployments found".
- Protection-bypass secret revoked: protectionBypass = {}.
- Worktree removed (`git worktree list` shows none for fw-vercel-probe); no local vercel/bench processes remain; temp secrets deleted.
- The project fw-lab-app-bom1 is kept empty for 48 h as requested.

## Suggested next step

To get a real number: either pin the Node version and fix the middleware/ESM load under the chosen runtime and find why static generation hangs on Node 22 (needs code or a build-config investigation), or measure with a Docker/Cloud Run host instead, which the repo already supports.
