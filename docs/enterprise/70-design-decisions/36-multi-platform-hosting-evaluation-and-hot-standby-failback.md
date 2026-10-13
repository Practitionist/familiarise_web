---
title: Multi-platform hosting scorecard and hot-standby Netlify failback posture
band: 70-design-decisions
audience: sde3
status: accepted
last-reviewed: 2026-10-11
---

# ADR 36 — Multi-platform hosting scorecard and hot-standby Netlify failback posture

## Context

Following PR `#1972` ([ADR 32](32-hosting-for-a-burst-sensitive-nextjs-app.md)), disabling Next.js 15's default eager route preloading (`experimental.preloadEntriesOnStart: false` and `appDocumentPreloading: false`) eliminated Netlify's cold-start burst `504` outage (`31.5 s` -> `0.97–1.90 s` across 12 cold instances). However, three physical limits of Netlify Pro (`sin`, Singapore) remain structural:

1. **Cross-ocean SQL round-trip penalty (`55–70 ms` RTT)**: Netlify offers no Mumbai (`ap-south-1`) runtime region, adding `~60 ms` per sequential Prisma query to our Supabase Postgres database in `ap-south-1`.
2. **Single-request Lambda concurrency (`PG_POOL_MAX=1`)**: Each simultaneous request spins up an isolated microVM instead of multiplexing concurrent I/O waits across one shared warm connection pool (`PG_POOL_MAX=10..15`).
3. **Edge & payload caps**: Non-streaming Route Handlers hit an unconfigurable `~26–34 s` CDN inactivity timeout (`60 s` hard Lambda ceiling), binary payloads cap at `6 MB` (`~4.5 MB` framed), builds sit inside an `8 GB` cgroup limit (`exit 137`), and Background Functions are silently skipped on `deploy-preview` and `dev`.

Evaluating all ten candidate hosting platforms against our 606-route Next.js 15 App Router codebase (`Prisma 7 + pg`, `sharp`, `bcrypt`, `@react-pdf/renderer` Devanagari fonts, `@sparticuz/chromium`, `50 MB` file uploads, `20 GB` R2 stream transfers, and 27 phase-staggered sub-hourly crons) also revealed two opposite traps:

- **Vercel Pro (`bom1` Mumbai)** is not automatically `#1`: while Fluid Compute in `bom1` provides sub-4ms Mumbai DB RTT and best-in-class 1-click previews, Vercel enforces an unconfigurable **`4.5 MB` request/response body cap** (breaking 8 upload routes + 2 buffered download proxies unless moved to presigned URLs), ignores `Netlify-Vary` (risking public cache poisoning on `/api/user/consultants/[id]`), does not strip spoofed `x-nf-client-connection-ip` headers (enabling a 100% rate-limit bypass unless IP headers are scoped by runtime), bills `$20/seat/month`, and defaults to `$0.105/min` Turbo build containers (#2095).
- **Cloudflare Workers (`@opennextjs/cloudflare`)** is hard-disqualified (`Error 1102`) due to its non-configurable `128 MB` isolate memory wall across concurrent Prisma WASM + RSC hydration and inability to run native C++ addons (`sharp`, `bcrypt`) or Linux ELF headless Chromium binaries (`250 MB` unpacked).
- Finally, naively migrating away from Netlify without designing hot-standby rollback triggers Day-90 Let's Encrypt HTTP-01 TLS expiry under `Strict-Transport-Security: preload` (`NET::ERR_CERT_DATE_INVALID`) and dual `cron-tick.mts` split-brain execution (#2097).

## Decision

1. **Multi-Platform Ranking (#2096)**: Adopt **Google Cloud Run (`asia-south1` Mumbai — `93/100`)** fronted by Cloudflare DNS/CDN (`--min-instances=1 --no-cpu-throttling --concurrency=80 --memory=2Gi` on `prod` at `~$48/mo`, `min-instances=0` on `dev`/previews, `1.5–4 ms` Mumbai DB RTT, `32 MiB` / unlimited HTTP/2 payloads, `60 min` HTTP timeout + `168 h` Cloud Run Jobs, `$0/seat`) as our **#1 recommended long-term Mumbai production runtime**, with **Vercel Pro (`bom1` Fluid Compute — `89/100`)** as **#2** (zero-DevOps option if presigned upload & security pre-work in #2095 is completed first) and **Fly.io (`bom` Mumbai — `88/100`)** as **#3**.
2. **Universal Dual-Boot Codebase & Presigned Upload Prerequisites**: Before cutting traffic over to any Mumbai platform (`Platform X`), land the six host-agnostic portability invariants in [docs/deployment/README.md](../../deployment/README.md) (`createSignedUploadUrl` presigned browser uploads + `302` signed download redirects, platform-scoped `lib/request-ip.ts`, `Vary: Cookie` alongside `Netlify-Vary`, env-gated `NEXT_STANDALONE` & `sharp` exclusion, per-host `PG_POOL_MAX`, and Upstash REST key `ops:active_cron_platform`).
3. **Hot-Standby Netlify Failback (`< 90s` RTO, Zero Code Reverts — #2097)**: Decouple registrar nameservers to **Cloudflare DNS** at least `72 hours` before cutover, retain `netlify.toml` and `netlify/functions/cron-tick.mts` so every `prod` and `dev` commit auto-builds on both `Platform X` and standby `Netlify` (`familiarise.netlify.app`), prevent Day-90 standby TLS expiry via automated ACME `DNS-01` renewal (`POST /api/v1/sites/${NETLIFY_SITE_ID}/ssl`) or Cloudflare `Orange-Cloud Full (strict)` Origin CA certificates, and mute standby crons dynamically via `ops:active_cron_platform` in Upstash Redis (`< 1 ms` failback switch).

## Alternatives Considered

- **Cloudflare Workers (`@opennextjs/cloudflare` — `60/100`)**: Rejected for the monolith SSR app due to the non-configurable `128 MB` isolate memory limit, lack of native C++ addons (`sharp`, `bcrypt`), and inability to run headless Chromium (`@sparticuz/chromium`). Retained strictly for CDN routing, R2 object storage, and isolated edge workers.
- **Railway (`sin` — `87/100`) & Render (`singapore` — `82/100`)**: Excellent persistent container DX and native previews, but lack an Indian region (`45–75 ms` cross-ocean RTT to Mumbai Supabase on every query).
- **DigitalOcean App Platform (`blr1` Bangalore — `87/100`)**: Strong zero-ops Indian container contender (`12–25 ms` DB RTT, `$0/seat`), ranked just behind Mumbai-native Cloud Run / Vercel / Fly due to `100 s` synchronous HTTP response timeout vs Cloud Run's `3,600 s`.
- **AWS OpenNext / SST v3 (`ap-south-1` — `83/100`)**: Sub-2ms DB RTT and lowest unit compute cost, but rejected for small-team velocity due to provisioning 8+ distributed AWS services per PR stage (`5–8 min` CloudFront deploys), `1` req/Lambda (`PG_POOL_MAX=1`), and `6 MB` upload limits.
- **Destructive Single-Vendor Migration (Deleting `netlify.toml` / `cron-tick.mts`)**: Rejected — turns any P0 platform incident into a multi-PR git revert + 12-minute cold build outage instead of a `< 90s` DNS + Redis switch.

## Consequences

1. Every deployment environment change preserves dual-boot compatibility across `Cloud Run`, `Vercel Pro`, `Fly.io`, and standby `Netlify` (`docs/deployment/emergency-failback-runbook.md`).
2. Moving uploads/downloads `> 4 MB` to Supabase Storage presigned URLs eliminates request/response size bottlenecks permanently across every cloud provider.
3. Engineering can execute a live 5-minute GameDay cutover and rollback between `Platform X` and standby `Netlify` with zero user sign-outs (`__Secure-better-auth.session_token`) and zero dropped webhooks (`WebhookEvent` CAS fencing).

## Sources

`docs/deployment/README.md`; `docs/deployment/multi-platform-evaluation.md`; `docs/deployment/emergency-failback-runbook.md`; `docs/deployment/netlify.md`; issues #2095, #2096, #2097; ADR 32.
