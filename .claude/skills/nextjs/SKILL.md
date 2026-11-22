---
name: nextjs
description: Next.js App Router best practices for this repo (Next 15.5, React 18.3, Netlify with a hot-standby host, Prisma/Postgres) — Server vs Client Components and the "use client" boundary, what makes a route dynamic, why a loading.tsx or Suspense fallback commits HTTP 200 before notFound() or redirect() and the layout-check plus (index) route-group fix, React cache() versus unstable_cache and revalidateTag/revalidatePath, never caching viewer-specific data, "use cache" and Cache Components status, route handlers, middleware and the matcher, the x-familiarise-client-ip rule, Zod parsing of searchParams and bodies, after() on Netlify, React 18.3 limits and URL-driven state. Use when the user says "next.js", "app router", "loading.tsx", "notFound", "redirect", "soft 404", "revalidate", "cache", "unstable_cache", "server component", "use client", "route handler", "middleware", "searchParams", or before a PR that touches app/.
---

# Next.js App Router best practices

This is the rulebook for writing `app/` code here. Every rule names what enforces it. External claims carry a source link so the next person can re-check them. The sources describe the current Next.js documentation, which is a newer major than this repo, so every version-sensitive claim below was matched against the `/docs/15/` pages. The installed version is `next` 15.5.29 (`package.json`, `node_modules/next/package.json`), with `react` 18.3.1. No documentation ships inside `node_modules/next/dist/docs` for this version, so the web docs are the reference.

This skill does not repeat the neighbouring skills. For the measured rendering and caching traps on Netlify (static vs ISR vs dynamic, the `revalidate` ceiling, route-table symbols, how to verify), read `.claude/skills/maintenance/references/nextjs-netlify-caching.md`. For function limits, cold starts and the hosting platform, read `.claude/skills/deployment/SKILL.md`. For serverless-only failures (the `PG_POOL_MAX=1` deadlock, react-pdf), read `.claude/skills/maintenance/references/serverless-gotchas.md`. For Core Web Vitals and bundle rules, read `.claude/skills/performance/SKILL.md`.

## 1. Rendering model

Layouts and pages are Server Components by default. Add `"use client"` only for state, event handlers, effects or browser-only APIs ([Server and Client Components](https://nextjs.org/docs/15/app/getting-started/server-and-client-components)).

- **Keep the boundary low.** A `"use client"` file pulls all its imports into the client bundle, so mark the small interactive leaf, not a whole page. The performance skill's client-bundle guardrails police the cost.
- **Props across the boundary must be serialisable.** Pass plain data, never class instances, Prisma client objects or functions that are not Server Actions. The boundary is checked at build and render time by React ([serialisable values](https://react.dev/reference/react/use-server#serializable-parameters-and-return-values)).
- **Pass server UI as `children`.** A Client Component can render a Server Component handed to it as a prop, which keeps data fetching on the server.
- **Keep secrets out of shared modules.** Put `import "server-only"` at the top of any module that reads `process.env` secrets, Prisma or vendor SDKs, so a client import fails the build. Next.js only inlines variables that start with `NEXT_PUBLIC_`.
- **Context providers are Client Components.** Render them as deep as possible and have them wrap `{children}` only.

### What makes a route dynamic

Reading a request-scoped value anywhere in the server render tree opts the whole route out of the Full Route Cache: `cookies()`, `headers()`, `draftMode()` and the `searchParams` prop ([Caching in Next.js](https://nextjs.org/docs/15/app/guides/caching)). In Next 15 these are async, so `await cookies()`, `await params` and `await searchParams` ([Next.js 15](https://nextjs.org/blog/next-15)). A `fetch` with `cache: "no-store"`, `export const dynamic = "force-dynamic"` or `revalidate = 0` has the same effect. The read can sit three imports deep. `getSession()` in `lib/auth-server.ts` awaits `headers()` and `cookies()`, so any page that awaits it is dynamic. `maintenance/references/nextjs-netlify-caching.md` ("Step 2") lists how to trace and verify this. Do not call `getSession()` in a public ISR page. Resolve the viewer in a client-only component instead.

A `searchParams` prop makes the page dynamic. `app/explore/products/(index)/page.tsx` accepts it for the `tab` value and is therefore a dynamic route, which is a deliberate trade for that page. Do not add `searchParams` to a page that carries `export const revalidate`, because the revalidate value becomes inert.

### Choosing a rendering class

Pick the class from who sees the page, not from what is convenient:

| The page shows                                                            | Class                 | How                                                                                                                                                |
| ------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| The same thing to every visitor (landing, explore, auth chrome)           | Static or ISR         | `export const revalidate = <seconds>` plus a tag or path purge after writes. Viewer state (session, "Redirecting…") comes from a client component. |
| Something that depends on the viewer, their role, organisation or money   | Dynamic               | Read the session on the server (`getSession()`); this alone makes the route dynamic, so no route config is needed.                                 |
| Public data that must never be stale, with nothing request-scoped to read | Dynamic, by exception | `export const dynamic = "force-dynamic"`, with a one-line comment saying why ISR plus a purge is not enough.                                       |

Partial Prerendering is not an option on 15.x without Cache Components (section 3), so a page is one class as a whole.

### Client hooks that force client rendering

In a static or ISR route, a Client Component that calls `useSearchParams()` is client-side rendered up to the nearest `<Suspense>` boundary, and the prerendered HTML holds only that boundary's fallback. Without a boundary the build fails ([useSearchParams](https://nextjs.org/docs/15/app/api-reference/functions/use-search-params), [missing Suspense with CSR bailout](https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout)). Keep the boundary around the smallest leaf that reads the hook, and render everything server-side outside it. If you pass server UI into the boundary as a prop, it never reaches the HTML. Reference: `app/auth/signin/page.tsx` renders `AuthSidePanel` beside `SignInForm`, and only the form column sits under the Suspense fallback.

## 2. Streaming and status codes

### The rule

A streaming page response begins with HTTP 200. The first Suspense fallback to render, including any `loading.tsx`, sends the headers and fixes the status. A `notFound()` called after that point can only inject `<meta name="robots" content="noindex">` into a response that is already 200, which crawlers may record as a soft 404 ([loading.js status codes](https://nextjs.org/docs/15/app/api-reference/file-conventions/loading#status-codes), [notFound](https://nextjs.org/docs/15/app/api-reference/functions/not-found)). Calling `notFound()` before any fallback has rendered keeps the 404 status.

A segment's `loading.tsx` wraps that segment's `page.tsx`, its `not-found.tsx` and every nested layout, but not that segment's own `layout.tsx` ([loading.js](https://nextjs.org/docs/15/app/api-reference/file-conventions/loading)). That asymmetry is the whole fix.

### What this repo does

1. **Put the existence or visibility check in the segment's `layout.tsx`.** The layout is an async server component that reads the item through the same `React.cache` reader as the page, calls `notFound()` when it is missing or hidden from this viewer, and otherwise returns `children`. Reference: `app/explore/products/[slug]/layout.tsx`. The dashboards follow the same shape: each role root under `app/dashboard/` has a `layout.tsx` that 404s a missing or not-owned id through `viewerMayOpenProfile()` in `lib/dashboard/profile-access.ts`, with `app/dashboard/not-found.tsx` as the boundary.
2. **Keep the segment's own `loading.tsx`.** It sits below the layout, so the check still runs first.
3. **No ancestor of a checking layout may have a `loading.tsx`**, including `app/loading.tsx`, because an ancestor's fallback would wrap the layout and commit 200 first.
4. **Move an index page's skeleton into an `(index)` route group.** `app/explore/experts/(index)/` holds that page's `page.tsx` and `loading.tsx`. The URL is unchanged, and the skeleton no longer covers the sibling `[consultantId]` layout.
5. **Deep detail pages below a `loading.tsx`** (appointment, payment and support-case details) still call `notFound()` after the skeleton streams, so they remain soft 404s. They carry the `noindex` tag and are authenticated, so this is accepted. Do not claim a 404 status for them.

Enforcers: `__tests__/explore/not-found-layouts.test.tsx` and `__tests__/dashboard/not-found-layouts.test.tsx` fail if a checking layout, an `(index)` group or the no-ancestor-loading rule regresses. The explanation and the measured behaviour live in `maintenance/references/nextjs-netlify-caching.md` under "A page whose existence or visibility is checked must answer 404".

A layout that reads uncached or runtime data makes navigation wait for it, because `loading.tsx` cannot show a fallback for the layout itself without Cache Components ([loading.js](https://nextjs.org/docs/15/app/api-reference/file-conventions/loading)). Keep layout checks to one cached, indexed read.

### `notFound`, `redirect`, `permanentRedirect`

- All three work by throwing. Never wrap them in `try/catch`. If you must catch near them, call `unstable_rethrow(error)` first ([notFound](https://nextjs.org/docs/15/app/api-reference/functions/not-found), [redirect](https://nextjs.org/docs/15/app/api-reference/functions/redirect)).
- Do not call them from an un-awaited promise, or no boundary will catch them.
- `redirect()` answers 307 (temporary) outside Server Actions and keeps the method. A Server Action form post without JavaScript gets 303. `permanentRedirect()` answers 308. In a streamed response the redirect becomes a meta tag instead of a status, so a redirect that must be a real 3xx belongs before the first fallback, in the layout, in `middleware.ts` or in `next.config.mjs` `redirects`.
- `redirect()` works during render in Client Components but not in event handlers, where `useRouter().push` is the tool.
- For a Route Handler, return `NextResponse.json({ error }, { status: 404 })` for an API caller. `notFound()` is for pages.

### Skeletons and `loading.tsx`

`loading.tsx` is a Suspense fallback for a segment. It shows while the server renders that segment, both on a hard load of a dynamic route and on client navigation before the route's payload arrives ([loading.js](https://nextjs.org/docs/15/app/api-reference/file-conventions/loading)).

- **Dynamic routes that wait on data:** add one, subject to the 404 rules above.
- **Static or ISR routes:** it never shows on a hard load, because the HTML is already built, and on navigation only until the prefetched payload lands. Keep one only if it costs nothing. The auth pages keep theirs.
- **Client-side gates** (a `useSession()` pending state, a `useSearchParams()` boundary): use a skeleton of only the part that waits, not the whole page. `AuthFormColumnSkeleton` covers the form column and leaves the server-rendered side panel visible.
- **Match the anatomy.** A skeleton uses the same breakpoints and column widths as the page it stands in for, or the layout jumps when the page arrives.

## 3. Data fetching and caching

| Need                                                         | Tool                                                 | Scope                                                                                                             | Enforcer                                                                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Call the same read in a layout and its page once per request | `cache()` from `react`                               | One request only, matched by shallow argument equality ([React `cache`](https://react.dev/reference/react/cache)) | The wrapper itself. Pass primitives, not fresh objects. `lib/dashboard/profile-access.ts` wraps its existence reads this way. |
| Reuse a public read across requests and deployments          | `unstable_cache(fn, keyParts, { tags, revalidate })` | Shared Data Cache ([unstable_cache](https://nextjs.org/docs/15/app/api-reference/functions/unstable_cache))       | `lib/data/home.ts`, `lib/data/explore-experts.ts`                                                                             |
| Purge after a write                                          | `revalidateTag` then `revalidatePath`                | Data Cache, then the rendered HTML ([Caching](https://nextjs.org/docs/15/app/guides/caching))                     | The purge helpers in `lib/data/public-cache.ts`                                                                               |

Rules:

- **Never cache viewer-specific data in a shared cache.** `unstable_cache` and ISR output are shared by every visitor, and Next does not support `cookies()` or `headers()` inside a cached function ([unstable_cache](https://nextjs.org/docs/15/app/api-reference/functions/unstable_cache)). Anything that depends on the signed-in user, role, organisation or money is read in a dynamic route, or fetched client-side. `lib/data/public-cache.ts` documents the public surfaces it covers: landing, the two explore directories and the detail pages. Add a surface to that file only if an anonymous visitor sees it.
- **Purge after the commit, never inside `$transaction`.** A rollback would leave the cache purged against unchanged data. `revalidateTag` clears Data Cache entries. `revalidatePath` is still needed on top of it, because purging data alone leaves the rendered document in place. The helpers `purgeExpertSurfaces`, `purgeReviewSurfaces` and `purgeOrgSurfaces` encode which tags and paths each transition needs. Calling a revalidate function during render throws in Next 15 ([Next.js 15](https://nextjs.org/blog/next-15)).
- **Route Handlers do not refresh the client Router Cache.** A purge from a webhook or cron route updates the server caches, but a browser keeps its prefetched payload until the stale window ends or the user reloads ([Caching](https://nextjs.org/docs/15/app/guides/caching)). `next.config.mjs` sets `experimental.staleTimes` to `{ dynamic: 30, static: 180 }`, so allow up to 30 seconds for a dynamic page.
- **`fetch` defaults in 15.x.** A bare `fetch` is uncached (`no-store`), `GET` Route Handlers are no longer cached, and page segments in the client Router Cache default to 0 seconds ([Next.js 15](https://nextjs.org/blog/next-15)). Prisma reads bypass `fetch` entirely, so only `cache()`, `unstable_cache` and route segment config apply to them.
- **Effective `revalidate` is the minimum.** A short `unstable_cache` window deep in the data layer caps the whole route. See "Step 2b" of the caching reference.
- **Cache keys must include every closed-over variable.** `unstable_cache` keys by function arguments and `keyParts`. Pass the id as an argument.

### Which tool reads, which tool writes

| Job                                                                     | Tool                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Read data for a page                                                    | A Server Component reading Prisma directly, wrapped in `cache()` or `unstable_cache` |
| Read viewer-specific data in an interactive client island               | A `GET` Route Handler fetched from the client                                        |
| A mutation from this app's own UI (a form, a button)                    | A Server Action (`"use server"` in `actions/**`)                                     |
| A webhook, a cron, a mobile or third-party caller, or a cacheable `GET` | A Route Handler                                                                      |

Server Actions are `POST` endpoints that anyone can call with the right request, so they are untrusted entry points ([Server Actions guide](https://nextjs.org/docs/app/guides/server-actions)). Each action resolves the session, rate-limits and `safeParse`s its input itself, as `completeOnboardingGateAction` in `actions/onboarding-gate.action.ts` does. Never use one to read data: it is a `POST`, it cannot be cached, and the client runs actions one at a time.

### `"use cache"` and Cache Components

Not enabled here. `next.config.mjs` sets neither `experimental.useCache` nor `cacheComponents`, and `rg -n "use cache" app lib components` finds no directive. On Next 15 the directive is experimental and badged Canary ([use cache](https://nextjs.org/docs/15/app/api-reference/directives/use-cache)), and the `unstable_cache` page says that API "will be replaced by `use cache` when it reaches stability". Do not add the directive or the flags. The Netlify runtime lists Cache Components as supported ([Netlify Next.js overview](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/)), but adopting it is a migration of the data layer and the layout rules in section 2, which needs its own decision, not a drive-by edit. Likewise, Partial Prerendering is not available without it, so a Suspense island still cannot keep a route static. Next 16 makes Cache Components a stable opt-in that turns on Partial Prerendering ([Next.js 16](https://nextjs.org/blog/next-16)). Adopting it is part of a 16.x upgrade, not a 15.x change.

## 4. Route handlers and middleware

### Route handlers (`app/api/**/route.ts`)

- **Runtime.** Handlers default to the Node.js runtime. Four handlers declare `export const runtime = "nodejs"` and seven declare `export const dynamic = "force-dynamic"`. Prisma, `pg` and vendor SDKs need Node, so never choose `edge` for a handler that touches the database. Netlify runs edge-declared SSR on the Node functions region anyway ([Netlify Next.js overview](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/)).
- **Parse everything untrusted with Zod.** Bodies, `request.nextUrl.searchParams` and path params are strings or `unknown`. Define a schema (see `subscribeSchema` in `app/api/newsletter/route.ts`, or `schemas/**`), call `safeParse`, return 400 with the issues, and derive types with `z.infer`. A page's `searchParams` follows the same rule: `parseProductsTab` in the explore products page narrows the raw value. AGENTS.md §4.1 requires it.
- **`params` and `searchParams` are Promises** in Next 15 handlers and pages ([route.js](https://nextjs.org/docs/15/app/api-reference/file-conventions/route)).
- **Webhook bodies are read raw** (`await request.text()`) so signature verification sees the exact bytes, and only then parsed.
- **Big binaries.** Never proxy more than 4 MB through a handler. Use Supabase signed URLs (AGENTS.md §2.5).
- **Mutations are not cached.** `GET` handlers are dynamic by default in Next 15. Add `force-static` only for a response that is identical for everyone.

### Middleware (`middleware.ts`)

- **The name.** On 15.5 the file is `middleware.ts`. Newer docs call it `proxy`. Do not rename it while on 15.x.
- **Runtime.** Edge by default. Node.js middleware became stable in 15.5 ([middleware.js](https://nextjs.org/docs/15/app/api-reference/file-conventions/middleware)). On Netlify the middleware runs as an Edge Function, and Node-only features (C++ addons, the filesystem) are unavailable there ([Netlify Next.js overview](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/)). Keep it free of Prisma (`middleware.ts` imports none).
- **The matcher is a static constant.** `config.matcher` in `middleware.ts` covers every page except static assets, plus `/api/(.*)`. Matcher values must be constants, because variables are ignored ([middleware.js](https://nextjs.org/docs/15/app/api-reference/file-conventions/middleware)). A route outside the matcher never receives the stamped headers.
- **The client-IP rule (AGENTS.md §2.5).** The middleware resolves the client IP once through `edgeClientIp()` in `lib/request-ip.ts`, deletes any inbound `x-familiarise-client-ip` and stamps its own. Route handlers, Better Auth and the sign-in throttle read only that header (`CLIENT_IP_HEADER`). Never read `x-forwarded-for`, `x-nf-client-connection-ip` or `x-vercel-forwarded-for` in Node code, because behind the Netlify edge function every request appears to come from one address. Every path that reads the IP must sit inside the matcher.
- **Keep middleware fast.** It runs before every matched request, and fetches inside it are never cached ([Caching](https://nextjs.org/docs/15/app/guides/caching)). Do no database reads there.
- **Cache headers.** Send `Vary: Cookie` alongside `Netlify-Vary` on public cookie-aware routes, and `Cache-Control: private, no-store` when a session cookie exists. Vercel and generic CDNs ignore `Netlify-Vary` (see `serverless-gotchas.md` §9).

## 5. Netlify and the dual host

Details live in the deployment and maintenance skills. The facts that bite App Router code:

- **Two request ceilings.** The Lambda limit is 60 seconds, and the edge returns a 504 at about 26 seconds to any response that has not begun streaming. A handler that may run long must start streaming or fit under about 25 seconds (`deployment/SKILL.md`, `serverless-gotchas.md` §4). Netlify's own limit pages are the primary source ([Netlify Functions](https://docs.netlify.com/build/functions/overview/) links its configuration and background-function pages), and this skill did not re-measure them.
- **`after()` is best-effort.** Netlify lists `next/after` as fully supported, backed by `waitUntil` ([Netlify Next.js overview](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/)), but it is still bounded by the execution ceiling and ends on a crash. Call it through `scheduleAfter()` in `lib/api/after-safe.ts`, which reports failures to Sentry and degrades to a floating promise outside a request scope such as Jest or `scripts/`. Never put money truth in it. Write the outbox row inside the transaction and keep an idempotent sweep (`serverless-gotchas.md` §3).
- **The build prerenders against the live database.** A route that renders `○` in the build route table runs its data reads inside `next build`, so a cold pooler connect can fail the build, and a build can only be trusted if the Supabase project is reachable. Keep ISR pages' build-time reads cheap, and prefer `generateStaticParams` returning `[]` for unbounded params ("Step 3" of the caching reference).
- **`sharp` and `@img` exclusion.** `next.config.mjs` excludes `node_modules/sharp/**` and `node_modules/@img/**` from file tracing only when `process.env.NETLIFY === "true"` or `VERCEL === "1"`, because `/_next/image` is served by the Netlify Image CDN. Do not make the exclusion unconditional, because the standby and container builds need `sharp`.
- **`NETLIFY` is a build-machine variable.** `next.config.mjs` inlines it, and runtime code must read the literal `process.env.NETLIFY`.
- **Previews and the standby.** Keep `netlify.toml` and `netlify/functions/cron-tick.mts` intact. The adapter (`@netlify/plugin-nextjs`) is not pinned in this repo, so re-verify rendering behaviour after any adapter change.
- **Pool.** Under `PG_POOL_MAX=1`, a helper inside `prisma.$transaction` must use `tx`, never the global client (AGENTS.md §2.1).

## 6. React 18.3 and URL-driven state

- **No `useEffectEvent`.** It is not in React 18.3. The docs page for it says Effect Events may only be called from inside Effects ([useEffectEvent](https://react.dev/reference/react/useEffectEvent)), and that is exactly the pattern you must hand-roll here. Sync a latest-value ref in an effect declared before the effect that reads it. Never suppress `react-hooks/exhaustive-deps` (AGENTS.md §4.2, enforced by ESLint).
- **No ref writes in render.** `ref.current = value` belongs in an effect, as above.
- **Derive URL state from `useSearchParams()` in render.** The address bar is the source of truth: compute filters, tabs and pages from `useSearchParams()` each render, and write changes back with `replaceUrl()` from `lib/navigation/history.ts`. Do not copy the search params into `useState`, because a soft navigation then leaves the copy stale. `useUrlSyncedFilters` (`app/explore/hooks/useUrlSyncedFilters.ts`) mirrors the URL into state today and is the documented exception for the explore writers (`serverless-gotchas.md` §8). Do not copy that pattern into new code.
- **Always use `replaceUrl()`.** Next patches `history.replaceState`, and passing `window.history.state` moves the address bar without updating `useSearchParams`. An ESLint `no-restricted-syntax` rule in `eslint.config.mjs` blocks it.
- **Error boundaries.** Recover from a server-thrown error with `startTransition(() => { router.refresh(); reset(); })`, as `components/dashboard/DashboardRouteError.tsx` does.

## 7. Checklist before a PR touching `app/`

1. **Server by default.** Is every new `"use client"` a small leaf? Are props serialisable? Does any secret-bearing module import `server-only`?
2. **Rendering class.** Did you classify the route (static, ISR, dynamic) and trace its import graph for `cookies()`, `headers()`, `searchParams` and `getSession()`? An ISR page must read none of them. Is server-rendered UI outside every `useSearchParams()` Suspense boundary?
3. **404 and 403 behaviour.** Does a new public dynamic segment check existence in its own `layout.tsx`? Is there no `loading.tsx` on any ancestor? Is the index page inside an `(index)` group? Did you extend both `not-found-layouts` tests?
4. **Control flow.** Are `notFound()`, `redirect()` and `permanentRedirect()` outside `try/catch` and awaited?
5. **Caching.** No viewer-specific data in `unstable_cache` or ISR. Every write that an anonymous visitor can see calls a purge helper from `lib/data/public-cache.ts` after the commit. Cache keys carry every variable.
6. **Handlers.** Node runtime for anything with Prisma. Zod `safeParse` on every body, query and path param. Raw body for webhooks. Reads go through `x-familiarise-client-ip`, and the path is inside the matcher.
7. **Time.** Does any handler risk more than about 25 seconds without streaming? Is `after()` used through `scheduleAfter()` with no money truth in it?
8. **React 18.3.** No `useEffectEvent`, no ref writes in render, no URL-to-state mirroring, `replaceUrl()` for URL writes.
9. **Verify.** `npx tsc --noEmit`, `npm run lint`, the targeted Jest suites, and for rendering changes the artefacts listed under "How to verify" in the caching reference. Green CI is not proof that a cache change worked.

## Deprecated & Superseded Approaches

- **`export const dynamic = "force-dynamic"` as a default for any page with a session read.** It made public listings uncacheable at the CDN. Public pages are now ISR with client-only auth chrome (`app/explore/experts/(index)/page.tsx`).
- **A root or ancestor `loading.tsx` over checking layouts.** It turned every missing id into a soft 404. Replaced by the layout check and `(index)` groups above.
- **Synchronous `cookies()`, `params` and `searchParams`.** Next 15 made them async, and the synchronous form only warns until the next major.
- **Relying on `fetch` defaults for caching.** Next 14 cached `fetch` and `GET` handlers by default. Next 15 does not.
- **`unstable_cache` is on a deprecation path.** The docs say `use cache` will replace it. Keep using it here until a migration is planned.

## Sources

- [Server and Client Components (v15)](https://nextjs.org/docs/15/app/getting-started/server-and-client-components)
- [Caching in Next.js (v15)](https://nextjs.org/docs/15/app/guides/caching)
- [unstable_cache (v15)](https://nextjs.org/docs/15/app/api-reference/functions/unstable_cache)
- [use cache (v15, Canary)](https://nextjs.org/docs/15/app/api-reference/directives/use-cache)
- [Next.js 15 release notes](https://nextjs.org/blog/next-15) and [Next.js 16 release notes](https://nextjs.org/blog/next-16)
- [useSearchParams (v15)](https://nextjs.org/docs/15/app/api-reference/functions/use-search-params) and [missing Suspense with CSR bailout](https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout)
- [Server Actions guide](https://nextjs.org/docs/app/guides/server-actions)
- [loading.js and its status-code section](https://nextjs.org/docs/15/app/api-reference/file-conventions/loading)
- [notFound](https://nextjs.org/docs/15/app/api-reference/functions/not-found) and [redirect](https://nextjs.org/docs/15/app/api-reference/functions/redirect)
- [route.js (v15)](https://nextjs.org/docs/15/app/api-reference/file-conventions/route) and [middleware.js (v15)](https://nextjs.org/docs/15/app/api-reference/file-conventions/middleware)
- [React `cache`](https://react.dev/reference/react/cache) and [React `useEffectEvent`](https://react.dev/reference/react/useEffectEvent)
- [Netlify Next.js runtime overview](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/) and [Netlify Functions overview](https://docs.netlify.com/build/functions/overview/)
