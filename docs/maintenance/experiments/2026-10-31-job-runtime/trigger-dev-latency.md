# Trigger.dev Cloud -> Supabase Mumbai (ap-south-1) latency probe

Date 2026-10-31. Free plan, prod env, deployed version 20261031.1 (remote build, no local Docker).
Versions: trigger.dev CLI + @trigger.dev/sdk 4.8.3, pg 8.23.1, runtime node 24.22.1 on Trigger (project defaultRuntime node-24), laptop node 26.9.0.
DB targets (credentials redacted): aws-0-ap-south-1.pooler.supabase.com:6543 (transaction pooler) and :5432 (session pooler; the repo's DIRECT_URL points at the pooler host, not db.<ref>.supabase.co).

## Code
- /Users/kaustavghosh/.claude/jobs/c5ca4c05/tmp/lab-trigger/src/probe.mjs (probe: ipify, connect, 50x SELECT 1, 20 read-only queries cycling 5 SELECT/count queries on Payment, Appointment, SystemJobExecution, LIMIT 50)
- src/trigger/db-probe.ts (task), trigger.config.ts (build.external: ["pg"]), run.mjs (trigger with `region`/`machine` options + poll), local.mjs (laptop).
- Env vars PROBE_DB_URL / PROBE_DIRECT_URL set via management API (POST /api/v1/projects/:ref/envvars/prod).

## Results (all runs COMPLETED; small-1x unless noted)
| Where | Egress IP | Pooler | Connect ms | SELECT 1 median / p95 ms | 20-query mix total ms | Queue-to-start ms | Run duration ms | Cost (cents) |
|---|---|---|---|---|---|---|---|---|
| laptop (not representative, Indian residential) | <laptop-ip> | 6543 | 251-277 | 39.4 / ~45-61 | 1050-1078 | n/a | n/a | n/a |
| laptop | same | 5432 | 251-263 | 39.5 / 45 | 1051-1132 | | | |
| eu-central-1 (run 1) | 3.40.0.47 | 6543 | 765 | 125.4 / 125.8 | 3679 | 249 | 20891 | 0.0705 |
| eu-central-1 (run 1) | | 5432 | 742 | 121.6 / 121.9 | 2605 | | | |
| eu-central-1 (run 2) | 3.40.0.47 | 6543 | 748 | 123.2 / 123.4 | 2632 | 249 | 20154 | 0.0680 |
| eu-central-1 (run 2) | | 5432 | 772 | 128.1 / 128.4 | 2719 | | | |
| eu-central-1 micro | 3.40.0.36 | 6543 | 761 | 124.2 / 124.9 | 2719 | 264 | 20474 | 0.0345 |
| eu-central-1 micro | | 5432 | 777 | 125.2 / 125.5 | 2736 | | | |
| us-east-1 | 32.197.167.126 | 6543 | 1123 | 185.4 / 185.7 | 3986 | 254 | 29683 | 0.1002 |
| us-east-1 | | 5432 | 1118 | 185.6 / 186.1 | 3984 | | | |
| us-west-2 | 3.42.133.8 | 6543 | 1408 | 232.2 / 232.5 | 4811 | 54 | 36741 | 0.1240 |
| us-west-2 | | 5432 | 1397 | 232.2 / 232.6 | 4803 | | | |
| no region option (project default null) | 32.197.167.126 | 6543 | 1122 | 185.2 / 185.5 | 3866 | 244 | 29440 | 0.0994 |
| (same run) | | 5432 | 1120 | 186.1 / 186.5 | 3877 | | | |

Raw JSON per run: result-*.json, laptop.json. Run durations are dominated by the probe itself (~100+ serial round trips plus ~1 s of TLS connects), not by platform overhead. Cost is the API's costInCents; base invocation fee is 0.0025 cents.

## Findings
- Per-query RTT from Trigger is region-bound and very stable (p95 within ~1 ms of median): eu-central-1 ~125 ms, us-east-1 ~185 ms, us-west-2 ~232 ms, versus ~40 ms from a laptop in India. Unspecified region lands in us-east-1 (same egress IP), the worst of the usable options after us-west-2.
- Connect (TCP+TLS+auth) costs 6-6.5 round trips: ~750 ms from EU, ~1.1 s US-east, ~1.4 s US-west. Always reuse a connection.
- Transaction (6543) vs session (5432) pooler: no meaningful latency difference in steady state. The 20-query mix is ~21 serial round trips: ~2.6 s from EU even though each query is trivial, so a chatty task (N sequential Prisma queries) costs N x ~125 ms at best. Batch queries / use fewer round trips or run the heavy work close to the DB.
- Only the first laptop run (before I fixed a bad column name) showed a 2 s outlier on 6543 during a failing query; not reproduced.
- Only EU and US regions were accepted on the Free plan in this account: eu-central-1, us-east-1, us-west-2 worked; ap-south-1 and ap-southeast-1 are rejected ("The region you specified doesn't exist"). There is no Mumbai/Asia region, so ~125 ms RTT from eu-central-1 is the floor.
- Egress IPs: two eu-central-1 small-1x runs had the same IP (3.40.0.47); the micro run had a different one (3.40.0.36, same 3.40.0.x block); us-east-1 gave 32.197.167.126 on both the explicit and default runs. These look like a small stable pool, but they are dynamic on Free and not guaranteed.
- Static IPs: per the Trigger.dev changelog (https://trigger.dev/changelog/static-ips) static IPs are for paid customers only; free uses dynamic IPs. The page does not say Hobby vs Pro, region coverage or IP count; pricing page (https://trigger.dev/pricing) lists Free $0 / Hobby $10 / Pro $50 and AWS PrivateLink only on Pro; no static-IP line was shown. Confirm with Trigger support before relying on Hobby. The docs URLs /docs/static-ips and /docs/regions returned 404 (docs moved). The regions API endpoint (GET /api/v1/projects/:ref/regions) returned 400 Invalid Params, so I did not get the dashboard region list via API.
- Relevant to the repo: RazorpayX needs allowlisted static egress; Free-plan Trigger IPs are not suitable.

## Footguns
- Region option works per trigger (`tasks.trigger(id, payload, { region })`), no redeploy needed. Region names must be exact; I wasted calls passing "region machine" as one string (my shell mistake).
- Machine option `machine: "micro"` per trigger works; micro ran the same speed at half the cost (0.0345 vs 0.068 cents).
- Deploy used Trigger's remote builder; `build.external: ["pg"]` worked. No Node issues (runtime 24).
- ctx has no region field; TRIGGER_REGION env var is not set in the container. Infer region from the egress IP/your own trigger option.
- No secret-key endpoint found; I minted a short-lived JWT via POST /api/v1/projects/:ref/prod/jwt (scopes write:tasks, read:runs), usable as the SDK accessToken.
- Env var API: GET /envvars/prod returns values in plain text (isSecret false) - an ad-hoc debug call of mine printed the DB credentials into my own tool transcript once (not in any file). The pooler password for this shared mock DB should be rotated if the transcript is retained.
- Retrieved run `startedAt - createdAt` is only ~250 ms for warm queue; actual cold start is inside the duration (first run ~5-8 s overhead beyond probe time was not separable).

## Cleanup
Env vars PROBE_DB_URL and PROBE_DIRECT_URL were DELETED from Trigger.dev prod via the API (both returned 200); a follow-up GET /envvars/prod returned an empty list [] -- confirmed gone. The deployed task version 20261031.1 remains (contains no secrets; will fail harmlessly with "no url" if run). Repo untouched, no commits.
