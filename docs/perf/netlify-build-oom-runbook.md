# Netlify build OOM runbook (exit 137 / heap-limit)

Date: 2026-09-23. Status: mitigations landed on `feat/support-help-center`, awaiting green deploy.

## The one-paragraph version

The app has ~334 statically generated pages and Netlify's standard build box has
8 GB of RAM. The build now needs roughly all of it, so it dies of memory
starvation. There are **two different deaths** with two different fixes, and
mixing them up cost us a round trip (see chronology). None of the mitigations
affect how fast the shipped site feels — they only change how many pages the
build cooks at once.

## The two deaths — learn to tell them apart

| Signal in the log | Killer | Meaning | Fix direction |
|---|---|---|---|
| `Killed`, exit 137, dies mid `Generating static pages (N/M)`, no stack trace | Linux OOM killer on container RSS | Whole-box memory exhausted | Use LESS at once: fewer workers, fewer pages, less retained per page |
| `FATAL ERROR: Reached heap limit`, `Abounded`/exit 2, JS stack trace, dies in `Creating an optimized production build` | V8 heap limit | One Node process exceeded its heap cap | RAISE the heap cap (or shrink what compile loads) |

Rule of thumb: **137 = lower the parallelism; heap-limit = raise the cap.**
They point in opposite directions. Getting this backwards fails the build the
other way — proven below.

## Why this happens here

- `next build` has two memory-hungry phases: **compile** (webpack bundles the
  app in the parent process, honors `NODE_OPTIONS --max-old-space-size`) and
  **static generation** (prerenders every static route).
- Static generation runs on **two levels of parallelism**: L1 = worker
  processes (`experimental.cpus`, default 4) × L2 = pages in flight per worker
  (`experimental.staticGenerationMaxConcurrency`, default 8). Worst case was
  4×8 = **32 pages in flight**, each loading the full server bundle and —
  for DB-touching routes — opening its own Prisma pool.
- Critical gotcha (vercel/next.js#95744): prerender workers spawn with
  `isolatedMemory`, which **strips `--max-old-space-size`**. The heap flag in
  `netlify.toml` never bound the workers that were dying; they run uncapped.
  It only governs the parent/compile phase.
- Growth, not a cliff: 282 prerendered pages passed; ~334 (after #1795's ~50
  support URLs) did not. GitHub CI (bigger runners) always passed — only the
  8 GB Netlify box fails.

## Knobs that exist (all verified against next@15.5.15)

| Knob | Scope | Effect |
|---|---|---|
| `NODE_OPTIONS=--max-old-space-size` (`netlify.toml`) | Parent/compile only | Raise for heap-limit deaths; lowering starves compile |
| `experimental.staticGenerationMaxConcurrency` | Static phase, per worker | Fewer pages in flight per worker |
| `experimental.cpus` | Compile AND static (`getNumberOfWorkers`) | Fewer worker processes overall |
| `experimental.enablePrerenderSourceMaps: false` | Static phase | Drops source-map retention during prerender (Next memory guide) |
| `widenClientFileUpload: false` (Sentry, #1792) | Finalize phase | Skips holding full client source-map set in memory |
| `webpackMemoryOptimizations: true` | Compile | Already on |
| On-demand ISR (no `generateStaticParams` + `revalidate`) | Build total | Page skips build-time prerender; generated on first request, then cached. Crawler-safe on the Netlify v5 plugin (blocking render, sitemap-listed). Repo precedent: `explore/experts/[consultantId]`, `explore/enterprise/organisations/[orgSlug]` |

## Chronology (#1795)

1. Deploy preview OOM'd: exit 137 at static page 166/334.
2. Applied: `staticGenerationMaxConcurrency: 4` (Netlify only) + on-demand ISR
   for all 49 support URLs (index stays static). Sound first steps, insufficient
   alone.
3. Wrong move: heap 6144 → 4096. Next build died EARLIER with `Reached heap
   limit` in compile — the flag binds compile, which needs >4 GB.
4. Reverted heap to 6144 with the corrected comment.
5. Applied: `enablePrerenderSourceMaps: false` (Netlify only).
6. Applied: `cpus: 1` + `staticGenerationMaxConcurrency: 2` (Netlify only) →
   worst case 1×2 = 2 pages in flight. Build time explicitly traded; it does
   not touch runtime performance.

## If it OOMs again, in order

1. Confirm the phase from the log (table above) before changing anything.
2. Static-phase 137 again → the driver is cumulative per-page retention, not
   concurrency. Next rung: the **Prisma prerender diet** — slimmer build-time
   queries, shared connections during prerender (`PG_POOL_MAX=1` at build),
   minimal `select`s. Permanent headroom that also helps runtime.
3. Extend on-demand ISR to the heaviest DB-backed routes (needs revalidate
   purges on writes + post-deploy warming; deploys invalidate the cache).
4. Escape hatch, not a fix: bigger builder (Netlify Pro 11 GB) or build on GH
   Actions and ship the artifact. Masks growth; page count keeps climbing.
5. Hard guardrail: Netlify also enforces a build *time* limit. If serial builds
   approach it, raise `maxConcurrency` before touching anything else.

## References

- vercel/next.js#95744, #95745, #97464 (worker heap-flag stripping, RSS vs heap)
- vercel/next.js#71439 (Prisma pool exhaustion → concurrency cap as official fix)
- vercel/next.js#82577 (constrained-container OOM while CI passes — our analogue)
- getsentry/sentry-javascript#13836 (Sentry upload memory — our #1792 fix)
- Next docs: `staticGeneration*` config, memory-usage guide, ISR guide
- Netlify: 8 GiB/3 CPU standard builders; plugin v5 ISR support
- Repo: `netlify.toml` (annotated), `next.config.mjs` (`experimental` block),
  `.claude/skills/nextjs-netlify-serverless-gotchas/`, `docs/perf/vercel-experiment-runbook.md`
