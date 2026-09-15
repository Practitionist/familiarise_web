---
title: Hosting for a burst-sensitive Next.js app
band: 70-design-decisions
audience: sde3
status: proposed
last-reviewed: 2026-09-15
---

# ADR 32 — Hosting for a burst-sensitive Next.js app

## Context

The application runs as a single Netlify server handler (`@netlify/plugin-nextjs` 5.15, Node 22, 1024 MB, region `sin`) in front of a Supabase Postgres project in Mumbai. Its warm performance is unremarkable in the good sense: the 2026-09-12 production logs record a p50 of 219 ms across 67 warm invocations. Its cold performance has two regimes, and the difference between them is the whole problem.

A brand-new instance created **on its own** serves a full database-backed page in 1.8–2.7 s — a normal serverless cold start. A brand-new instance created **while other new instances are being created** stalls for roughly 24 s before any application code runs: the diagnostic route in #1124 recorded `process.uptime()` of about 3.3 s at handler entry with its own module already evaluated, and then watched an idle timer loop (`await new Promise(r => setTimeout(r, 50))`) fail to fire for ~24 s. Twelve-request bursts against a fresh deploy land 11 of 12 requests at 27–39 s. Doubling memory and vCPU to 2048 MB made the burst worse (11 of 12 at 35.9–37.6 s plus a platform 500) and was reverted; lazy SDK initialisation (#1221) changed nothing; the pattern reproduced on the published production deployment on 2026-09-13 with only three concurrent requests.

The 2026-09-15 research pass (`docs/perf/2026-09-15-cold-start-research.md`) checked every lever the application controls and found each either already applied or ruled out as the cause: Prisma runs the WASM query compiler with the `pg` driver adapter (no native engine binary in the bundle), Sentry initialises inside the ~3 s pre-stall window, the 68.8 MB handler evaluates in under two seconds when created alone, the pooler handshake completes in ~330 ms once an instance is unstuck, `serverExternalPackages` and `outputFileTracingExcludes` are already set, and 119 of the 124 dashboard segments already stream a skeleton through `loading.tsx`. Netlify's changelog and the runtime adapter's issue tracker carry nothing that matches a concurrency-triggered stall. Partial Prerendering and `"use cache"` require a Next.js 16 upgrade and could not mask a stall that happens before any code runs.

The stall lands on exactly the requests a launch depends on: the token fetch that joins a video call, checkout, and cancellation (Sentry 3N, 1P, 20). Fourteen Sentry issues in the two weeks to 2026-09-15 were this one mechanism wearing different clothes, and they were ignored-until-escalating on that date because no code change can close them.

## Options

1. **Stay on Netlify and ask.** Send the support ticket drafted at `docs/perf/netlify-stall-ticket-draft.md`, reframed as a report of an undocumented pattern with isolation evidence, and wait. Cost: nothing. Risk: the closest forum thread shows Netlify staff's first response to a smaller anomaly was to doubt it was a cold start at all; launch-day experience would depend on their queue.
2. **Vercel Fluid Compute.** The one hosted-serverless model that documents serving many concurrent requests on one warm instance with per-request error isolation, plus bytecode caching and production pre-warming, a Mumbai region (`bom1`, not the default), and `maxDuration` up to 800 s on Pro. It removes the mechanism rather than working around it, and it retires two ledger groups at once: the one-connection-per-instance model behind `PG_POOL_MAX=1`, and the ~26 s edge inactivity cliff. Cost: $20 per seat plus usage (the numbers are in `.claude/skills/deployment/netlify/hosting-alternatives.md`). Migration surface, already inventoried: the five-minute ticker (`netlify/functions/cron-tick.mts` → Vercel Cron), one background function (→ a long-`maxDuration` function or QStash), `netlify.toml` headers and redirects (→ `vercel.json`), per-context environment values (→ Vercel environments), deploy previews (equivalent), and DNS (an A/CNAME change; the zone is Netlify DNS today, GoDaddy is only the registrar).
3. **An always-on host** (Fly, Railway, Fargate; $6–33 per month). Removes cold starts outright and puts the process in Mumbai, at the cost of running our own deploy pipeline and preview environments.

## Decision

Proposed, pending the second of two measurements. The decision rule was fixed before either ran so the numbers, not the mood on the day, decide it: **if the bare route stalls on Netlify and the same burst does not stall on Vercel, migrate to Vercel in a scheduled two-to-three-day window before the MVP launch, and send the Netlify ticket regardless for the record.** If the bare route had not stalled, the application would have been back under suspicion and the on-Netlify plan in the research document worked first.

- **The isolation probe (PR #1656) ran on 2026-09-15 and the bare route stalled.** Across four twelve-request bursts alternating a route that imports nothing from the application with one that imports its full module graph, every brand-new instance sat idle for 26 s (bare) or 23 s (full) after its module was evaluated, and uptime at handler entry plus the gap came to 27–29 s on all of them — the application's module evaluation is subtracted from a fixed window, not added to the response. Warm instances were held up to 34 s before dispatch while new instances were being created, and sustained bursts produced edge timeouts at 37.9 s. The application is exonerated for the stall; the mechanism is the platform's instance creation under concurrency (`docs/perf/2026-09-15-cold-start-isolation-results.md`).
- **The Vercel branch-deploy measurement** (`docs/perf/vercel-experiment-runbook.md`) — the same burst against the same commit on Fluid Compute in `bom1` — is the remaining input. If it shows no stall, this ADR moves to `live` with option 2 as the decision.

The Netlify ticket goes out now with the probe's tables attached, whatever the Vercel result, because a documented vendor answer is worth having.

## Consequences

Nothing in the application changes for this decision except the hosting adapter surface listed under option 2, all of which is already isolated in `netlify/`, `netlify.toml`, and the environment-variable contexts. The money doctrine is unaffected: writes are transactional and swept, so a stall costs a user's patience, never their payment. What a migration would change is the assumptions two ADRs were written under — ADR 14 (no broker) and ADR 27 (the five-minute ticker) both reasoned from one request per instance and a 26 s ceiling — and both should be re-read, not rewritten, if option 2 is taken; their conclusions probably survive, their premises do not.

Whatever the outcome, the method is reusable: measure sequential and concurrent cold starts separately, instrument the idle phase after module evaluation, and isolate the platform from the application with a zero-import route before touching bundle size, engines, or memory. That method is recorded in the portable skill so it is not re-derived at the next company.

## Sources

`docs/perf/2026-09-15-cold-start-research.md`; `docs/perf/2026-09-15-cold-start-isolation-results.md`; `.claude/skills/deployment/netlify/platform-limits.md`; `.claude/skills/deployment/netlify/hosting-alternatives.md`; `.claude/skills/deployment/netlify/issue-ledger.md`; issue #1124; ADR 14; ADR 27; Vercel Fluid Compute documentation (https://vercel.com/docs/fluid-compute).
