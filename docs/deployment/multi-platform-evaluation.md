# Multi-Platform Next.js 15 Hosting Evaluation & Ranking Scorecard (2026)

> Canonical vendor-neutral evaluation for `Practitionist/familiarise_web` (Next.js 15.5.27 App Router, 606 routes, React 18.3, Prisma 7.7 + `pg` against Supabase Postgres in AWS `ap-south-1` Mumbai).
> Cross-references: GitHub Issues **#2095** (Vercel Pro RFC), **#2096** (Multi-Platform Scorecard), and **#2097** (Hot-Standby Emergency Failback).

> **Region facts checked on 2026-11-11.** Fly.io's public region list (<https://docs.fly.io/reference/regions>, 17 regions) no longer includes `bom` (Mumbai); the closest listed region is `sin`. Every Fly.io `bom` row and score below is therefore **invalid** unless `fly platform regions` shows `bom` for our account. Netlify confirmed in writing on 2026-11-11 that `ap-south-1` is not available on any plan, so `sin` stays the closest Netlify region.

---

## 1. Executive Summary

Following PR `#1972` ([ADR 32](../enterprise/70-design-decisions/32-hosting-for-a-burst-sensitive-nextjs-app.md)), disabling Next.js 15's default eager route preloading (`experimental.preloadEntriesOnStart: false` and `appDocumentPreloading: false` in `next.config.mjs`) eliminated Netlify's 28–38s cold-start `504` stall (`31.5s` -> **`0.97–1.90s`** across 12 concurrent cold requests at `33 MB` V8 heap).

However, **three structural platform limits remain permanent on Netlify Pro (`sin` Singapore)**:

1. **Cross-Ocean Database Latency (`55–70 ms` RTT per query)**: Netlify has no Mumbai (`ap-south-1`) region; every sequential Prisma round-trip from Singapore (`sin`) to Supabase Mumbai adds `~60 ms`.
2. **Single-Request Lambda Concurrency (`PG_POOL_MAX=1`)**: Each concurrent request requires a separate single-threaded Lambda microVM and dedicated DB pool connection rather than multiplexing I/O-bound requests onto one warm pool (`PG_POOL_MAX=10..15`).
3. **Edge & Payload Ceilings**: `~26–34s` non-streaming CDN inactivity cutoff (`60s` max Lambda wall-clock), `6 MB` binary payload limit, `8 GB` build cgroup limit (`exit 137`), and Background Functions silently skipped on `deploy-preview` and `dev`.

Evaluating all **10 viable hosting options** strictly against our codebase's physical requirements proves that **Google Cloud Run (`asia-south1` Mumbai — `93/100`) ranks #1 overall**, followed closely by **Vercel Pro (`bom1` Mumbai Fluid Compute — `89/100`)** and **Fly.io (`bom` Mumbai — `88/100`, ranking invalid: see the region note above)**, while **Netlify Pro (`sin` — `72/100`)** serves as our zero-cost-to-maintain **Hot-Standby / `< 90s` Emergency Failback Host**.

---

## 2. Master Technical Comparison Tables — Transposed (`Platforms #1–#10 as Rows`)

### 2A. Compute Region, Database RTT, Concurrency & Hard Limits

| Rank & Platform                   | Region & DB RTT (`ap-south-1`)           | Runtime & Concurrency                          | `pg` Pool                     | RAM Ceiling              | Max HTTP Body (`Req` / `Resp`)           | Max Execution Timeout                   |
| :-------------------------------- | :--------------------------------------- | :--------------------------------------------- | :---------------------------- | :----------------------- | :--------------------------------------- | :-------------------------------------- |
| **🥇 #1 GCP Cloud Run**           | **Mumbai (`asia-south1`)** · `1.5–4 ms`  | Container (`standalone`) · `80–1,000` req/inst | **Shared (`10–15`)**          | `512 MiB – 32 GiB`       | `32 MiB` HTTP/1.1 · **Unlim HTTP/2**     | **`3,600s` (`60m`) + `168h` Jobs**      |
| **🥈 #2 Vercel Pro (Fluid)**      | **Mumbai (`bom1`)** · `1.5–4 ms`         | Fluid Node 22 MicroVM · Multi-req              | **Shared (`5–10`)**           | `2 GB` std / `4 GB` perf | **❌ `4.5 MB` HARD CAP** (both)          | `300s` def / `800s` max                 |
| **🥉 #3 Fly.io (`bom`, invalid)** | **Mumbai (`bom`)** · `2–6 ms`            | Firecracker VM (`standalone`) · Unlim loop     | **Shared (`10–15`)**          | `256 MB – 64 GB`         | **✅ Unlimited** (`10 MB` retry buf)     | **Unlimited streaming** (`60s` idle)    |
| **#4 DigitalOcean App**           | **Bangalore (`blr1`)** · `12–25 ms`      | Container (`standalone`) · Unlim loop          | **Shared (`10–15`)**          | `512 MB – 64 GiB`        | **✅ Unlimited** (`600s` upload)         | `100s` HTTP / `30m` Job / Unlim Worker  |
| **#5 Railway (`sin` Metal)**      | Singapore (`sin`) · `45–65 ms`           | Container (`standalone`) · Unlim loop          | **Shared (`10–15`)**          | `512 MB – 32 GB`         | **✅ Unlimited** (`5m` window)           | `5m` idle / `15m` stream / Unlim Worker |
| **#6 AWS OpenNext (SST v3)**      | **Mumbai (`ap-south-1`)** · `0.8–1.5 ms` | AWS Lambda (`arm64`) · `1` req/Lambda          | Per-Lambda (`1`)              | `128 MB – 10 GB`         | **❌ `6 MB` Req** / `200 MB` Stream Resp | `900s` (`15m`)                          |
| **#7 Render (`singapore`)**       | Singapore (`sin`) · `45–75 ms`           | Container (`standalone`) · Unlim loop          | **Shared (`10–15`)**          | `512 MB – 512 GB`        | **✅ Unlimited**                         | **`6,000s` (`100m`)**                   |
| **#8 AWS EC2 + Coolify/Kamal**    | **Mumbai (`ap-south-1`)** · `0.8–2.5 ms` | Docker (`m7g.large`) · Unlim loop              | **Shared (`15–20`)**          | `8 GiB – 64 GiB`         | **✅ Unlimited (`Nginx`)**               | **Unlimited**                           |
| **#9 Netlify Pro (`Current`)**    | Singapore (`sin`) · `55–70 ms`           | AWS Lambda (`nodejs22.x`) · `1` req/Lambda     | Per-Lambda (`1`)              | `1,024 MB` (`512 MB` V8) | **❌ `6 MB` Req** / `20 MB` Stream Resp  | `~26–34s` CDN / `60s` Lambda            |
| **#10 Cloudflare Workers**        | 30+ India PoPs · `5–20 ms` (Hyperdrive)  | `workerd` V8 Isolate (**no Linux OS**)         | Hyperdrive (`SET LOCAL` risk) | **`128 MB` HARD WALL**   | `100 MB` (OOMs `128 MB` isolate!)        | `30s–5m` CPU time                       |

---

### 2B. Native Binaries, `after()` Lifecycle, Crons, Previews & 2026 Economics

| Rank & Platform                   | `sharp`, `bcrypt` & `Chromium`                        | Next.js 15 `after()` Behavior         | 27 Sub-Hourly Crons                 | PR Previews (`dev` + PRs)           | Seat Tax                    | Est. Monthly Cost (`Early -> Growth`) |
| :-------------------------------- | :---------------------------------------------------- | :------------------------------------ | :---------------------------------- | :---------------------------------- | :-------------------------- | :------------------------------------ |
| **🥇 #1 GCP Cloud Run**           | **✅ 100% Native Debian** (`apt install chromium`)    | **✅ Native** (`--no-cpu-throttling`) | **✅ Cloud Scheduler (`$0.10/mo`)** | ⚠️ 30-line GHA Tag URLs (`$0` idle) | **`$0 / seat`**             | **`$22–$48/mo` -> `$65–$140/mo`**     |
| **🥈 #2 Vercel Pro (Fluid)**      | ✅ Supported (`<= 4 GB`, `outputFileTracingIncludes`) | ✅ Native (`waitUntil`)               | ✅ Vercel Cron (`* * * * *`)        | **✅ Best 1-Click Native**          | **`$20 / seat / mo`**       | **`$40–$80/mo` -> `$150–$320+/mo`**   |
| **🥉 #3 Fly.io (`bom`, invalid)** | **✅ 100% Native Debian** (`apt install chromium`)    | **✅ True 24/7 Event Loop**           | **✅ `supercronic` (`$0`)**         | ✅ `fly-pr-review-apps` GHA         | **`$0 / seat`**             | **`$27–$45/mo` -> `$60–$110/mo`**     |
| **#4 DigitalOcean App**           | **✅ 100% Native Debian**                             | **✅ True 24/7 Event Loop**           | ✅ App Scheduled Job                | ✅ Native PR Previews               | **`$0 / seat`**             | **`$37–$62/mo` -> `$85–$140/mo`**     |
| **#5 Railway (`sin` Metal)**      | **✅ 100% Native Docker**                             | **✅ True 24/7 Event Loop**           | **✅ Railway Cron (`*/5`)**         | **✅ Best Container Previews**      | `$20 / seat / mo`           | **`$35–$65/mo` -> `$90–$150/mo`**     |
| **#6 AWS OpenNext (SST v3)**      | ✅ Supported (`250 MB` unzipped cap)                  | ⚠️ Freezes when stream ends           | ✅ EventBridge Scheduler            | ❌ Slow (`5–8m` CloudFront)         | **`$0 / seat`**             | **`$10–$25/mo` -> `$40–$85/mo`**      |
| **#7 Render (`singapore`)**       | **✅ 100% Native Docker**                             | **✅ True 24/7 Event Loop**           | ✅ Render Cron (`$1/mo` ticker)     | ✅ Native Blueprints                | **`$25/mo flat` (Unlim)**   | **`$50–$75/mo` -> `$110–$180/mo`**    |
| **#8 AWS EC2 + Coolify/Kamal**    | **✅ 100% Native Docker**                             | **✅ True 24/7 Event Loop**           | **✅ `supercronic` (`$0`)**         | ⚠️ Coolify OK / Kamal DIY           | **`$0 / seat`**             | **`$40–$70/mo` flat**                 |
| **#9 Netlify Pro (`Current`)**    | ⚠️ Tight (`250 MB` unzipped cap)                      | ⚠️ Freezes at response end            | ✅ `cron-tick.mts` (`*/5`)          | ✅ Native Deploy Previews           | **`$20/mo flat` (Unlim)**   | **`$20–$45/mo`**                      |
| **#10 Cloudflare Workers**        | **❌ IMPOSSIBLE (`Error 1102`)**                      | `ctx.waitUntil()` (`30s` max)         | ✅ Cron Triggers                    | ✅ Workers Previews                 | **`$0 / seat` (`$5` base)** | `$5–$25/mo` _(Eliminated)_            |

---

## 3. Weighted Multi-Criteria Scorecard (Out of 100 Points)

Weights reflect our actual runtime bottlenecks (`India / Mumbai DB Latency 20%` · `Codebase Fit [Prisma/Chromium/sharp/Uploads/R2] 25%` · `Small-Team DX & Previews 20%` · `Reliability & Cold Starts 20%` · `2026 Cost & Seat Predictability 15%`):

|   Rank    | Platform                                                           | India Latency (`/20`) | Codebase Fit (`/25`) | Team DX (`/20`) | Reliability (`/20`) | Cost Economics (`/15`) | **Total Score (`/100`)** | Primary Verdict                                                                                                                                                                                                                                                                                                                                |
| :-------: | :----------------------------------------------------------------- | :-------------------: | :------------------: | :-------------: | :-----------------: | :--------------------: | :----------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **🥇 #1** | **Google Cloud Run (`asia-south1` Mumbai) + Cloudflare Free CDN**  |        **19**         |        **24**        |     **16**      |       **20**        |         **14**         |       **93 / 100**       | **Best Overall Engineering Choice**: Tier-1 Mumbai pricing, `1.5–4 ms` DB RTT, `80–250` concurrent requests on warm `pg.Pool(10)`, `min-instances=1` (`--no-cpu-throttling` `$48/mo`), `32 MiB` / unlimited HTTP/2 payloads, `60m` HTTP timeout + `168h` Jobs, native Debian `chromium` + `sharp`, `$0/seat`.                                  |
| **🥈 #2** | **Vercel Pro (`bom1` Mumbai — Fluid Compute)**                     |        **20**         |        **19**        |     **20**      |       **19**        |         **11**         |       **89 / 100**       | **Fastest Zero-DevOps Next.js DX in Mumbai**: Best PR previews and Fluid Compute pooling (`bom1`), **provided** all 8 upload routes (`> 4.5 MB`) + 2 download routes are refactored to Supabase presigned URLs first, `20 GB` R2 streams are offloaded, Turbo builds (`$0.105/min`) are overridden to Enhanced, and `$20/seat/mo` fits budget. |
| **🥉 #3** | **Fly.io (`bom` Mumbai, region not listed) + Cloudflare Free CDN** |        **19**         |        **25**        |     **16**      |       **15**        |         **13**         |       **88 / 100**       | **Best Lightweight Container PaaS in Mumbai**: `2–6 ms` DB RTT, native `50 MB` uploads & unlimited streaming, real Chromium, `supercronic`, `$0/seat`. Run 2 Machines in `bom` for HA.                                                                                                                                                         |
|  **#4**   | **DigitalOcean App Platform (`blr1` Bangalore)**                   |        **17**         |        **24**        |     **18**      |       **16**        |         **12**         |       **87 / 100**       | **Simplest Zero-Ops Container PaaS Inside India (`blr1`)**: `12–25 ms` DB RTT, native PR previews, `50 MB` uploads (`600s` timeout), background workers, `$0/seat`.                                                                                                                                                                            |
|  **#5**   | **Railway (`ap-southeast-1` Singapore Metal)**                     |        **12**         |        **25**        |     **20**      |       **18**        |         **12**         |       **87 / 100**       | **Best Pure Container DX & Instant PR Previews**, zero payload limits — penalized only by Singapore `~45–65 ms` RTT to Mumbai Supabase.                                                                                                                                                                                                        |
|  **#6**   | **AWS OpenNext / SST v3 (`ap-south-1` Mumbai)**                    |        **20**         |        **20**        |     **11**      |       **17**        |         **15**         |       **83 / 100**       | Sub-2ms DB RTT & lowest raw AWS cost, penalized by 8 AWS resources per PR environment (`5–8 min` CloudFront deploys), `1` req/Lambda (`PG_POOL_MAX=1`), and `6 MB` payload cap.                                                                                                                                                                |
|  **#7**   | **Render (`singapore`)**                                           |        **12**         |        **25**        |     **18**      |       **16**        |         **11**         |       **82 / 100**       | `100-minute` request timeout + `$25/mo` unlimited seats, penalized by Singapore `~50–75 ms` DB RTT.                                                                                                                                                                                                                                            |
|  **#8**   | **AWS EC2 Graviton (`m7g.large`) + Coolify/Kamal (`ap-south-1`)**  |        **20**         |        **25**        |     **10**      |       **12**        |         **14**         |       **81 / 100**       | Fastest raw hardware & sub-1.5ms RTT, penalized by single-node failure domain and self-managed OS/build server maintenance.                                                                                                                                                                                                                    |
|  **#9**   | **Netlify Pro (`sin` — Current Live Baseline / Standby Host)**     |        **11**         |        **15**        |     **18**      |       **14**        |         **14**         |       **72 / 100**       | Healthy post-`#1972` (`0.97–1.90s` cold bursts, `$20/mo` unlimited seats). Ideal **Hot-Standby / Emergency Failback Host** while primary production moves to Mumbai (`Cloud Run`, `Vercel Pro`, or `Fly.io`).                                                                                                                                  |
|  **#10**  | **Cloudflare Workers + `@opennextjs/cloudflare` (`bom`)**          |        **18**         |        **4**         |     **12**      |       **11**        |         **15**         |       **60 / 100**       | **Hard Disqualified (`Error 1102`)**: Non-configurable `128 MB` isolate memory wall + no native C++ addons (`sharp`, `bcrypt`) + no Linux ELF Chromium (`250 MB` unpacked).                                                                                                                                                                    |

---

## 4. Platform-Specific Engineering Notes

### 4.1 Cloud Run (`asia-south1`) Critical Flags & Existing GCP Project (`familiarise`)

- **Zero New Cloud Account Needed**: Familiarise already operates GCP project **`familiarise` (`384845845365`)** with active billing and `gcloud` CLI configured ([google-cloud.md](./google-cloud.md)). Enabling `run.googleapis.com` and `cloudscheduler.googleapis.com` inside `familiarise` (`asia-south1`) requires zero vendor onboarding.
- Always deploy `prod` with **`--min-instances=1 --no-cpu-throttling --concurrency=80 --memory=2Gi --cpu=1 --timeout=3600`** in `asia-south1`.
  - Without `--no-cpu-throttling`, Cloud Run throttles container CPU to ~0 upon `res.end()`, stalling Next.js 15 `after()` callbacks and idle `pg.Pool` heartbeats. With `--no-cpu-throttling` (`$0.000018/vCPU-s`, 25% cheaper than request-active CPU), `prod` runs warm 24/7 in Mumbai for `~$48–$55/mo`.
- Deploy `dev` (`dev.familiarisenow.com`) and per-PR revision tags with **`--cpu-throttling --min-instances=0`** (`$0.00/hr` when idle).
- Front `/_next/static/*`, `/_next/image*`, `/avif/*`, and `/fonts/*` with **Cloudflare DNS/CDN (`Cache-Control: public, max-age=31536000, immutable`)** so `sharp` processes each asset once globally at `$0` image CDN cost.

### 4.2 Vercel Pro (`bom1`) Mandatory Prerequisites (If Selected)

- Complete all **P0 Blockers in Issue #2095** _before_ cutting over traffic:
  1. Presigned direct browser uploads (`createSignedUploadUrl`) on all 8 upload routes (`5–50 MB`) + `302` signed URL redirects on the 2 buffered download proxy routes (`10 MB`) to clear Vercel's unconfigurable `4.5 MB` cap.
  2. Platform-scoped client IP trust (`lib/request-ip.ts`), `Vary: Cookie` on `/api/user/consultants/[id]`, `VERCEL_BRANCH_URL` / `VERCEL_URL` preview auth & WebAuthn origin wiring, and `@vercel/functions` `attachDatabasePool(pool)` (`PG_POOL_MAX=5..10`).
  3. Override default **Turbo (`30 vCPU / 60 GB`, `$0.105/min`)** build containers to **Enhanced (`8 vCPU / 16 GB`, `$0.028/min`)** + set `$50/mo` Spend Management cap.

### 4.3 Hosted job runtimes are not hosting candidates (measured 2026-10-31)

The scorecard ranks places to run the web tier. Hosted job services were also measured, and none of them is a place to run it. The table gives the median `SELECT 1` round trip to the Mumbai Supabase pooler from each Trigger.dev Cloud region, next to the Netlify figure that the rest of this document uses.

| Compute                                |                       Median round trip to `ap-south-1` |
| :------------------------------------- | ------------------------------------------------------: |
| Netlify Pro (`sin`), raw `pg` measured | 62–64 ms (about 95 ms measured earlier through the app) |
| Trigger.dev Cloud `eu-central-1`       |                                            about 125 ms |
| Trigger.dev Cloud `us-east-1`          |                                            about 185 ms |
| Trigger.dev Cloud `us-west-2`          |                                            about 232 ms |

Trigger.dev offered no Asian region to the account tested. Inngest runs no compute: it calls a route we host. A Vercel `bom1` function measured 1.0–2.1 ms. See [Background-job runtime options](../maintenance/14-background-job-runtime-options.md) for the method, the diagrams and the static-IP check, and [the experiment index](../maintenance/experiments/2026-10-31-job-runtime/README.md) for the raw reports.

---

## Deprecated & Superseded Approaches

- **AWS App Runner**: Closed to new AWS customers on `2026-04-30`; superseded by AWS ECS Express Mode / Fargate or Google Cloud Run (`asia-south1`).
- **AWS Amplify Hosting Gen 2**: Rejected due to unconfigurable `30s` CloudFront SSR origin timeout and `220 MB` compute artifact limit on our 606-route codebase.
- **Rewriting Next.js App Router Monolith to Java Spring Boot (`ADR 32`)**: Rejected — cold JVM startup (`4–12s` without warm containers/GraalVM) is slower than our tuned Next.js Node 22 boot (`0.97s`), while rewriting 606 RSC/API routes, Prisma, and BetterAuth costs 3–6 engineer-months for zero runtime gain over running `output: "standalone"` on warm Mumbai containers.
- **Cloudflare Workers (`@opennextjs/cloudflare`) for Full Monolith SSR**: Rejected due to hard `128 MB` isolate memory cap (`Error 1102`) under concurrent Prisma WASM + RSC hydration and incompatibility with native `sharp`, `bcrypt`, and headless Chromium.
