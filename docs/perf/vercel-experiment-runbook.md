# Vercel preview experiment — does the host shape cause the stall and the single-connection pain?

Decided on 2026-09-13 as the next step on the hosting question (`.claude/skills/deployment/netlify/hosting-alternatives.md`). The experiment deploys the `dev` branch to a throwaway Vercel project in Mumbai with Fluid Compute and re-runs the two measurements that define the Netlify pain, so the decision can be made on numbers rather than on vendor claims. Nothing here touches `familiarisenow.com`, its DNS, or the Netlify site.

## What the experiment must answer

Two questions, each with a measurement that already exists for Netlify.

1. Does a burst of concurrent requests still produce the ~24–30 s cold-instance stall (#1124)? On Netlify the protocol is N concurrent unique-key requests to `/explore/experts` after the instance pool has gone idle; 11 of 12 land at 27–39 s. On 2026-09-13 a three-request burst against production reproduced it at once: one request at 30.3 s beside two at 1.1 s (`scripts/perf/burst-ttfb.sh https://familiarisenow.com/explore/experts 3`).
2. Does one warm process serve concurrent requests, so that a pool larger than one connection is safe (#1117, #1436, #1540)? On Netlify every concurrent request lands on its own instance with its own pool, which is why `PG_POOL_MAX=1`.

## Prerequisites (owner actions; the CLI login is interactive)

Install and log in: `npm i -g vercel` then `vercel login`. Create a Vercel project from the GitHub repo with the production branch set to `dev` so that the experiment's "production" deployment is the `dev` branch — bytecode caching and pre-warming only apply to production deployments on Vercel, and the experiment needs both. The Hobby plan is enough for the measurements (Fluid defaults, 2 GB / 1 vCPU, 300 s); it allows a single function region, which must be `bom1`. Use the project's `*.vercel.app` domain only.

Environment variables: copy the `dev` branch-deploy context from Netlify (`netlify env:list --json --context branch-deploy`) into the Vercel project, then set `PG_POOL_MAX=5` — this is the variable under test — and confirm `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, and `NEXT_PUBLIC_APP_URL` point at the `vercel.app` domain so sign-in works on the experiment host. The database is the shared Supabase project, so the experiment reads and writes production data exactly as a Netlify deploy preview does; do not run money flows against it beyond what the deadlock check below needs.

Project settings: Functions region `bom1`; Fluid Compute on (default for new projects); CPU "Standard". No `vercel.json` is committed to the repository for this experiment; set everything in the dashboard so the repo stays host-neutral.

## Protocol

Run each measurement twice on Vercel and once as a same-day control on a Netlify deploy preview of the same `dev` commit, and record the deploy identifiers with the numbers (Netlify deploys map to commits only through `commit_ref`; Vercel shows the commit on the deployment page).

Burst: leave the host idle for at least 30 minutes, then run `scripts/perf/burst-ttfb.sh https://<host>/explore/experts 12`. The script fires twelve concurrent requests with unique query keys so no cache answers, prints each request's TTFB and the host's request or instance header, and counts the slow ones. Netlify's baseline is 11 of 12 slow at 27–39 s; the question is whether Vercel shows any request above 10 s, and how many distinct instance identifiers the twelve requests hit (`x-vercel-id` carries the region and a request id; for a direct instance count, burst `/api/health` instead — its `platform.processUptimeMs` and `platform.eventLoopStallMs` fields, added in #1559 from the #1123 probe, show each request's instance age and whether it sat in the stall).

Concurrency and the pool: with `PG_POOL_MAX=5`, run the same twelve-request burst against a database-backed route and watch Supabase's pooler connection count (`get_logs` / the pooler dashboard) and the app's own `[Prisma:INIT] poolMax=` log line. The result to record is the number of processes that held connections during the burst and whether any request waited on a pool. Then re-run the #1435 shape — the consent read on the global client inside a checkout transaction — through the checkout page on the experiment host; on Netlify at `PG_POOL_MAX=1` it deadlocked, and with a shared process and a five-connection pool it should not. Use a test consultant and the mock payment path only.

Cold start: after 30 minutes idle, one sequential request, three times, for the single-request cold path; Netlify's baseline is ~1.9 s (#1124's batch A) and 28–32 s under concurrent creation.

## Recording the outcome

Write the numbers into `.claude/skills/deployment/netlify/hosting-alternatives.md` under a dated "Measured" subsection, both hosts side by side, and open the decision record under `docs/decisions/` only if the numbers settle the question. Delete the Vercel project afterwards if the decision is to stay; keep it if the decision is to move, since it becomes the staging host.
