# ADR: Build production with Turbopack so Sentry source maps fit the Netlify builder

- **Status:** accepted by the owner on 2026-11-05, pending the production checks listed under Consequences.
- **Issue:** #2522. **Experiments:** draft PRs #2597 (webpack) and #2599 (Turbopack).

## Context

On 2026-11-02 the production build of release #2478 ran out of memory while webpack generated Sentry source maps. Netlify's build container has 8 GB of RAM, and the build caps the V8 heap at 6144 MB (`NODE_OPTIONS` in `netlify.toml`). A hotfix turned source maps off for every Netlify build. Since then, production stack traces in Sentry have been minified: an error still shows its function names, route and breadcrumbs, but not the original file and line.

## Measured alternatives

Each experiment was a production-style deploy preview with source maps forced on. Each log was read through Netlify's build-log stream.

| #   | Configuration                                                   | Result                                                                                                                                         |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | webpack with `hidden-nosources-source-map` (no embedded source) | Killed by the container, exit 137. Process memory passed 8 GB before the 6 GB heap cap.                                                        |
| 2   | #1 plus server-only maps (client `devtool: false`)              | V8 heap out of memory, exit 134                                                                                                                |
| 3   | #2 plus `webpackBuildWorker`                                    | Build worker SIGKILLed, out of memory                                                                                                          |
| 4   | **Turbopack** (`next build --turbopack`), Sentry source maps on | **Built green.** Compiled in 72 s, about 5 minutes end to end, and all 256 static pages generated. Sentry's after-production-compile hook ran. |

Two options were not tried:

- **Building and uploading the maps outside Netlify.** This needs release machinery that keeps debug IDs identical to the deployed bundle. GitHub Actions minutes are budget-capped.
- **Waiting for the planned host move.** Larger build machines would remove the limit, but traces would stay minified until then.

The owner kept the host move as a later option, not as the fix.

## Decision

- **Every host builds with Turbopack.** The `build` script in `package.json` runs `next build --turbopack`, which covers Netlify, any container build and any future host.
- **Netlify previews and branch deploys, and CI's lean build, skip source maps.** `sourcemaps.disable` in `next.config.mjs` is true for `CI_LEAN_BUILD`, and for Netlify builds whose `CONTEXT` is not `production`; those contexts have no Sentry auth token, so a map built there would never be uploaded. Every other build, Netlify production included, also any container or other-host build, generates maps, and uploads them only where `SENTRY_AUTH_TOKEN` is set.
- **Bundle analysis stays on webpack.** `build:analyze` runs plain `next build`, because `@next/bundle-analyzer` reports through the webpack config hook, which Turbopack does not run.

## Consequences

**Checks after the first production deploy.** A preview cannot prove these, because previews never upload:

- the production build log shows Sentry uploading source maps;
- the next production server error in Sentry shows a mapped frame with the original file and line.

**Smaller consequences:**

- `@sentry/nextjs` (10.76.0) supports Turbopack. It uploads after compilation through its `runAfterProductionCompile` hook, and the webpack-only `webpack.treeshake.removeDebugLogging` option has no effect under Turbopack. The Sentry SDK's debug logging is therefore no longer tree-shaken from the bundle, which is a small size cost.
- Turbopack in Next 15.5 emits AVIF images without optimisation. The build warns about two such images.
- Turbopack does not read custom `webpack()` configuration. This app has none, but a future change that needs one must add the Turbopack equivalent instead.
- The runtime behaviour of the Turbopack build was smoke-tested on the #2599 deploy preview: public pages, sign-in, client-side dashboard navigation, `/api/health`, security and CSP headers, Stream chat, and the Sentry client all matched production.
- **PDF rendering was proven under Turbopack.** `lib/pdf/react-runtime/node-require.ts` used webpack's `__non_webpack_require__`, which Turbopack does not define. It now falls back to Node's `createRequire` anchored at the app root, instead of `module.require`. A temporary route on the #2599 preview rendered a real PDF through the same JSX runtime the invoices use (1,538 bytes, a valid `%PDF` header). React resolved to `/var/task/node_modules/react` (18.3.1), the same tree as `@react-pdf/renderer`, so the two-React clash (React error #31) does not occur. The route was removed before merge. The statutory invoices themselves still render only once `PLATFORM_GSTIN` is set.

## Deprecated & Superseded Approaches

- **No source maps on any Netlify build** (the 2026-11-02 hotfix) is superseded by this record. Do not restore a blanket Netlify disable.
- **webpack source-map tuning** (nosources maps, server-only maps, the build worker) was measured and rejected; see the table. Do not retry it on the 8 GB builder.
