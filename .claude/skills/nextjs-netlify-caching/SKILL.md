---
name: nextjs-netlify-caching
description: Decide and verify how a Next.js App Router route renders, caches and revalidates on Netlify — static vs ISR vs dynamic, revalidate windows, on-demand purge, the Netlify durable cache, and the specific traps that make a route silently dynamic or silently un-server-rendered. Use when adding or changing `export const dynamic` / `export const revalidate` / `generateStaticParams`, when a page is slow or its TTFB/FCP is bad, when SSR output looks empty, when asked "should this be ISR", or before claiming any rendering or caching change actually worked.
---

# Next.js App Router rendering and caching on Netlify

This skill encodes what was measured on this codebase during the 2026-07/08 dashboard-performance campaign, not what the framework documentation promises. Where the two disagree, the measurement is recorded and marked. Version-sensitive facts are pinned to Next 15.5.15 and the Netlify Next Runtime; re-verify them after any major upgrade.

## The rule that outranks everything else in this file

Every confident claim made by reasoning about code structure, without measuring, was wrong at least once during this campaign. Every measured claim held. Green CI is not verification: `tsc`, ESLint and the full Jest suite were all green on a build that failed, on a route that returned 500 on every request, and on three separate changes that moved no metric at all.

Therefore, never report a rendering or caching change as working until you have observed the specific artefact listed under "How to verify" below. If you cannot observe it, say the change is unverified rather than describing what should happen.

## Step 1 — Classify the route before touching anything

Ask what the response depends on, because that determines the strategy and nothing else does.

| The response varies by | Correct strategy | What to export |
|---|---|---|
| Nothing; it is the same for every visitor | Static, or ISR if the content changes | `export const revalidate = N` (omit for fully static) |
| Public data that changes on a human timescale | ISR with a revalidate window | `export const revalidate = N` |
| A high-cardinality or unbounded path parameter over public data | On-demand ISR | `export const revalidate = N` **and** `generateStaticParams()` returning `[]` |
| The signed-in user, their role, their organisation, or their money | Dynamic | `export const dynamic = "force-dynamic"` |

Two corollaries that are easy to get wrong on this codebase.

A page whose data is public but whose *chrome* differs for signed-in visitors is still a static page. The auth-dependent affordance belongs in a client component or a small dynamic island, not in the page's server render. Pulling a session read into the page body to swap one button converts the whole route to dynamic and forfeits the cache.

A route parameter with unbounded cardinality must never be prerendered exhaustively at build. Returning `[]` from `generateStaticParams` means nothing is built ahead of time, each parameter renders on its first request, and the result is then cached and revalidated on the window. Confirm `dynamicParams` is left at its default of `true`, or unlisted parameters will 404 instead of rendering.

## Step 2 — Know what silently pins a route to dynamic

Reading any request-scoped API anywhere in a route's server render tree forces that route dynamic regardless of what it exports. The route will keep rendering as `ƒ` and your `revalidate` will be inert, with no error and no warning. The APIs that do this are `cookies()`, `headers()`, `draftMode()`, `connection()`, and `searchParams`.

The read does not have to be visible in the page file. A shared helper, an auth guard, or a data-layer function three imports deep will do it. Before adding `revalidate` to any route, trace its full server import graph for those five APIs and report what you found per route.

On this codebase specifically, note that an `export const revalidate` on a route that is already dynamic produces an **empty** Revalidate column in the build route table. That empty column is the tell that the export did nothing. It was exactly the defect in the first shape of PR #1110, where the two heaviest reads carried a revalidate that never applied.

## Step 2b — Your `revalidate` is a ceiling, not a setting

A route's effective revalidate is the **minimum** of its segment-level `revalidate` and every data-cache entry read during that render. A short `unstable_cache` window deep in the data layer silently caps the whole route, with no warning.

This was measured on #1110: `/` declared `revalidate = 3600` and the build table reported `2m`, because 120-second `unstable_cache` windows in `lib/data/home.ts` were pulling it down. Raising those windows to match was what made the declared value real. Whenever the build table shows a revalidate you did not ask for, this is the first thing to check.

## Step 2c — Read the route-table symbols precisely

The build table distinguishes three states, and conflating the last two wastes time. `○` means prerendered as static HTML at build. `●` means prerendered as static HTML *using `generateStaticParams`*. `ƒ` means rendered on demand.

A `[param]` route with `generateStaticParams` returning `[]` renders as `●` with an **empty Revalidate column**, and this is correct rather than broken. The Revalidate column is populated from prerendered entries, and returning `[]` deliberately produces none, so a non-empty column there and an empty build-time prerender list are mutually exclusive by construction. Do not chase it.

To confirm ISR really is active on such a route, verify at runtime instead: request it on a deploy preview and check that `cache-control` is `public` rather than the dynamic route's `private, no-cache, no-store`, then request it again and confirm the `age` header climbs. A climbing `age` is one cached object aging, which is the proof; a dynamic control route requested alongside it makes the comparison airtight.

## Step 3 — Understand what build-time prerendering costs here

A route that renders `○` in the build route table executes its Server Component data reads **inside `next build`**. On this project that has three consequences worth stating plainly.

The build must reach Supabase. CI decodes a real `.env` before building, so it does. Issue #932 records a build that crashed on a cold cross-region pooler connect, so this is a demonstrated failure mode rather than a theoretical one.

Every Netlify context — deploy preview, branch deploy and production — shares one Supabase database. Build-time reads therefore touch production data from preview builds. This is a real consequence of choosing prerendering and belongs in any PR description that introduces it.

Worst of all, a swallowed error at build time gets frozen into the output. This codebase's `fallbackOnTransientDbError` returns empty on a transient failure, which is correct at runtime and dangerous at build time, because the empty result is baked into static HTML. The blast radius is bounded by the revalidate window, since ISR regenerates, but a silent empty page is worse than a loud failure.

The guard for this is to rethrow during the build phase, converting a silent bad bake into a visible, retryable build failure:

```ts
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// A swallowed transient error at build time is baked into static HTML. Fail
// loudly instead — a retried build is cheap, a silently empty page is not. #932
if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) throw err;
```

`PHASE_PRODUCTION_BUILD` is verified present in `next/constants` at Next 15.5.15 with the value `phase-production-build`. Import the constant rather than hardcoding the string. Pair the guard with a bounded retry and backoff, because #932 was a *cold* connect and a single retry very likely converts a hard failure into a success.

## Step 4 — Cache headers follow the strategy, and you do not choose them

Next.js sets `Cache-Control` purely from the rendering strategy of each route. You cannot negotiate with this from inside the app.

| Strategy | Header Next.js emits |
|---|---|
| Static, no revalidation | `s-maxage=31536000` |
| ISR, time-based revalidation | `s-maxage={revalidate}, stale-while-revalidate={expire - revalidate}` |
| Dynamic | `private, no-cache, no-store, max-age=0, must-revalidate` |

The third row is the whole argument against `force-dynamic` on public pages: it makes them uncacheable at every CDN by construction, so each visitor pays a full origin round trip. On this deployment that is Netlify `ap-southeast-1` to Supabase `ap-south-1`, and the tail of that round trip was measured at 30–33 seconds. See "What the 23-second TTFB actually decomposes into" below — the cost is the first database connect on a new function instance, not the boot.

The converse is the strongest argument for prerendering public pages: a prerendered page is served as static HTML from the edge with **no function invocation at all**, so it also sidesteps the cold start entirely on the pages where LCP matters most.

## Step 5 — What Netlify adds on top

The Netlify Next Runtime implements Next's cache handler against Netlify Blobs, so both the Full Route Cache and the Data Cache are durable and shared across every function invocation and CDN node rather than being per-instance. Cacheable responses on Runtime 5.5.0 and later automatically use the durable cache, and an edge node without a local copy checks the durable cache before invoking a function. This means `unstable_cache` and ISR results genuinely persist between requests here — do not assume serverless per-instance memory semantics.

When you need to cache a response Next would mark uncacheable, Netlify honours cache-control headers in order of specificity: `Netlify-CDN-Cache-Control` wins over `CDN-Cache-Control`, which wins over `Cache-Control`. Both `s-maxage` and `stale-while-revalidate` are supported, and `Cache-Control` and `CDN-Cache-Control` are always passed downstream so other caches can use them. Function responses are not cached by default precisely because they are dynamic, so caching them is an explicit opt-in via those headers.

For invalidation, `revalidatePath` and `revalidateTag` both work and propagate through the durable cache. A copy cached at the CDN purely by an `s-maxage` header is a different matter: `revalidateTag` invalidates the Next server cache but the CDN keeps serving its copy until the TTL expires, so a raw CDN cache needs `Netlify-Cache-Tag` on the response and a `purgeCache({ tags })` call alongside the revalidation.

Documented adapter limitations worth remembering: pages set to the `edge` runtime actually run in the functions region, `beforeFiles` rewrites cannot point at static files in `public/`, and headers and redirects are evaluated after middleware.

## How to verify — the only four techniques that have worked here

**Read the CI build route table.** This is authoritative for every prerendering question and it settled the #1110 dispute definitively. `○` means prerendered at build; `ƒ` means dynamic; the Revalidate column shows whether a `revalidate` export actually applied. Pull it from the `TypeScript, Tests & Build` check run with `gh run view --log` and paste the actual lines into your report. Never run `next build` locally — it is RAM-heavy and has taken this machine down.

**Stream the HTML and grep for markup that should be present.** Distinguish real markup (`">Members<"`) from the RSC flight payload (the bare string `Members`). If the string appears only in the payload, the content was **not** server-rendered, however much it looks present in the browser. When the bare-string count equals the markup count, there are no payload-only occurrences and the result is genuine.

**A/B two deploy previews.** Same account, same page, exactly one variable changed. This is what finally proved both real wins in this campaign, and what exposed a route returning 500 on every request that CI had called green.

**Warm the function first.** Cold measurements on this deployment span 1.9 s to 33 s on the same route, so any single cold timing is noise. Warm the instance, or take enough cold samples to see the distribution — it is bimodal, not noisy-around-a-mean, and the mean is meaningless.

## Measured facts that keep getting rediscovered

A skeleton cannot fire First Contentful Paint. FCP requires text, an image, canvas or SVG, and a component built purely from `Skeleton` boxes has none of those. Measured on #1102: the shell HTML arrived at 458 ms while FCP still waited about 6 s for real text. If a surface needs an early FCP it must render actual text, not a placeholder for it.

`next/dynamic` with `ssr: false` skips server rendering for the component **and all of its children**. Wrapping `{children}` in such a component removes an entire subtree from the HTML. Its options must also be an inline object literal at each call site, because SWC analyses them statically — hoisting them to a `const` passes `tsc`, ESLint and Jest and then fails the build.

A client layout that returns a skeleton while its queries load returns that skeleton during SSR too, because nothing prefetched those queries on the server. The fix is to seed the query from a server component with `prefetchQuery` plus `dehydrate` and a `HydrationBoundary`. The query key must match the client's `useQuery` key exactly, and a key derived from a client hook such as `useSession()` can never match a server seed — that mismatch is invisible to `tsc` and to every test.

A `loading.tsx` creates an implicit Suspense boundary, which is what allows a layout to flush while its page is still pending.

## The database connection pool holds one client, so parallelising queries wins nothing

`PG_POOL_MAX` is set to **1** on production, deploy preview and branch deploy alike, and `lib/prisma.ts` passes it to `pg.Pool` as `max`. Each function instance therefore holds exactly one client, and concurrent Prisma queries serialise instead of overlapping.

The practical consequence is that wrapping independent Prisma reads in `Promise.all` cannot make anything faster on this deployment. This was measured rather than assumed: across 20 order-balanced interleaved rounds against a real session, the parallelised branch came in at 1,176 ms against 1,142 ms sequential, while anonymous requests were identical on both deployments at 557 and 558 ms, ruling out a deployment-level offset. The change was reverted inside the PR that introduced it.

Check `PG_POOL_MAX` before proposing any "these queries are independent, parallelise them" optimisation anywhere in this codebase. The idea is dead until the pool is widened, and widening it is a capacity question about Supabase pooler limits across concurrent function instances rather than a config tweak. It is tracked as issue #1117.

This also reframes the wave-depth measurements. The finding that one `appointment.findMany` issues 30 SQL statements for 3 appointments, with summed database time of 3,108 ms exceeding wall time of 1,127 ms, is about statement count under a serialising pool as much as about cross-region round trips. That makes Prisma's `relationJoins` more promising than it first appeared, because collapsing statement count is the only lever a single connection responds to.

## What the 23-second TTFB actually decomposes into

This was measured on 2026-08-09 against deploy preview 1118, anonymously, on `/explore/experts/[consultantId]` — an on-demand ISR route, so every distinct parameter forces one real server render. Forty-two cold renders were taken across four batches. Every number below is client-side `time_starttransfer` from `curl`, correlated against the Netlify function log.

The headline is that the 23-second figure was misattributed. It is not cold boot, and it is not one long render. **It is the first database connect on a newly created function instance, and it costs a flat ~30 seconds whenever several new instances try to connect at the same moment.**

The evidence is a bimodal distribution with nothing in the middle:

| Batch | Concurrency | Instance state | Samples | Result |
|---|---|---|---|---|
| A | 1 (strictly sequential) | new | 8 | 1.80–2.72 s, median 1.88 s, no outliers |
| B | 12 concurrent | mostly new | 12 | six at 1.90–4.66 s, six at 30.99–33.08 s |
| C | 16 concurrent | 12 already warm | 16 | twelve at 2.64–2.94 s, four at 30.83–33.12 s |
| D | 12 concurrent | all warm | 12 | 3.33–5.89 s, zero slow |

No sample anywhere in the campaign landed between 6.8 s and 30.8 s. A distribution with a hole that wide is a timeout, not congestion.

Batch A settles the cold-boot question on its own: a brand-new instance rendering a real database-backed page sequentially costs about 1.9 seconds end to end. Boot is not the problem. Batch D settles the concurrency question: twelve simultaneous renders against warm instances cost 3.3–5.9 seconds and never degrade. What produces the tail is the *intersection* — a new instance that must open its first pooler connection while other new instances are doing the same.

The slow-count arithmetic supports that reading directly. Batch B ran twelve requests against roughly six existing instances and produced exactly six slow responses; batch C ran sixteen against the roughly twelve instances batch B had created and produced exactly four. In both cases the number of slow responses equals the number of instances that had to be created. Treat this as a strong inference rather than a proven mechanism, because instance identity is not exposed in the log.

Three further facts are worth carrying forward, because each one costs an afternoon to rediscover.

**One HTTP request is one function invocation.** Six concurrent requests produced exactly six `Duration:` lines, and each client timing exceeded its matching invocation duration by a near-constant 0.37 s of CDN and network overhead. The 32.23 s request maps to a single invocation of 30,113.69 ms. Nothing chains, nothing retries at the platform level, and the document request is not followed by a second billable render. Any explanation of a large TTFB that depends on a redirect chain, a middleware hop or an RSC follow-up is not what is happening here.

**The `Init Duration` field does not exist in this log stream.** Netlify's own cold-start discriminator is unavailable through both `netlify logs` and its historical API; the only fields emitted are `Duration:` and `Memory Usage:`. Two usable substitutes were found instead. An invocation *start* appears as an info line with an empty message, so start and end can be paired by adding the duration to the start timestamp. And a genuine module load prints the Better Auth pair `Social provider github is missing clientId or clientSecret` / `… facebook …`, which makes each new instance countable.

**The documented 9-second budget is not what the function actually obeys.** `lib/prisma.ts` tunes a 3 s connect plus a 6 s query budget specifically so a stuck pooler cannot pin a function to its ceiling, and no Netlify context overrides either value. Yet a single invocation ran 30,113.69 ms and logged `prisma:error timeout exceeded when trying to connect` at t+29.78 s — roughly ten times the configured connect timeout. Separately, invocations of 26.4 s to 31.9 s were logged on a Pro account whose documented synchronous ceiling is 26 s. Both the application budget and the platform ceiling are being exceeded, so neither can be relied on as an upper bound when reasoning about worst-case latency. This is tracked as issue #1120.

### The failure this exposes: a degraded page gets cached

`fallbackOnTransientDbError` correctly rethrows during `next build`, so a bad bake cannot be frozen into build output. It does **not** rethrow during an on-demand ISR render at request time, and that is a real gap rather than a theoretical one.

Two of the forty-two cold renders returned HTTP 200 carrying `<h1>This profile is taking a moment to load</h1>` — the degraded `ConsultantUnavailable` shell — at 66,407 bytes against a healthy 104–114 KB. Because the response is a 200 on a cacheable route, Netlify stored it in the durable cache. Every later visitor then received the broken page **from cache in 0.3 s**, for the whole revalidate window, with no error anywhere and nothing slow left to notice.

The lesson generalises past this one helper: on an ISR route, a fail-open path converts a transient database blip into a cached artefact. Fail-open and cacheable responses are safe individually and dangerous together. This is tracked as issue #1119.

## Options assessed and rejected — do not re-propose without new information

Partial Prerendering and Cache Components are not merely "a Next 16 feature" — they are unreachable from our pinned version. At `next@15.5.15`, `packages/next/src/server/config.ts` throws `CanaryOnlyError` on a stable build for both `experimental.ppr` and `experimental.cacheComponents`, so even `experimental.ppr = "incremental"` fails at config load rather than degrading. Next's own [ppr-preview](https://nextjs.org/docs/messages/ppr-preview) page confirms a canary release is required. This matters because PPR is the textbook answer to "a static page with one dynamic hole", and on this version that answer simply does not exist — a `Suspense` boundary around a dynamic read does **not** rescue static rendering without PPR. Separately, `use cache` would not help a route whose every segment is auth-gated, and every dashboard route here is auth-gated.

Caching a dynamic route at the CDN with `Netlify-CDN-Cache-Control` is technically sound and was considered for the public pages, but it still invokes the function on every cache miss, so it does not solve the cold start the way prerendering does. It remains the right tool when build-time data access is genuinely unacceptable.

Verified clean and not worth re-investigating: `next/image` usage (there are zero raw `<img>` tags), fonts (`next/font/google` with `display: swap`), `staleTimes`, `serverExternalPackages`, the Prisma singleton, and the bundle-analyzer tooling.

## Project constraints that constrain every change here

ESLint warnings are blocking, because SonarCloud fails the quality gate on unused variables. Never filter ESLint output for errors alone.

Renaming a large file makes SonarCloud count every line as new code, which then fails `new_duplicated_lines_density` on long-standing duplication. Prefer adding a parent server layout over splitting a client layout into a separate shell file.

The same trap fires without any rename. Several files on `dev` are already Prettier-dirty, so running `prettier --write` on one while editing it reformats hundreds of untouched lines and hands all of them to Sonar as new code. On #1116 this reformatted roughly 200 lines of `Navbar.tsx` that the change never touched. Revert the formatting churn and re-apply only the semantic edits; Prettier is `continue-on-error` in CI, so an unformatted file is not a failure, whereas a diff full of reformatting is a quality-gate risk.

Never run `prisma db push` as part of a rendering change. There is deferred, unrelated schema drift that a push would apply to a database shared with production.

## Sources

These were opened as primary sources rather than summarised second-hand.

- [Using a CDN with Next.js](https://nextjs.org/docs/app/guides/cdn-caching) — the exact per-strategy `Cache-Control` values.
- [Incremental Static Regeneration](https://nextjs.org/docs/app/guides/incremental-static-regeneration) and [How Revalidation Works](https://nextjs.org/docs/app/guides/how-revalidation-works).
- [generateStaticParams](https://nextjs.org/docs/app/api-reference/functions/generate-static-params), [revalidateTag](https://nextjs.org/docs/app/api-reference/functions/revalidateTag) and [Revalidating](https://nextjs.org/docs/app/getting-started/revalidating).
- [Netlify caching overview](https://docs.netlify.com/build/caching/caching-overview/) — header precedence, `stale-while-revalidate`, cache tags and `purgeCache`.
- [Next.js on Netlify](https://opennext.js.org/netlify) and [Netlify's Next.js setup guide](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/) — adapter support matrix, durable cache, documented limitations.
- [Durable Cache and the Quest for Fast, Fresh Content](https://www.netlify.com/blog/durable-cache-quest-for-fast-fresh-content/) — the Netlify Blobs backing store.
