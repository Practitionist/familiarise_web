---
title: "Mumbai hosting, phase 1: costed comparison"
type: explanation
---

# Mumbai hosting, phase 1: costed comparison

This page was moved from a GitHub issue into the docs on 2026-10-31. It is research evidence, not a decision. The owner decisions are in [Ticker through launch, the scale path, the phase 2 queue and the database plan](../decisions/2026-10-31-ticker-scale-path-and-queue.md) and in the [architecture at scale review](../decisions/2026-10-30-architecture-at-scale-review.md); where this page disagrees with them, they win. The labels VERIFIED (read on a primary source), UNVERIFIED (no primary source was read) and ESTIMATE (arithmetic from stated assumptions) are kept from the source.

**Measurement note (added 2026-10-31).** Every "95 ms per statement" on this page is the Prisma-level figure from the ticker decision record. A later probe with raw `pg` from Netlify Singapore measured 62–64 ms, and a Vercel `bom1` function measured 1.0–2.1 ms. See [Background-job runtime options](../maintenance/14-background-job-runtime-options.md).

Date: 2026-10-31. Research only, no code changes, no sign-ups. Scratch file (temp/ is not committed).

Phase 1 = a web tier plus an always-on worker process, both in Mumbai next to the Supabase `ap-south-1` database. Netlify stays as a hot standby (traffic restored in under 90 s; see `docs/deployment/emergency-failback-runbook.md`).

## 0. Sources, FX and honesty labels

- FX: USD to INR = **95.29** (open.er-api.com, `https://open.er-api.com/v6/latest/USD`, provider last update 2026-10-30 00:02 UTC; fetched 2026-10-31). Use as indicative only; the vendor's invoice rate or RBI reference rate governs.
- Labels: **VERIFIED** = read from the vendor's official page on 2026-10-31. **UNVERIFIED** = third-party page, memory, or an official page whose table did not render in my fetcher. Every price is USD per month, excluding GST, unless stated.
- The brief named `docs/decisions/2026-10-30-architecture-at-scale-review.md`. That file does not exist in the repo; its text is a comment on issue #2466, which I read together with #2095 and `docs/deployment/README.md`. Facts used from there (MEASURED by that review): functions run in Singapore, about 95 ms per statement to Mumbai, `PG_POOL_MAX=1`, 65 ticker targets of 76 jobs on a 5-minute ticker (9 to 10 targets per tick), about 200 requests per second and 200 to 600 in-flight Lambdas at 1,000 concurrent users, Supabase on the Free plan.
- Existing in-repo scoring (`docs/deployment/multi-platform-evaluation.md`) already ranks Cloud Run 93, Vercel 89, Fly 88, DigitalOcean 87, Railway 87, AWS OpenNext 83, Render 82. Its dollar figures are not sourced, so this file re-derives them.

### Sizing assumptions (stated so they can be challenged)

- Instance = 1 vCPU / 2 GB (the brief said 1 to 2 GB; 2 GB is safer for Next 15 plus Prisma plus `sharp`). A 1 GB instance saves about 10 to 20 percent.
- Launch: about 100 concurrent users, 1 web instance plus 1 worker. Second web instance for HA is shown separately.
- 1,000 concurrent users: about 200 requests per second peak (the review's figure). With the database 2 to 5 ms away instead of 95 ms, a request holds its connection roughly 20 times less long, so one 1-vCPU Node instance should serve roughly 40 to 60 requests per second (my estimate, not measured). That gives **4 to 6 web instances at peak, about 4.5 averaged over a month**, plus **2 workers** (ticker slices run in parallel; one for the ticker, one for Stream copy and payout batches). Treat as UNVERIFIED until a load test.
- Egress: launch about 150 GB per month, 1,000 users about 1.5 TB per month, with Cloudflare Free in front of static assets and images. Without a CDN, double it.
- Always-on billing is assumed for web (Next 15 `after()` and pool heartbeats need CPU after the response is sent) and for the worker.

## 1. Summary table

Compute only (web plus worker), then egress shown separately. "Launch" excludes the optional HA second web instance.

| #   | Option (Mumbai?)                                                             | Launch $/mo (INR)                                                                        | 1,000 users $/mo                  | Egress price                                                     | DB RTT (est.)                                | Docker               | INR / GST billing                                                                                                         | Ops load              | Netlify failback fit |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------- | -------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------- |
| 1   | Google Cloud Run `asia-south1` (Mumbai, **VERIFIED region**; Tier 2 pricing) | about 130 (about Rs 12,400)                                                              | about 340 to 540, midpoint 440    | $0.12/GiB first TiB to Asia (UNVERIFIED, 2024 notice)            | 2 to 6 ms (cross-cloud, UNVERIFIED)          | Yes                  | Yes: INR billing and 18% GST from Google Cloud India for Indian billing addresses (UNVERIFIED for Cloud Run specifically) | Low (managed)         | High                 |
| 2   | Fly.io `bom` (Mumbai, region still exists)                                   | about 46 to 60 (about Rs 4,400 to 5,700)                                                 | about 190 to 250                  | India $0.12/GB (VERIFIED, ambiguous grouping)                    | 2 to 6 ms (cross-cloud)                      | Yes                  | USD only; GST handling UNVERIFIED                                                                                         | Low to medium         | High                 |
| 3a  | Railway                                                                      | about 80                                                                                 | about 280                         | $0.05/GB                                                         | **No India region** (Singapore ~95 ms again) | Yes                  | USD                                                                                                                       | Low                   | n/a                  |
| 3b  | Render                                                                       | UNVERIFIED (repo doc: 50 to 75)                                                          | UNVERIFIED                        | UNVERIFIED                                                       | **No India region** (Singapore)              | Yes                  | USD                                                                                                                       | Low                   | n/a                  |
| 4a  | AWS ECS Fargate `ap-south-1`                                                 | about 100 incl. ALB (about Rs 9,500)                                                     | about 280                         | about $0.11/GB after 100 GB free (UNVERIFIED)                    | **1 to 2 ms (same region as DB)**            | Yes                  | INR and GST via AWS India (UNVERIFIED)                                                                                    | Medium to high        | High                 |
| 4b  | AWS Lightsail Mumbai (2 GB instances)                                        | about 24 (about Rs 2,300)                                                                | about 100 to 130 (manual scaling) | 1.5 TB per 2 GB instance included in Mumbai                      | 1 to 2 ms                                    | Yes (you run Docker) | as 4a                                                                                                                     | Medium (self-patched) | High                 |
| 4c  | AWS App Runner                                                               | n/a: official page lists only Virginia, Ohio, Oregon, Ireland, Tokyo (Mumbai not listed) | n/a                               | n/a                                                              | n/a                                          | Yes                  | n/a                                                                                                                       | n/a                   | n/a                  |
| 5   | Vercel Fluid `bom1` + worker elsewhere                                       | about 160 to 190 incl. a Rs 1,100 worker                                                 | about 900 to 1,500                | Fast Data Transfer $0.20/GB, origin $0.25/GB (VERIFIED)          | 2 to 6 ms                                    | Not needed (native)  | USD; GST added by Vercel (VERIFIED: "GST ... added where required")                                                       | Lowest                | Medium (see 5)       |
| 6a  | DigitalOcean `blr1` Droplets                                                 | about 36 to 48 (about Rs 3,400 to 4,600)                                                 | about 170 to 200                  | pooled 2 to 5 TB included; overage unlisted on page (UNVERIFIED) | 12 to 25 ms (repo estimate, UNVERIFIED)      | Yes                  | USD                                                                                                                       | Medium                | High                 |
| 6b  | E2E Networks (Indian vendor)                                                 | about Rs 1,800 to 2,000 for two 2 vCPU nodes (about $19 to 21) + 18% GST (UNVERIFIED)    | about Rs 6,000 to 9,000           | UNVERIFIED                                                       | UNVERIFIED (DC city to confirm)              | Yes                  | **Native INR + GST invoice**                                                                                              | Medium to high        | High                 |
| 6c  | Hetzner                                                                      | **No India location** (VERIFIED: Nuremberg, Falkenstein, Helsinki, US, Singapore)        | n/a                               | n/a                                                              | n/a                                          | n/a                  | n/a                                                                                                                       | n/a                   | n/a                  |

Reading the table: the only real choice is between **containers in Mumbai (1, 2, 4, 6)** and Vercel (5). Railway, Render and Hetzner fail the "co-located in Mumbai" requirement outright, so phase 1 gains nothing from them.

## 2. Per-option notes

### 1. Google Cloud Run, `asia-south1`

- **Pricing page**: https://cloud.google.com/run/pricing (checked 2026-10-31). The page body did not render in my fetcher (only the title came back), so the per-second rates below are **UNVERIFIED**. Search results place Mumbai (`asia-south1`) under **Tier 2** pricing, with the instance-based free tier of 240,000 vCPU-seconds and 450,000 GiB-seconds per month. Tier 1 instance-based is about $0.000018 per vCPU-second and $0.000002 per GiB-second; Tier 2 appears to be about 20 percent higher ($0.0000216 and $0.0000024, my inference). The in-repo doc used the Tier 1 number.
- **Math (Tier 2, instance-based, 730 h = 2.628M s)**: 1 vCPU / 2 GiB = 2.628M x (0.0000216 + 2 x 0.0000024) = **about $69 per instance**. Web + worker = $138, minus about $6 of free tier = **about $132**. Using Tier 1 rates it would be about $110. A second web instance for HA adds $69. 1,000 users: 4.5 web x $69 = $310, + 2 workers $138 = about $450 (range 340 to 540 for 3.5 to 6 web instances).
- **Cheaper worker**: Cloud Run offers worker pools for non-HTTP always-on processes at a lower rate (UNVERIFIED; check the page). A scheduled Cloud Run Job per ticker slice is not suitable because the ticker already fits a long-lived loop.
- **Egress**: Premium Tier to Asia $0.12/GiB for 0 to 1 TiB, $0.11 for 1 to 10 TiB (Google's pricing announcement, https://cloud.google.com/vpc/pricing-announce; dated Feb 2024, so UNVERIFIED as current; the network pricing page itself did not render). Launch about $18, 1,000 users about $180 before CDN.
- **Cold start**: min instances = 1 removes it for the web tier; a scale-out instance still pays Node/Next boot (about 1 to 3 s, UNVERIFIED). Use `--no-cpu-throttling` (instance-based) so `after()` and the Prisma pool keep CPU.
- **Docker**: yes; `Dockerfile.prod` exists (multi-stage, `npm start`, port 3000, `/api/health`). Not the standalone output; image would be large but works.
- **TLS and domain**: managed certificate via domain mapping, or a global external load balancer (extra cost). Because `familiarisenow.com` is on Netlify DNS today, the plan in `docs/deployment/README.md` is to move authoritative DNS to Cloudflare first; Cloudflare in front gives free TLS and CDN.
- **GST/INR**: Google Cloud India bills Indian addresses in INR with 18 percent GST; a GSTIN on the billing account enables input credit and a local e-invoice (https://docs.cloud.google.com/billing/docs/resources/vat-overview and https://support.google.com/cloud/answer/7523059). Older USD accounts may not be convertible; the project `familiarise` (384845845365) exists, so check its billing currency (open question).
- **Static egress IP** (RazorpayX needs allowlisted IPs, see memory note): needs Direct VPC egress plus Cloud NAT with a reserved IP; roughly $30+ per month (UNVERIFIED).
- **Next features**: ISR, `after()`, middleware all work under `next start`. **Caveat for every container option with more than one instance**: ISR and the data cache live on each instance's disk, so `revalidateTag`/`revalidatePath` only invalidates the instance that ran it. The repo has revalidate calls in 6 files and no `cacheHandler` in `next.config.mjs`. At more than one web instance a shared cache handler (Redis) is needed. This is a launch blocker for the 1,000-user shape on every container option.
- **Failback fit**: strongest; already the repo's documented target (`docs/deployment/google-cloud.md`). Fleet switch is the existing `ops:active_cron_platform` key.

### 2. Fly.io `bom`

- **Pricing page**: https://docs.fly.io/about/pricing (VERIFIED 2026-10-31, but prices shown are for Ashburn/Secaucus; the regional table did not render, so `bom` machine prices are **UNVERIFIED** and could be higher).
- Compute (US rates): shared-cpu-1x 1 GB $6.70; performance-1x 2 GB $33.00; RAM add-on $6/GB per month. Web = performance-1x 2 GB $33; worker = shared-cpu-1x + 1 GB RAM = $12.70. **Launch about $46**, about $60 allowing a Mumbai surcharge. HA second web machine +$33. 1,000 users: 4 to 6 performance-1x ($132 to 198) + 2 workers ($25) = **$160 to 225**, say 190 to 250 with a surcharge.
- **Egress**: $0.04/GB for Asia Pacific, but **$0.12/GB for India** (the page groups India with Africa; it does not name `bom` explicitly). At 1.5 TB per month that is about $180, which erases Fly's compute advantage. Mitigate with Cloudflare cache. Inbound free. Dedicated IPv4 $2; shared IPv4 and IPv6 free.
- **Region still exists**: the region consolidation post lists Mumbai (bom) as kept (https://fly.io/blog/the-region-consolidation-project/). Third-party trackers show minor `bom` incidents in May 2026 (capacity and networking); no official status page was read (UNVERIFIED health).
- Cold start: machines can stay running (min 1); autostart from stopped is sub-second to a few seconds (UNVERIFIED). Real always-on VMs, so `after()` and the worker are natural.
- Docker: native. TLS: automatic Let's Encrypt for custom domains. Support: community free, Standard $29/month if wanted.
- GST/INR: bills USD by card; GST/reverse-charge handling not documented on the page (UNVERIFIED). Static egress IP is a paid add-on (price UNVERIFIED).
- Failback: good (same pattern as Cloud Run; repo already trusts `fly-client-ip` only when `FLY_APP_NAME` is set).

### 3. Railway and Render

- **Railway has no India region**: only US West, US East, EU West (Amsterdam), Southeast Asia (Singapore) (https://docs.railway.com/reference/regions, VERIFIED 2026-10-31). Pricing (https://docs.railway.com/reference/pricing/plans, VERIFIED): Hobby $5, Pro $20 (each includes that much usage), RAM $10/GB-month, CPU $20/vCPU-month, egress $0.05/GB. 1 vCPU / 2 GB = $40; two = $80; 1,000 users 7 services = $280. Singapore puts the database back at about 95 ms, so it does not meet the phase 1 goal.
- **Render has no India region**: Oregon, Ohio, Virginia, Frankfurt, Singapore (https://render.com/docs/regions, VERIFIED). Its pricing tables did not render (UNVERIFIED; the repo doc estimates $50 to 75). Same Singapore problem.
- Verdict: eliminate both for phase 1. They would only be useful as a Singapore-or-worse standby.

### 4. AWS `ap-south-1`

- **Same region as the Supabase database** (Supabase `ap-south-1` is on AWS), so the lowest possible DB latency (about 1 to 2 ms, UNVERIFIED but physically plausible).
- **Fargate**: official page (https://aws.amazon.com/fargate/pricing/) did not render Mumbai rows. Third-party (GeeksforGeeks, Mar 2025) gives Mumbai x86 at $0.04256 per vCPU-hour and $0.004655 per GB-hour (**UNVERIFIED**). 1 vCPU / 2 GB = $37.9 per task; two tasks $76; with an ALB (about $20, UNVERIFIED) about **$96 to 100**. 1,000 users: 4.5 web + 2 workers = 6.5 x $37.9 = $246 + ALB $30 = about **$280**. Fargate is the cheapest managed-container option at scale here. Fargate Spot not suitable for web.
- **Egress**: 100 GB/month free, then tiered; Mumbai rate not on the page (UNVERIFIED, memory says about $0.11/GB).
- **App Runner**: official page (https://aws.amazon.com/apprunner/pricing/) lists only US East (N. Virginia and Ohio), US West (Oregon), Europe (Ireland) and Tokyo; Mumbai not listed. Treat as unavailable until confirmed.
- **Lightsail** (https://aws.amazon.com/lightsail/pricing/, VERIFIED): 2 GB / 2 vCPU $12, 4 GB / 2 vCPU $24, 8 GB $44; Mumbai gets **half the transfer allowance** (about 1.5 TB for the 2 GB plan). Two 2 GB instances (web + worker) = **$24**. Cheapest AWS shape; you run Docker, TLS (Caddy/Traefik), and patching yourself. Lightsail load balancer extra (UNVERIFIED about $18).
- **TLS**: ACM free with ALB. **GST/INR**: AWS India (AISPL) invoices INR with GST (UNVERIFIED here).
- **Ops**: highest of the managed options (VPC, ALB, ECS task definitions, ECR, IAM, NAT if private subnets; NAT gateway is about $33+ and a classic hidden cost, UNVERIFIED). Static egress IP is natural with NAT or an Elastic IP.
- Repo evaluation gave AWS OpenNext/SST 83; that is the Lambda shape and keeps `PG_POOL_MAX=1`, so it is not the container shape costed here.

### 5. Vercel Fluid compute, `bom1`

- **VERIFIED prices** (https://vercel.com/docs/pricing/regional-pricing/bom1, page dated 2026-09-14): Active CPU $0.14/hour; Provisioned Memory $0.0116/GB-hour; Fast Data Transfer $0.20/GB; Fast Origin Transfer $0.25/GB; CDN requests $2.20 per million; ISR reads $0.44/M, writes $4.40/M; Image Optimization transformations $0.0527/1K. Pro seat $20/month (https://vercel.com/docs/pricing); Pro includes a monthly usage credit (amount not on the fetched page, UNVERIFIED). Static IPs add-on $100/month per project plus transfer.
- **Launch estimate (UNVERIFIED model)**: 8M requests/month at 120 ms active CPU = 267 CPU-hours x 0.14 = $37; memory about 1.5 instance-equivalents x 2 GB x 730 h x 0.0116 = $25; CDN requests $18; transfer 150 GB x ($0.20 + 0.25) = $68 worst case; seat $20; minus credit. About **$140 to 170**, plus a small worker (below) = **$160 to 190**. Cost is usage-linear, so 1,000 users (about 10x) lands near **$900 to 1,500**; this is the weakest scaling option. Flat Rate CDN may change the CDN lines.
- **Cold start**: Fluid compute reuses warm instances and bytecode caching; no min-instance control I verified (UNVERIFIED).
- **Worker**: a Vercel function cannot be an always-on process (instances pause when idle, per the Fluid compute page). Vercel docs mention Docker and background workers and Vercel Queues (beta); not verified for this repo, so assume the worker lives elsewhere: **Fly `bom` shared-cpu 2 GB (about $13)**, a Lightsail Mumbai 2 GB ($12), or an E2E node (about Rs 900). That worker would call the same `/api/cleanup/[job]` registry or run it in-process.
- **Next features**: best native support for ISR, `after()` (`waitUntil`), middleware. Needs the 8 upload routes over 4.5 MB moved to Supabase presigned URLs (already an invariant in `docs/deployment/README.md`).
- **GST/INR**: prices in USD; taxes are added by billing address (VERIFIED note on the page); no INR invoicing stated.
- **Failback**: medium. Issue #2095 already contains a long cutover RFC. Costs most, and Vercel-specific features (Fluid pool attachment, `x-vercel-forwarded-for`) are already handled by the dual-boot rules.

### 6. Plain VPS in India

- **DigitalOcean `blr1`** (https://www.digitalocean.com/pricing/droplets, VERIFIED 2026-10-31): Basic 1 vCPU / 2 GB $12 (2 TB transfer), 2 vCPU / 2 GB $18, 2 vCPU / 4 GB $24 (4 TB), 4 vCPU / 8 GB $48 (5 TB). Page says DigitalOcean has a Bangalore data centre but does not list plans per region (UNVERIFIED stock). Launch: web 2 vCPU / 4 GB $24 + worker 1 vCPU / 2 GB $12 = **$36**; with a spare web droplet $48. 1,000 users: 3 x $48 + 2 x $12 + load balancer (about $12, UNVERIFIED) = about **$180**. Transfer is pooled and generous; overage rate not on the page. App Platform alternative: Bangalore appears in the API's region list (UNVERIFIED), 1 vCPU / 2 GiB $25, overage $0.02/GiB (https://www.digitalocean.com/pricing/app-platform, VERIFIED), so two containers are $50.
- **Latency caveat**: Bangalore to Mumbai is not same-city. The repo's evaluation assumed 12 to 25 ms (UNVERIFIED, measure it). A dashboard with 40 statements at 15 ms is 0.6 s, which is 6x better than today but still 5 to 10x worse than Mumbai-resident options. This is the main reason DO ranks below Cloud Run/Fly/AWS for this app.
- **E2E Networks** (Indian listed company; https://www.e2enetworks.com/pricing; the page returned 403 to my fetcher): a third-party 2026 guide quotes about Rs 880 per month for 2 vCPU / 4 GB effective 2026-07-01, and a search snippet of the official feed shows a 2 vCPU / 6 GB plan at about Rs 894. Both **UNVERIFIED**; add 18 percent GST (~Rs 1,050 each with GST). Two nodes about Rs 2,100 per month (about $22). Native INR/GST invoices, Indian entity for DPDP (relevant to the `compliance` skill). Data-centre city (Delhi NCR vs Mumbai) and egress policy must be confirmed before anything.
- **Other Indian providers** appeared in search (Utho with four Indian locations; Inservers in Delhi) but I did not verify pricing or SLAs; treat as UNVERIFIED leads only.
- **Hetzner**: no India location. VERIFIED via https://docs.hetzner.com/cloud/general/locations/ (Germany, Finland, US, Singapore). Eliminated.
- Ops: you own OS patching, Docker, TLS, deploys (Kamal, Coolify or plain compose; `docker-compose.prod.yml` exists), backups of nothing (stateless), and monitoring. Static IP is native (RazorpayX allowlist solved for free). Single VPS is a SPOF, which Netlify standby covers by design.

## 3. Cross-cutting findings

- **Region proof**: today's 95 ms per statement comes from Singapore. Any option in Mumbai or Bangalore removes most of it; only Mumbai-resident options (1, 2, 4, 5) get to single-digit milliseconds. Nobody has measured these RTTs from the target hosts; a 10-minute `SELECT 1` loop from a trial instance on the shortlisted host would settle it, but that needs a sign-up, so it is deferred.
- **Pool size**: all container options share `PG_POOL_MAX=5..10` per instance, which at 5 instances is 25 to 50 backends. The Supabase Free plan has 60 direct connections and 200 pooler clients (per the #2466 review), so the database plan upgrade is a precondition for phase 1 regardless of host.
- **RazorpayX static IPs**: web and worker on a host with a stable egress IP removes the need for a proxy (memory note: decision F1 chose a proxy because Netlify has none). Cloud Run needs NAT (about $30+/month, UNVERIFIED); a VPS or Lightsail has it free; Vercel charges $100/month (VERIFIED); Fly offers a paid static egress IP (price UNVERIFIED).
- **Worker scheduling**: the current ticker is a Netlify scheduled function. The worker needs its own 5-minute loop that reads `ops:active_cron_platform` and dispatches the same registry; the failback runbook already says this adapter must be built and drilled. No host choice removes that work.
- **Egress**: the egress line is where Fly (India $0.12/GB) and GCP ($0.12/GiB) are the same and AWS/DO/Lightsail are much cheaper or bundled. Put Cloudflare Free in front for static assets and images on any option.
- **GST**: Indian vendors (E2E) and Indian subsidiaries (Google Cloud India, AWS India) issue GST invoices with input credit; Fly, DO, Vercel, Railway, Render bill USD by card and tax handling needs checking with finance.

## 4. Recommendation

**Default: Google Cloud Run `asia-south1`, instance-based billing, min instances 1 for web, with the always-on worker as a second Cloud Run service (or worker pool) in the same region.**
Why: it is the repo's documented target and already has a GCP project (`familiarise`), it needs the least ops, it keeps Docker parity with `Dockerfile.prod`, it can autoscale to the 4 to 6 instances needed at 1,000 users without hand work, it bills in INR with GST for an Indian billing account (input credit with GSTIN), and its failback fit with Netlify is strongest. Cost: about **$130 per month (about Rs 12,400) at launch**, about **$450 at 1,000 users**. Add a Redis-backed Next cache handler before running more than one web instance.

**Alternate A (cheaper, still managed): Fly.io `bom`**, about $46 to 60 per month at launch and $190 to 250 at 1,000 users, with true always-on VMs for the worker. Watch the $0.12/GB India egress and the unverified `bom` prices. Choose it if the owner prioritises cost over INR/GST invoicing.

**Alternate B (cheapest, lowest DB latency, more ops): AWS Lightsail Mumbai for the worker (and optionally the web tier at launch)**, $12 per 2 GB instance in the same region as the database, a static IP that solves the RazorpayX allowlist, but self-patched. A hybrid also works: Cloud Run web plus a $12 Lightsail (or Rs 900 E2E) worker, which saves about $57 per month versus a second Cloud Run instance and gives the worker a static egress IP.

Not recommended for phase 1: Vercel (cost scales linearly with usage, about 3x the container cost at 1,000 users, and still needs a separate worker), Railway and Render (no India region), Hetzner (no India), DigitalOcean (Bangalore latency).

## 5. Open questions for the owner

1. Is `familiarise` GCP billing account INR with a GSTIN attached, or USD? An older USD account cannot be converted.
2. Is a roughly $130 per month always-on bill acceptable for launch, versus about $50 on Fly or about $36 on a VPS? What is the monthly infra budget ceiling?
3. Must the worker have a static egress IP (RazorpayX payouts and fund-account validation)? If yes, prefer a VPS or Lightsail worker over paying for Cloud NAT or a proxy.
4. Is Google/AWS (US-owned) acceptable for DPDP processor purposes, or is an Indian-entity host (E2E, Utho) preferred? This affects the compliance processor inventory.
5. Who owns the move of DNS from Netlify DNS to Cloudflare (a prerequisite per `docs/deployment/README.md`), and who runs the failback drill?
6. Is the Supabase plan upgrade (off Free) already budgeted? Connection ceilings, not hosting, are the first thing to break.
7. Approve a 30-minute RTT test (trial instance on the shortlisted host running `SELECT 1` against the pooler) before committing? It needs a vendor sign-up, so I did not run it.
8. Should the Redis-backed Next cache handler (for ISR/tag revalidation across instances) be scoped into phase 1?

## Deprecated & Superseded Approaches

This research does not supersede an implemented approach. The options it compares are unadopted alternatives, including the Redis-backed Next.js cache handler. The earlier phase 1 plan to move web and worker to a Mumbai container was rejected on cost by the owner; see the ticker decision record.
