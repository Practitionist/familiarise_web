import { withSentryConfig } from "@sentry/nextjs";
/** @type {import('next').NextConfig} */
const withBundleAnalyzer =
  process.env.ANALYZE === "true"
    ? (await import("@next/bundle-analyzer")).default({
        enabled: true,
        openAnalyzer: true,
      })
    : (config) => config;

/**
 * The app's own origin, resolved at BUILD time.
 *
 * `NEXT_PUBLIC_APP_URL` is set on Netlify with context `all`, pinned to
 * https://familiarisenow.com. Because `NEXT_PUBLIC_*` is inlined into the
 * client bundle, every deploy preview shipped a bundle whose auth client
 * called PRODUCTION's `/api/auth/*`. The browser blocked it on CORS, which is
 * the only reason previews failed loudly rather than quietly authenticating
 * against production and mutating real data.
 *
 * Netlify sets `CONTEXT` (production | deploy-preview | branch-deploy) and
 * `DEPLOY_PRIME_URL` (this deploy's own origin) on every build. Off
 * production we prefer the per-deploy URL, so a preview talks to itself.
 *
 * This has to happen here rather than as an env var: Netlify env values are
 * literal strings — it does NOT expand `$DEPLOY_PRIME_URL` inside a value —
 * and `NEXT_PUBLIC_*` is baked at build, so a runtime fallback would come too
 * late for the client bundle.
 *
 * Declared ABOVE the header block because `Reporting-Endpoints` needs an
 * ABSOLUTE URL, which the Reporting API requires (unlike `report-uri`, which
 * takes the path). A deploy preview therefore reports to its own origin and
 * production reports to production — the same "a preview talks to itself"
 * rule the auth client needs, for the same reason.
 */
const RESOLVED_APP_URL =
  process.env.CONTEXT && process.env.CONTEXT !== "production"
    ? (process.env.DEPLOY_PRIME_URL ?? process.env.NEXT_PUBLIC_APP_URL)
    : process.env.NEXT_PUBLIC_APP_URL;

/**
 * Opt-in for type-checking and linting inside `next build` on Netlify.
 *
 * Off by default so no existing deploy changes behaviour. See the long
 * rationale at the `eslint` / `typescript` keys below — the summary is that
 * `NETLIFY` is set on every Netlify build including production, so gating on
 * it meant production shipped untyped and unlinted code, and this flag makes
 * turning the checks back on a decision rather than a side effect.
 */
const STRICT_BUILD = process.env.STRICT_BUILD === "true";

/**
 * CSP violation sink, declared here because BOTH the directive and the
 * `Reporting-Endpoints` header below are derived from it and must not drift.
 *
 * `app/api/csp-report/route.ts` is the handler for the path half. It accepts
 * both legacy `application/csp-report` and the Reporting API's
 * `application/reports+json`, so one handler serves both delivery mechanisms.
 */
const CSP_REPORT_PATH = "/api/csp-report";
const CSP_REPORT_GROUP = "csp-endpoint";
const CSP_REPORT_ENDPOINT = RESOLVED_APP_URL
  ? `${RESOLVED_APP_URL.replace(/\/+$/, "")}${CSP_REPORT_PATH}`
  : undefined;

/**
 * Content Security Policy — report-only by default, and the default is on
 * purpose. See the enforcement note further down.
 *
 * Why report-only is the default
 * ------------------------------
 * A strict CSP can silently break Stream.io's call-widget script injection
 * or a Razorpay popup if any allow-list entry drifts, and this allow-list has
 * ALREADY drifted once: before the three `*.stream-io-*` entries were added
 * (documented below) every dashboard load filed violations for traffic the
 * product cannot function without, and video calling would have failed
 * outright the instant enforcement was switched on.
 *
 * The blocker on flipping the default is that nobody has read the report
 * yet. `/api/csp-report` writes a `console.warn` line with
 * `event: "csp_violation"` to the Netlify function log — there is no queryable
 * store, no Sentry event, no dashboard. Triage means tailing production logs
 * for a day, tallying by `violated-directive`, and judging each as
 * "legitimate third party" or "browser noise". That is an operator task, not a
 * code change, and it is not safe to short-circuit it.
 *
 * So the default stays report-only and the build says so out loud, every
 * production build, in the one channel that is never stripped
 * (`compiler.removeConsole` below excludes `error` and `warn`; `log` is not
 * one of them). Leaving this off FOREVER is not a supported state — the
 * report-only window is closed by triaging the reports and setting the env
 * var, not by silence. The rollout runbook is
 * `docs/enterprise/50-operations/03-runbooks.md` ("CSP enforcement").
 *
 * Allow-list rationale
 * --------------------
 *   - `script-src` includes Razorpay's checkout CDN + Stripe.js +
 *     Stream.io + Sentry + Supabase + 'unsafe-inline'/'unsafe-eval'
 *     (Next.js still emits inline runtime chunks; Next 15 hashing
 *     lands in 16).
 *   - `connect-src` opens WSS for Stream + HTTPS for the four payment
 *     gateways + Sentry + Resend + Upstash. Anything new must be
 *     added here AND in the matching client.
 *   - `frame-src` allows Razorpay's + Stripe's checkout iframes; Razorpay
 *     serves the live checkout iframe from `api.razorpay.com`, not just
 *     `checkout.razorpay.com` (report-only violation on a real checkout).
 *   - `media-src` is the load-bearing entry for Stream call audio /
 *     video / recording playback.
 *
 * `'unsafe-eval'` in `script-src` stays, and is not a pending cleanup. The
 * Stream background-filter / noise-cancellation add-ons are WASM builds
 * that `eval` their loader, and the worker-src note below is the companion
 * half of that same constraint. Removing it would break those add-ons the
 * day they are switched on, and until then it buys nothing that
 * `script-src` does not already permit via `'unsafe-inline'`.
 *
 * Added without a compatibility cost
 * ---------------------------------
 * `object-src 'none'`, `base-uri 'self'` and `form-action 'self'` are the
 * three directives that were simply absent, and all three are absent-by-
 * accident rather than by decision — each is an explicit deny/allow that
 * a real allow-list should have stated. None of them can break a
 * functioning page here: the app ships no <object>/<embed>, no <base>, and
 * every form action is same-origin (which is the point — `form-action`
 * is the directive that makes an injected credential-stealing form
 * structurally impossible). Each rationale is inline at its entry below.
 *
 * Stream.io does NOT run on getstream.io at runtime
 * -------------------------------------------------
 * `getstream.io` is the marketing/docs domain. The SDKs actually talk to
 * three separate domains, none of which `*.getstream.io` matches, so every
 * dashboard load was filing violation reports:
 *
 *   - `*.stream-io-api.com`   REST + the chat/video websockets
 *                             (`wss://video.stream-io-api.com`)
 *   - `*.stream-io-video.com` the edge-latency hint (`hint.…`) the client
 *                             fetches BEFORE a call to pick an SFU, then the
 *                             SFU edge itself
 *   - `*.stream-io-cdn.com`   recordings and chat attachments
 *
 * Confirmed against a real network log on a deploy preview, not inferred from
 * docs. `*.getstream.io` stays because Stream still serves some static assets
 * there and removing it is a separate, unobserved risk.
 *
 * Not added, deliberately: `worker-src`. Nothing in this app constructs a
 * Worker and the Stream background-filter/noise-cancellation add-ons (the
 * things that would need `blob:` workers and `wasm-unsafe-eval`) are not
 * installed. If those are ever enabled, this is the directive that will break
 * first, and `default-src 'self'` is what it will fall back to.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // `challenges.cloudflare.com` is Cloudflare Turnstile, the bot gate on
  // sign-up / sign-in / password-reset. It is listed in BOTH script-src
  // (for /turnstile/v0/api.js) and frame-src (managed mode renders the
  // challenge in an iframe on that origin). connect-src is deliberately
  // NOT extended: only pre-clearance mode fetches /cdn-cgi/ on our own
  // origin, and we run interaction-only. The widget renders nothing when
  // NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset, so dev/CI are unaffected
  // and neither origin is contacted on a deployment without the key.
  // Until ENABLE_CSP_ENFORCE is turned on this is a report, not a break.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com https://js.stripe.com https://*.sentry.io https://*.getstream.io https://*.supabase.co https://challenges.cloudflare.com",
  "connect-src 'self' https://*.getstream.io wss://*.getstream.io https://*.stream-io-api.com wss://*.stream-io-api.com https://*.stream-io-video.com wss://*.stream-io-video.com https://*.stream-io-cdn.com https://*.supabase.co https://*.upstash.io https://api.razorpay.com https://api.stripe.com https://*.sentry.io https://api.resend.com https://*.novu.co wss://*.novu.co",
  "img-src 'self' data: https: blob:",
  "media-src 'self' blob: https://*.getstream.io https://*.stream-io-cdn.com https://*.stream-io-api.com",
  "style-src 'self' 'unsafe-inline'",
  "frame-src 'self' https://checkout.razorpay.com https://api.razorpay.com https://js.stripe.com https://hooks.stripe.com https://challenges.cloudflare.com",
  "font-src 'self' data:",
  // Defense-in-depth alongside X-Frame-Options below: modern browsers enforce
  // frame-ancestors and ignore X-Frame-Options, legacy browsers do the reverse.
  "frame-ancestors 'none'",
  // No <object>/<embed> anywhere in this app, and none of the allow-listed
  // origins serve plugin content. `'none'` is a real control here: without
  // object-src a plugin document inherits `default-src 'self'`, which still
  // permits same-origin plugin content — and the classic payload for it is
  // Flash-era, but the directive also covers <embed> and legacy <object>
  // data: documents. Zero compatibility cost: the payment iframes are
  // <iframe> (frame-src above), not <object>.
  "object-src 'none'",
  // Stops an injected <base href> from re-pointing every relative URL on the
  // page — including form targets and lazy-loaded chunks — at an attacker's
  // origin. `default-src 'self'` does NOT cover this: base-uri is one of the
  // directives that does not fall back to default-src. Every route in this app
  // uses absolute or root-relative URLs, so nothing here depends on a <base>.
  "base-uri 'self'",
  // Where a form without an explicit action may submit. `form-action` is also
  // NOT covered by default-src. The auth surface is the reason this is not
  // merely theoretical: the sign-in and SSO forms post to same-origin
  // /api/auth/*, so 'self' permits every one of them, and the directive
  // forecloses an injected form exfiltrating credentials to a third party.
  "form-action 'self'",
  // Legacy delivery, kept: report-uri is deprecated in the CSP3 spec and
  // ignored by browsers that only implement the Reporting API below. Both are
  // shipped because a browser that implements only one of them still reports.
  `report-uri ${CSP_REPORT_PATH}`,
  // Reporting API delivery — the current mechanism. The `Reporting-Endpoints`
  // response header below binds the group name to the absolute endpoint.
  // Omitted when the origin is unresolvable: `report-to` pointing at a group
  // no header defines is a silently-dropped directive, and report-uri above
  // still delivers.
  ...(CSP_REPORT_ENDPOINT ? [`report-to ${CSP_REPORT_GROUP}`] : []),
].join("; ");

/**
 * Enforcement is opt-out, not opt-in — the value is READ, and only an explicit
 * `false` disables it. `=== "true"` is the old behaviour: unset meant
 * report-only, and unset is what production has always been.
 *
 * This is deliberately NOT flipped to enforce-by-default. The reasoning is in
 * the CSP docblock above: the allow-list has a documented drift history, the
 * violation report has never been triaged, the sink is a log line nobody
 * queries, and the worst failure mode is Razorpay checkout breaking for every
 * customer at once. Rolling that die without reading the reports would be a
 * worse outcome than the advisory header, which is a finding on an audit, not
 * an outage.
 *
 * The escape hatch is explicit and temporary. Set `ENABLE_CSP_ENFORCE=false`
 * in the Netlify env ONLY as a deliberate step, and put it back in the same
 * change that reads the report.
 *
 * Note the build-time bake, which the runbook's "no restart required" line
 * gets wrong: this reads process.env at config-evaluation time and lands in
 * the `headers()` output, so a production env change does not take effect
 * until the next deploy. Rollback is a redeploy, not a config push.
 */
const CSP_ENFORCE = process.env.ENABLE_CSP_ENFORCE !== "false";

const CSP_HEADER_KEY = CSP_ENFORCE
  ? "Content-Security-Policy"
  : "Content-Security-Policy-Report-Only";

if (!CSP_ENFORCE && process.env.NODE_ENV === "production") {
  // Fires on every production build including Netlify deploys, because
  // `log` is the level `compiler.removeConsole` strips in production and
  // this must not be one of the silent kinds. Development builds stay quiet
  // — the finding that matters is a production header.
  console.warn(
    [
      "",
      "  ┌─ CSP IS ADVISORY (Content-Security-Policy-Report-Only)",
      "  │",
      "  │  This build ships a REPORT-ONLY policy, not an enforcing one.",
      "  │  Nothing is blocked. Violations are logged at /api/csp-report as",
      '  │  `event: "csp_violation"` and are NOT queryable — triage them by',
      "  │  tailing the production function log.",
      "  │",
      "  │  To close the window: tally by `violated-directive`, add any",
      "  │  legitimate third party to CSP_DIRECTIVES, then set",
      "  │  ENABLE_CSP_ENFORCE=true (unset is treated as enforcing; only an",
      '  │  explicit "false" re-opens report-only). Env changes are baked',
      "  │  at build — redeploy to take effect.",
      "  │",
      "  │  Runbook: docs/enterprise/50-operations/03-runbooks.md",
      `  │  context: ${process.env.CONTEXT ?? "unset (local build)"}`,
      "  └─────────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
}

/** @type {Array<{ key: string; value: string }>} */
const securityHeaders = [
  // Prevent the page from being embedded in an iframe (clickjacking)
  { key: "X-Frame-Options", value: "DENY" },
  // Prevent browsers from MIME-sniffing a response away from the declared content-type
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Disable DNS prefetching to reduce information leakage
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // Only send origin when navigating to same origin; send nothing for cross-origin
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Restrict access to browser features not used by this app. camera +
  // microphone stay `self` for Stream.io call surfaces; payment is locked
  // to none because Razorpay does its own iframe-scoped grant.
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(self), geolocation=(), payment=()",
  },
  // HSTS: force HTTPS for two years + preload-list eligibility. Safe to
  // ship — Netlify + Vercel both serve all production traffic over TLS.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // CSP. Enforcing by default; `ENABLE_CSP_ENFORCE=false` re-opens the
  // report-only window and warns the build (see CSP_ENFORCE above).
  { key: CSP_HEADER_KEY, value: CSP_DIRECTIVES },
  // Bind the `report-to csp-endpoint` group name to an ABSOLUTE URL, which
  // the Reporting API requires and the CSP spec does not allow you to infer
  // from report-uri. Emitted only when the origin resolved, so a build with
  // no NEXT_PUBLIC_APP_URL sends a report-to directive with no endpoint
  // header rather than a header pointing nowhere. Applies to both header
  // modes — reports keep flowing after enforcement, they are just attached
  // to a blocked request.
  ...(CSP_REPORT_ENDPOINT
    ? [
        {
          key: "Reporting-Endpoints",
          value: `${CSP_REPORT_GROUP}="${CSP_REPORT_ENDPOINT}"`,
        },
      ]
    : []),
];

const nextConfig = {
  // Drop the `X-Powered-By: Next.js` fingerprinting header.
  poweredByHeader: false,
  // Origin-dependent values are recomputed per deploy context — see
  // RESOLVED_APP_URL above. Listing them here overrides whatever the Netlify
  // dashboard injected, for the build only.
  env: {
    ...(RESOLVED_APP_URL
      ? {
          NEXT_PUBLIC_APP_URL: RESOLVED_APP_URL,
          BETTER_AUTH_URL: RESOLVED_APP_URL,
          // BetterAuth rejects any Origin not on this list. A preview must
          // trust its own origin or every auth call 403s.
          BETTER_AUTH_TRUSTED_ORIGINS: [
            ...new Set(
              [
                ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",") ?? []),
                RESOLVED_APP_URL,
              ]
                .map((s) => s.trim())
                .filter(Boolean),
            ),
          ].join(","),
        }
      : {}),
    // #1086 — previews now report to the SAME Sentry project as production, so
    // the branch is what makes their noise filterable. Baked at build for the
    // same reason as the URLs above: NEXT_PUBLIC_* is inlined into the client
    // bundle, and Netlify's BRANCH only exists on the build machine.
    ...(process.env.BRANCH
      ? { NEXT_PUBLIC_SENTRY_BRANCH: process.env.BRANCH }
      : {}),
  },
  // Type-check and lint during `next build`: OFF on Netlify, ON everywhere
  // else, and ON on Netlify when STRICT_BUILD=true.
  //
  // What changed and why (#932 was the reason these were ever skipped)
  // ----------------------------------------------------------------
  // The old gate was `!!process.env.NETLIFY`, and Netlify sets `NETLIFY=true`
  // on EVERY build — production included. So the flag was not a Netlify
  // workaround at all; it was "production ships untyped, unlinted code",
  // expressed as an environment side effect that nobody reads. The comment it
  // carried ("CI gates them anyway") was true and load-bearing at the time,
  // but it described a gate that does not cover every way code reaches prod.
  //
  // The reason for skipping is real and unchanged: `next build` runs ESLint
  // and tsc in the same process as the webpack compile, and netlify.toml
  // pins `NODE_OPTIONS = "--max-old-space-size=6144"` in an 8 GB container
  // (see the #1795 / #1792 notes further down on how much of that headroom
  // the static phase already wants). Adding a second full type-check pass on
  // top of an already-tight ceiling is how exit 137 happens. So the default
  // is preserved rather than reversed.
  //
  // What is NOT preserved is the accidental part. `STRICT_BUILD=true` is now
  // the only thing that turns the checks back on, so "strict" is a decision
  // someone makes, not a side effect of where the build runs. Set it on the
  // release branches in the Netlify env. Cost when it is on: a slower build
  // and a higher peak-RSS risk against that 6144 MB ceiling — if the strict
  // build starts exiting 137, raise the concurrency/heap knobs above before
  // concluding the checks are unaffordable.
  //
  // What CI does and does not cover (.github/workflows/ci.yaml)
  // ----------------------------------------------------------
  //   on:
  //     pull_request:
  //       branches: [dev, staging, prod, "feat/**"]
  //   workflow_dispatch:
  //
  // There is no `push:` trigger at all. So `npx tsc --noEmit` (step "TypeScript
  // Check") and `npx eslint .` (step "ESLint Check") run on every pull request
  // INTO a release branch, and on manual dispatch — but a DIRECT PUSH to
  // `prod` runs no checks and deploys whatever is on it. That is the gap
  // `STRICT_BUILD=true` on the release branches closes, and the reason it
  // should not wait: the direct-push path is exactly the one CI misses.
  //
  // Note also that the CI "ESLint Check" and "Prettier Check" steps carry
  // `continue-on-error: true` — they report into the job summary rather than
  // failing the job. So lint is currently advisory even on the pull-request
  // path, and tsc is the check that actually blocks. Worth knowing before
  // treating CI as the whole safety net.
  eslint: {
    ignoreDuringBuilds: process.env.NETLIFY === "true" && !STRICT_BUILD,
  },
  typescript: {
    ignoreBuildErrors: process.env.NETLIFY === "true" && !STRICT_BUILD,
  },
  // Reduce Webpack memory usage during builds (Next.js 15+, low-risk experimental)
  experimental: {
    // #1795 — Netlify deploy-preview OOM'd (exit 137, Killed at static page
    // 166/334) with the heap already capped at 6144 MB inside the 8 GB
    // container, so prerender-worker RSS — not heap — is the constraint (same
    // lesson as #1792's widenClientFileUpload). Default concurrency is 8
    // workers × DB-touching prerenders; halving it on Netlify halves peak
    // RSS at the cost of a slower static phase. CI/dev keep the default.
    // Netlify-only survival tuning (exit 137, 8 GB container). NONE of this
    // affects the shipped site's speed — it only changes how many pages the
    // build cooks at once. Minimum parallelism: 1 worker × 2 pages in flight
    // (from 4×8=32). Builds get much slower; that is explicitly accepted.
    // If Netlify's build time limit ever binds, raise maxConcurrency first.
    ...(process.env.NETLIFY === "true"
      ? {
          staticGenerationMaxConcurrency: 2,
          // Prerender source maps are held in memory through the static
          // phase; Netlify trades them for survival (Next memory guide),
          // CI/dev keep them for prerender stack-trace quality.
          enablePrerenderSourceMaps: false,
          // Bounds the jest-worker pools for BOTH compile and static
          // generation (build/index.js getNumberOfWorkers). Default is 4.
          cpus: 1,
        }
      : {}),
    webpackMemoryOptimizations: true,
    // Only packages Next does NOT already optimize by default. Its built-in
    // list covers lucide-react, recharts and date-fns among others, so listing
    // those was inert config that read as if it were doing something.
    // https://nextjs.org/docs/app/api-reference/config/next-config-js/optimizePackageImports
    optimizePackageImports: [
      "framer-motion",
      "@stream-io/video-react-sdk",
      "stream-chat-react",
      // Imported by components/notifications/NotificationInbox.tsx and not in
      // the default list.
      "@novu/nextjs",
    ],
    // Next 15 defaults page segments to 0, which refetches RSC on every nav; this lets the client router cache hold payloads ~30s between navs.
    staleTimes: { dynamic: 30, static: 180 },
  },

  // `transpilePackages: ["date-fns"]` was removed 2026-09-24: date-fns is 4.1.0
  // with a proper exports map, and Next 15 already carries it in the default
  // optimizePackageImports list — transpiling only re-processed what the
  // bundler handles natively. Proven with a full local `next build` after
  // removal: compile + 284/284 static pages green. Restore if a future major
  // changes that. (date-fns-tz was never listed here and is unaffected.)

  // #1244 — the OpenNext server-handler function blew past Netlify's hard
  // 250MB per-function cap. The file tracer was pulling the entire BUILD
  // toolchain into every deployment (typescript, esbuild binaries, webpack +
  // its graph, terser): none of it is loadable at request time. Excluding it
  // sheds ~40MB with zero runtime surface.
  outputFileTracingExcludes: {
    "*": [
      "node_modules/typescript/**",
      "node_modules/@esbuild/**",
      "node_modules/esbuild/**",
      "node_modules/webpack/**",
      "node_modules/webpack-sources/**",
      "node_modules/watchpack/**",
      "node_modules/tapable/**",
      "node_modules/@xtuc/**",
      "node_modules/enhanced-resolve/**",
      "node_modules/terser/**",
      "node_modules/terser-webpack-plugin/**",
      "node_modules/schema-utils/**",
      "node_modules/jest-worker/**",
      // #1527 — server maps kept the handler at the 250MB Lambda cap. Sentry
      // turns them on and never deletes them; nothing reads them at runtime
      // (no --enable-source-maps). They stay in .next/server for the upload.
      ".next/server/**/*.map",
      // #1527 — /_next/image goes to the Netlify Image CDN, so sharp (only
      // Next's optimizer imports it) never runs in the function.
      "node_modules/sharp/**",
      "node_modules/@img/**",
    ],
  },

  // #1365 — the consumer invoice and credit-note PDFs register a Devanagari
  // face from `public/fonts/`. The tracer follows imports, and a font read at
  // render time through `path.join(process.cwd(), …)` is invisible to it, so
  // the file would be absent from the deployed function and every Hindi or
  // Marathi buyer name would render as boxes. Name the routes explicitly.
  //
  // #1468 — the same blind spot applies to `react/jsx-runtime`. The statutory
  // documents create their elements through it deliberately outside the
  // bundler (lib/pdf/react-runtime/jsx-runtime.ts), which the tracer cannot
  // see, and the only traced import of `react` is the reconciler's, which
  // reaches the package root rather than that entrypoint. Ship the package.
  outputFileTracingIncludes: {
    "/api/payments/[paymentId]/invoice/pdf": [
      "./public/fonts/**",
      "./node_modules/react/**",
    ],
    "/api/payments/[paymentId]/credit-note/[creditNoteId]/pdf": [
      "./public/fonts/**",
      "./node_modules/react/**",
    ],
    "/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pdf": [
      "./node_modules/react/**",
    ],
    "/api/organizations/[orgId]/billing-account/credit-notes/[creditNoteId]/pdf":
      ["./node_modules/react/**"],
  },

  // Prevent pg (node-postgres) and related packages from being bundled into client-side code
  // These are server-only dependencies used by @prisma/adapter-pg.
  //
  // NOTE: `@react-pdf/renderer` is intentionally NOT listed here — it is
  // already in Next's own built-in external list, so listing it was a no-op
  // (lib/pdf keeps resolving its JSX runtime past the bundler, #1468).
  serverExternalPackages: [
    "pg",
    "@prisma/adapter-pg",
    "pg-pool",
    "pg-connection-string",
    "razorpay",
    "stripe",
    "resend",
    "bcrypt",
    "@stream-io/node-sdk",
    "libsodium-wrappers",
  ],

  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      {
        hostname: "lh3.googleusercontent.com",
      },
      {
        hostname: "*.supabase.co",
      },
      {
        hostname: "avatars.githubusercontent.com",
      },
      {
        hostname: "picsum.photos",
      },
      {
        hostname: "cdn.jsdelivr.net",
      },
      {
        hostname: "upload.wikimedia.org",
      },
      {
        hostname: "img.logo.dev",
      },
    ],
  },

  // The bundle-size framing this carried as a bare `true` was wrong, and it cost
  // two investigations. SWC applies this transform to the SERVER layer as well as
  // the client — Next offers no client-only scoping (vercel/next.js#48410 is
  // unresolved) — so `true` deleted every one of ~1,110 server-side diagnostics
  // from the deployed function. Proven, not inferred: a console.warn at Prisma
  // client construction produced ZERO log lines on preview 1118 across two
  // confirmed module loads, while third-party output in the same window survived
  // (node_modules is not compiled by SWC). #1122.
  //
  // `error` and `warn` are the levels a deliberate diagnostic uses, so they stay.
  // `log` is the chatty one and keeps being stripped, which is the whole of the
  // bundle saving the original comment was after. Note this cannot be recovered
  // with Sentry's consoleLoggingIntegration: that patches globalThis.console at
  // runtime, and this deletes the call expressions at compile time.
  compiler: {
    removeConsole:
      process.env.NODE_ENV === "production"
        ? { exclude: ["error", "warn"] }
        : false,
  },

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default withSentryConfig(withBundleAnalyzer(nextConfig), {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "practitionist",

  project: "familiarise_web",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // #900 — the build/deploy must NOT fail because the Sentry source-map upload
  // failed (e.g. an expired/invalid SENTRY_AUTH_TOKEN on Netlify). With an
  // errorHandler the Sentry plugin logs and CONTINUES instead of exiting
  // non-zero; source maps just won't upload until the token is rotated, but the
  // build always succeeds. (next build succeeds locally — the upload only runs
  // where the token is set, so this surfaced as a Netlify-only build failure.)
  errorHandler: (err) => {
    console.warn(
      "[sentry] source-map upload step failed (non-fatal):",
      err?.message ?? err,
    );
  },

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  // #1792 — off on Netlify: the 2026-09-21 build OOM'd (exit 137, Killed at
  // static page 211/282) with heap already at the 8 GB container ceiling, so
  // container RSS — not heap — is the constraint. The widened client upload
  // holds the full client source-map set in memory during the finalize phase;
  // CI/dev keeps it for stack-trace quality, Netlify skips it for survival.
  widenClientFileUpload: process.env.NETLIFY !== "true",

  // Uncomment to route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  // tunnelRoute: "/monitoring",

  webpack: {
    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
