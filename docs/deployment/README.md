# Familiarise Deployment & Hosting Architecture

> Canonical deployment documentation for `Practitionist/familiarise_web`.
> See also: [ADR 32](../enterprise/70-design-decisions/32-hosting-for-a-burst-sensitive-nextjs-app.md) and [ADR 36](../enterprise/70-design-decisions/36-multi-platform-hosting-evaluation-and-hot-standby-failback.md).

---

## Reading Order & Canonical Guides

| Guide                                                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                | When to Read                                                                                                                        |
| :------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| **[multi-platform-evaluation.md](./multi-platform-evaluation.md)**   | Ranked 10-platform engineering evaluation (`Google Cloud Run asia-south1` **93/100**, `Vercel Pro bom1` **89/100**, `Fly.io bom` **88/100**, `DigitalOcean blr1` **87/100**, `Railway sin` **87/100**, `AWS OpenNext ap-south-1` **83/100**, `Render singapore` **82/100**, `EC2 Coolify/Kamal` **81/100**, `Netlify Pro sin` **72/100**, `Cloudflare Workers` **60/100 Eliminated**). | Selecting or reviewing production/staging compute, comparing Mumbai DB latency vs Singapore, or sizing containers/serverless pools. |
| **[emergency-failback-runbook.md](./emergency-failback-runbook.md)** | Zero-downtime hot-standby rollback runbook (`Platform X -> Netlify` in `< 90s` RTO with zero git reverts): Cloudflare neutral DNS (`T - 72h`), Day-90 Let's Encrypt HSTS brick mitigation, `< 1ms` Upstash `ops:active_cron_platform` cron switch, and Dual-Boot invariants.                                                                                                           | Before migrating traffic off Netlify, during a P0 host incident, or when executing the mandatory pre-cutover GameDay drill.         |
| **[netlify.md](./netlify.md)**                                       | Complete production operating manual for the live Netlify Pro host (`familiarise`, `sin` Singapore): env contexts, `netlify.toml`, `next.config.mjs` cold-start & build OOM fixes (`#932`, `#1792`, `#1972`), `cron-tick.mts`, and CLI/MCP recipes.                                                                                                                                    | Operating live Netlify deployments today, maintaining standby Netlify readiness, or debugging build/function limits.                |
| **[google-cloud.md](./google-cloud.md)**                             | GCP project reference (`project_id = familiarise`, `384845845365`), Google OAuth (`familiarise-web-client`) callback URIs, and `gcloud` CLI setup — shared directly when deploying Cloud Run (`asia-south1`).                                                                                                                                                                          | Configuring OAuth redirect URIs across `prod` / `dev` / previews or provisioning Cloud Run / Cloud Scheduler in GCP `familiarise`.  |

---

## Core Multi-Host Portability Invariants ("Dual-Boot Codebase Rules")

Every commit merged to `dev` and `prod` must build and run simultaneously on both our **Active Mumbai Compute Host (`Platform X`)** and **Hot-Standby Netlify (`familiarise.netlify.app`)** without reverting code:

1. **Authoritative DNS Decoupled on Cloudflare (`T - 72h` Rule)**:
   - Authoritative nameservers must reside on neutral **Cloudflare DNS**, never coupled to the compute host's proprietary DNS (`ns1.p0*.nsone.net` `NETLIFY` pseudo-records).
   - Never delete custom domains (`familiarisenow.com`, `www.familiarisenow.com`, `familiarise.in`, `dev.familiarisenow.com`) from standby Netlify (`Domain management`).
2. **Platform-Scoped Client IP Header Trust (`lib/request-ip.ts`)**:
   - Trust `x-nf-client-connection-ip` **only** when `process.env.NETLIFY === "true"`. Outside Netlify, external clients can spoof `x-nf-client-connection-ip` to bypass Upstash and BetterAuth rate limits.
   - Trust `x-vercel-forwarded-for` **only** when `process.env.VERCEL === "1"`, `fly-client-ip` **only** when `process.env.FLY_APP_NAME` is set, and `cf-connecting-ip` / rightmost `x-forwarded-for` behind Cloudflare / Cloud Run GFE.
3. **Standard `Vary: Cookie` Alongside `Netlify-Vary`**:
   - Any public cacheable API route whose response varies by authentication state (e.g., `/api/user/consultants/[id]`) must return `Cache-Control: private, no-store` when a session cookie is present and include standard `Vary: Cookie, Accept-Encoding` alongside `Netlify-Vary` on anonymous responses so non-Netlify CDNs never serve anonymous cached payloads to signed-in users.
4. **Conditional `output: "standalone"` & Native `sharp` Tracing (`next.config.mjs`)**:
   - Enable `output: "standalone"` strictly via `process.env.NEXT_STANDALONE === "true"`.
   - Exclude `"node_modules/sharp/**"` and `"node_modules/@img/**"` in `outputFileTracingExcludes` **only** when `process.env.NETLIFY === "true" || process.env.VERCEL === "1"` so Docker containers (`Cloud Run`, `Fly.io`, `DigitalOcean`, `Railway`, `Render`) retain in-process `sharp` image optimization.
5. **Direct Browser Presigned Storage Uploads (`> 4 MB`) & Signed Redirect Downloads**:
   - Never buffer binary file uploads `> 4 MB` (`request.formData()`) or file downloads `> 4 MB` inside Next.js Route Handlers (breaks Vercel's unconfigurable `4.5 MB` cap and Netlify/AWS Lambda's `6 MB` sync payload cap). Issue scoped Supabase Storage `createSignedUploadUrl` tokens and `302` redirects to `createSignedUrl`.
6. **Sub-Millisecond Fleet Cron Switch (`ops:active_cron_platform`)**:
   - Guard scheduled cron entrypoints (`netlify/functions/cron-tick.mts` and `/api/cron/tick`) with Upstash Redis key `ops:active_cron_platform` (`"netlify"` vs `"cloudrun"` / `"vercel"` / `"fly"`) so cron ownership flips across hosts in `< 1 ms` without a 12-minute build.

---

## Deprecated & Superseded Approaches

- **Single-Vendor Host Lock-In via Destructive Migration PRs**: Deleting `netlify.toml`, `netlify/functions/cron-tick.mts`, or Netlify environment variable support when adopting a secondary platform forces multi-PR git reverts and 12-minute rebuilds during an outage. Superseded by the Dual-Boot Codebase Pattern above.
- **Proxying Multi-Megabyte Binary Uploads Through Serverless Route Handlers**: Buffering `5–50 MB` multipart uploads in `app/api/**` fails with `413 Payload Too Large` on Vercel (`4.5 MB` hard cap) and Netlify/Lambda (`6 MB` cap). Superseded by direct client-to-Supabase Storage presigned uploads (`createSignedUploadUrl`).
- **Deploying the Monolith to V8 Isolate Runtimes (`@opennextjs/cloudflare` Workers)**: Disqualified due to Cloudflare Workers' non-configurable `128 MB` isolate memory ceiling across concurrent SSR + Prisma WASM executions (`Error 1102`) and inability to load native C++ addons (`sharp`, `bcrypt`) or Linux ELF headless Chromium binaries (`@sparticuz/chromium`).
