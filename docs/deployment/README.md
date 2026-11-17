# Familiarise Deployment & Hosting Architecture

> Canonical deployment documentation for `Practitionist/familiarise_web`.
> See also: [ADR 32](../enterprise/70-design-decisions/32-hosting-for-a-burst-sensitive-nextjs-app.md) and [ADR 36](../enterprise/70-design-decisions/36-multi-platform-hosting-evaluation-and-hot-standby-failback.md).

---

## Reading Order & Canonical Guides

| Guide                                                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                | When to Read                                                                                                                        |
| :------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| **[multi-platform-evaluation.md](./multi-platform-evaluation.md)**         | Ranked 10-platform engineering evaluation (`Google Cloud Run asia-south1` **93/100**, `Vercel Pro bom1` **89/100**, `Fly.io bom` **88/100**, `DigitalOcean blr1` **87/100**, `Railway sin` **87/100**, `AWS OpenNext ap-south-1` **83/100**, `Render singapore` **82/100**, `EC2 Coolify/Kamal` **81/100**, `Netlify Pro sin` **72/100**, `Cloudflare Workers` **60/100 Eliminated**). | Selecting or reviewing production/staging compute, comparing Mumbai DB latency vs Singapore, or sizing containers/serverless pools. |
| **[netlify-vs-vercel-product-map.md](./netlify-vs-vercel-product-map.md)** | Netlify, Vercel and Cloudflare products layer by layer, how they map onto each other, and the measured facts (function limits, Fluid compute, cron limits, Workflows, region latency) from the 2026-10-31 experiments.                                                                                                                                                                 | Comparing hosts, or when a product name such as "ticker", "Background Functions" or "Workflows" is unclear.                         |
| **[emergency-failback-runbook.md](./emergency-failback-runbook.md)**       | Standby readiness, traffic restoration objective, implemented fleet preference, in-flight worker limits, and the recovery checks required before and after a host handoff.                                                                                                                                                                                                             | Before migrating traffic off Netlify, during a P0 host incident, or when executing the mandatory pre-cutover GameDay drill.         |
| **[netlify.md](./netlify.md)**                                             | Complete production operating manual for the live Netlify Pro host (`familiarise`, `sin` Singapore): env contexts, `netlify.toml`, `next.config.mjs` cold-start & build OOM fixes (`#932`, `#1792`, `#1972`), `cron-tick.mts`, and CLI/MCP recipes.                                                                                                                                    | Operating live Netlify deployments today, maintaining standby Netlify readiness, or debugging build/function limits.                |
| **[db-split-plan.md](./db-split-plan.md)**                                 | Plan (not done) for separating the preview and dev database from production: a second Supabase project versus Supabase branching, costs, ordered steps, per-context environment changes, verification and rollback.                                                                                                                                                                    | Before the Supabase Pro upgrade, or when asking why previews still share production's database.                                     |
| **[google-cloud.md](./google-cloud.md)**                                   | GCP project reference (`project_id = familiarise`, `384845845365`), Google OAuth (`familiarise-web-client`) callback URIs, and `gcloud` CLI setup — shared directly when deploying Cloud Run (`asia-south1`).                                                                                                                                                                          | Configuring OAuth redirect URIs across `prod` / `dev` / previews or provisioning Cloud Run / Cloud Scheduler in GCP `familiarise`.  |

---

## Core Multi-Host Portability Invariants ("Dual-Boot Codebase Rules")

Netlify is the current verified compute host. Every commit merged to `dev` and `prod` must preserve compatibility with Netlify and a future active Mumbai host. A prebuilt hot standby and the `< 90s` traffic restoration objective require deployment and drill evidence; configuration in this repository alone does not prove either:

1. **Authoritative DNS Decoupled on Cloudflare (`T - 72h` Rule, planned)**:
   - Today `familiarisenow.com` uses Netlify DNS (see [Domains and DNS records](#domains-and-dns-records)), whose `NETLIFY` pseudo-records only work while Netlify hosts the site. Before any traffic cutover to another host, authoritative nameservers must move to neutral **Cloudflare DNS**.
   - Never delete custom domains (`familiarisenow.com`, `www.familiarisenow.com`, `familiarise.in`, `dev.familiarisenow.com`) from standby Netlify (`Domain management`).
2. **Edge-Resolved, Middleware-Stamped Client IP (`lib/request-ip.ts`)**:
   - Edge middleware resolves the visitor's IP once with `edgeClientIp`. On Vercel (`process.env.VERCEL === "1"`) it reads `x-vercel-forwarded-for`, and on Fly (`process.env.FLY_APP_NAME` set) it reads `fly-client-ip`. Everywhere else it takes the rightmost `x-forwarded-for` hop, which the platform proxy appends. On Netlify the middleware runs as an edge function, where Netlify adds no client-IP header (`x-nf-client-connection-ip` is absent) and Next does not expose `context.ip`; the rightmost hop was measured to be the real visitor even when the client forges `x-forwarded-for`.
   - Middleware overwrites `x-familiarise-client-ip` with that IP on every request it forwards. Route handlers (`getClientIp`), Better Auth's `ipAddressHeaders` and the sign-in throttle read **only** that header. Behind the middleware, a Node function's own `x-forwarded-for` names the edge function's egress address, which is the same for every visitor, so it must never key a limit.
   - The stamp is trustworthy only on paths the middleware matcher covers. The matcher covers all of `/api` and every page path without a dot, so a new IP reader must live on one of those paths. Unknown `/api` paths stay inside it too: they reach the JSON 404 catch-all `app/api/[...notFound]/route.ts`, never the HTML not-found page.
   - Before sending traffic to a new host, make a few anonymous requests to a rate-limited route and read the Upstash `rl:*` keys: they must show the visitor's address, not `unknown_ip` or a constant infrastructure address.
3. **Standard `Vary: Cookie` Alongside `Netlify-Vary`**:
   - Any public cacheable API route whose response varies by authentication state (e.g., `/api/user/consultants/[id]`) must return `Cache-Control: private, no-store` when a session cookie is present and include standard `Vary: Cookie, Accept-Encoding` alongside `Netlify-Vary` on anonymous responses so non-Netlify CDNs never serve anonymous cached payloads to signed-in users.
4. **Conditional `output: "standalone"` & Native `sharp` Tracing (`next.config.mjs`)**:
   - Enable `output: "standalone"` strictly via `process.env.NEXT_STANDALONE === "true"`.
   - Exclude `"node_modules/sharp/**"` and `"node_modules/@img/**"` in `outputFileTracingExcludes` **only** when `process.env.NETLIFY === "true" || process.env.VERCEL === "1"` so Docker containers (`Cloud Run`, `Fly.io`, `DigitalOcean`, `Railway`, `Render`) retain in-process `sharp` image optimization.
5. **Direct Browser Presigned Storage Uploads (`> 4 MB`) & Signed Redirect Downloads**:
   - Never buffer binary file uploads `> 4 MB` (`request.formData()`) or file downloads `> 4 MB` inside Next.js Route Handlers (breaks Vercel's unconfigurable `4.5 MB` cap and Netlify/AWS Lambda's `6 MB` sync payload cap). Issue scoped Supabase Storage `createSignedUploadUrl` tokens and `302` redirects to `createSignedUrl`.
6. **Runtime Fleet Scheduler Preference (`ops:active_cron_platform`)**:
   - Netlify reads the Upstash REST key once per five-minute tick with a one-second timeout. A different string skips dispatch; an absent or unreadable value fails open. The preference needs no rebuild, but does not start a tick, cancel in-flight work or guarantee exclusivity during Redis failure. A future host must implement and verify its own adapter before cutover; `/api/cron/tick` is not an existing shared endpoint. See the failback runbook for handoff and verification.

---

## Domains and DNS records

This is the one inventory of domains, registrars, nameservers and mail records. Other docs link here instead of copying it. It was changed and verified on 2026-10-28 through the Netlify DNS API, and checked with `dig` against `dns1.p06.nsone.net`.

| Domain               | Registrar (expires)  | Nameservers                                                   | Mail                                                  |
| :------------------- | :------------------- | :------------------------------------------------------------ | :---------------------------------------------------- |
| `familiarisenow.com` | GoDaddy (2027-01-13) | Netlify DNS (NS1: `dns1.p06.nsone.net`, `dns2.p06.nsone.net`) | Send-only through Resend. Receives no mail (null MX). |
| `practitionist.com`  | GoDaddy (2027-02-02) | GoDaddy DNS (`domaincontrol.com`)                             | Two GoDaddy-hosted mailboxes, including `connect@`.   |

The registrar only holds the registration and the nameserver delegation. For `familiarisenow.com`, every record is edited in the Netlify zone, never in GoDaddy.

### `familiarisenow.com` zone (Netlify DNS)

| Host                              | Type    | Value                                                          | Purpose                                                                                   |
| :-------------------------------- | :------ | :------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| `@`, `www`, `dev`, `*` (wildcard) | NETLIFY | `familiarise.netlify.app`                                      | Production site, `www`, the dev branch deploy and any other subdomain.                    |
| `@`                               | TXT     | `v=spf1 -all`                                                  | No server may send mail as the bare domain, so a spoofed `@familiarisenow.com` fails SPF. |
| `@`                               | MX      | `0 .` (null MX, RFC 7505)                                      | States that the domain accepts no mail, so senders stop retrying.                         |
| `_dmarc`                          | TXT     | `v=DMARC1; p=none; rua=mailto:connect@practitionist.com; fo=1` | Monitor-only policy. Aggregate reports go to the one live mailbox.                        |
| `resend._domainkey.<sub>`         | TXT     | Resend DKIM public key                                         | Signs mail from `<sub>`.                                                                  |
| `send.<sub>`                      | MX      | `10 feedback-smtp.ap-northeast-1.amazonses.com`                | Return-Path bounce handling.                                                              |
| `send.<sub>`                      | TXT     | `v=spf1 include:amazonses.com ~all`                            | SPF for the envelope sender.                                                              |
| `rsend.<sub>`                     | CNAME   | `send.forge.rmta.net`                                          | Resend tracking host.                                                                     |

`<sub>` is `mail` (transactional) or `news` (newsletter). Both are verified in Resend region `ap-northeast-1` with sending on and receiving off, and all four records per subdomain are live.

Because `familiarisenow.com` has no mailbox, every human-facing address resolves to `connect@practitionist.com` through `SUPPORT_EMAIL` in `lib/company.ts`. The `practitionist.com` apex `A` record points at Netlify's load balancer `75.2.60.5`. Its mail records are `secureserver.net` MX, SPF `include:secureserver.net -all`, and a DMARC record at `p=none` with no `rua`.

### DMARC rollout

The policy stays at `p=none` for about two weeks while the aggregate reports are read, then moves to `quarantine`, then to `reject`. Moving it is a single TXT edit in the Netlify zone.

### Owner to-do (manual, no GoDaddy API key exists)

- Add TXT `familiarisenow.com._report._dmarc` with value `v=DMARC1` in the `practitionist.com` zone at GoDaddy. Without it, receivers may refuse to send `familiarisenow.com`'s DMARC reports to a mailbox on another domain.
- Confirm auto-renew is on for both domains.

### Pre-launch mail hold

`EMAIL_ALLOWLIST` in the Netlify context `all` includes `connect@practitionist.com`, so support and compliance mail to the one mailbox is delivered while `EMAIL_DELIVERY_MODE` is not `live` (see `docs/email/README.md` section 5). Changing a value held in context `all` needs a full PUT with `netlify api updateEnvVar`, because `setEnvVarValue` answers 422.

---

## Database connections and pooling

This section explains, in plain terms, how the app reaches Postgres and which limits apply.

- **A connection** is one open network session between a program and the Postgres server. Each connection uses memory on the database server, so Postgres allows only a fixed number at once. Supabase's Free plan allows 60 direct connections.
- **The Prisma client pool** is the small set of connections one running copy of the app keeps open and reuses. `PG_POOL_MAX` sets its size. On Netlify each function instance serves one request at a time, so `PG_POOL_MAX=1`: one connection per instance. Hosts that serve many requests in one process (Cloud Run, Vercel Fluid, Fly) use a larger pool. Size it as a fleet budget: the maximum instance count × `PG_POOL_MAX` must stay below the pooler's client limit with headroom, and the setting is load-tested before moving hosts.
- **Many instances at once.** Under load Netlify starts many function instances in parallel. The ticker's fan-out alone starts up to ten at once, and each opens its own connection. Without help, 100 busy instances would need 100 Postgres connections and exceed the plan's limit. Through the pooler they become 100 pooler clients, a separate and larger limit from the database's own connections.
- **The pooler (Supavisor)** is Supabase's connection pooler. It sits between the app and Postgres. The app connects to the pooler through `DATABASE_URL`, and the pooler lends a real Postgres connection to each transaction only while it runs, then takes it back. So many app connections ("pooler clients", 200 on the Free plan) share a much smaller set of real Postgres connections.
- **The direct connection** (`DIRECT_URL`) bypasses the pooler. `prisma.config.ts` binds the Prisma CLI to it. CI runs `prisma db push` against a throwaway database, and the scheduled drift check runs a read-only `prisma migrate diff` against the shared database. Only an operator writes the shared schema; no deployment workflow runs `prisma migrate deploy`.
- **Why one slow query hurts everyone.** Each statement costs about 95 ms of network round trip measured through the app (62–64 ms with raw `pg`) from the function region to the database region. With `PG_POOL_MAX=1`, an instance runs its statements one after another. A request that issues many statements holds its pooler client longer, and when every pooler client is busy, new requests wait and then time out.

**Measured round trips from hosted job runtimes (2026-10-31).** A hosted job service that runs our code is farther from the database than Netlify, not closer. Trigger.dev Cloud offers only `eu-central-1`, `us-east-1` and `us-west-2`, and the median round trip to the Mumbai pooler measured about 125 ms, about 185 ms and about 232 ms respectively, against 62–64 ms (raw `pg`; about 95 ms measured earlier through the app) from Netlify in Singapore. An unset region lands in `us-east-1`. Inngest does not host compute: it calls a route we serve, so the Netlify figure applies. The method and caveats are in [Background-job runtime options](../maintenance/14-background-job-runtime-options.md).

**Plan decision (2026-10-30).** The project stays on Supabase Free while the database holds only mock data. Move to **Pro with Micro compute** before real customers onboard: Free has no backups and no SLA. Move to Small compute when sustained concurrent users approach 150. The first limit expected to break under load is the database path (pooler clients and per-statement round trips), not the cron ticker. Previews, dev and production share this one database today; the separate preview and dev database waits for the Pro upgrade and real customers ([db-split-plan.md](./db-split-plan.md)), and the staged load test waits for it ([load test plan](../enterprise/50-operations/11-load-test-plan.md)). Until then previews refuse every background job and skip the production-only writes (see the [decision record](../decisions/2026-10-31-ticker-scale-path-and-queue.md)).

## Deprecated & Superseded Approaches

- **Personal-inbox DMARC reports and an unpublished root SPF**: before 2026-10-28 the DMARC `rua` pointed at a personal Gmail that never authorised external reports, and the apex had no SPF or MX. Superseded by the records in the table above; do not reintroduce a personal address as a report target.
- **Single-Vendor Host Lock-In via Destructive Migration PRs**: Deleting `netlify.toml`, `netlify/functions/cron-tick.mts`, or Netlify environment variable support when adopting a secondary platform forces multi-PR git reverts and 12-minute rebuilds during an outage. Superseded by the Dual-Boot Codebase Pattern above.
- **Proxying Multi-Megabyte Binary Uploads Through Serverless Route Handlers**: Buffering `5–50 MB` multipart uploads in `app/api/**` fails with `413 Payload Too Large` on Vercel (`4.5 MB` hard cap) and Netlify/Lambda (`6 MB` cap). Superseded by direct client-to-Supabase Storage presigned uploads (`createSignedUploadUrl`).
- **Deploying the Monolith to V8 Isolate Runtimes (`@opennextjs/cloudflare` Workers)**: Disqualified due to Cloudflare Workers' non-configurable `128 MB` isolate memory ceiling across concurrent SSR + Prisma WASM executions (`Error 1102`) and inability to load native C++ addons (`sharp`, `bcrypt`) or Linux ELF headless Chromium binaries (`@sparticuz/chromium`).
