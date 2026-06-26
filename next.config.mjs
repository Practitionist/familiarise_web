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
 * Content Security Policy — report-only by default.
 *
 * Why report-only first
 * ---------------------
 * A strict CSP can silently break Stream.io's call-widget script
 * injection or a Razorpay popup if any allow-list entry drifts. We
 * land in report-only so the dashboard surface stays functional while
 * we observe `Content-Security-Policy-Report-Only` violations at
 * `/api/csp-report` for a rollout window. Flip `ENABLE_CSP_ENFORCE=true`
 * once telemetry is clean to switch the header name to the enforcing
 * variant.
 *
 * Allow-list rationale
 * --------------------
 *   - `script-src` includes Razorpay's checkout CDN + Stream.io +
 *     Sentry + Supabase + 'unsafe-inline'/'unsafe-eval' (Next.js still
 *     emits inline runtime chunks; Next 15 hashing lands in 16).
 *   - `connect-src` opens WSS for Stream + HTTPS for the four payment
 *     gateways + Sentry + Resend + Upstash. Anything new must be
 *     added here AND in the matching client.
 *   - `frame-src` allows Razorpay's checkout iframe.
 *   - `media-src` is the load-bearing entry for Stream call audio /
 *     video / recording playback (`blob:` + getstream.io).
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com https://*.sentry.io https://*.getstream.io https://*.supabase.co",
  "connect-src 'self' https://*.getstream.io wss://*.getstream.io https://*.supabase.co https://*.upstash.io https://api.razorpay.com https://*.sentry.io https://api.resend.com https://*.novu.co wss://*.novu.co",
  "img-src 'self' data: https: blob:",
  "media-src 'self' blob: https://*.getstream.io",
  "style-src 'self' 'unsafe-inline'",
  "frame-src 'self' https://checkout.razorpay.com",
  "font-src 'self' data:",
  "report-uri /api/csp-report",
].join("; ");

const CSP_HEADER_KEY =
  process.env.ENABLE_CSP_ENFORCE === "true"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";

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
  // CSP (report-only by default; flipped to enforce via env flag — see
  // CSP_HEADER_KEY above). Pre-req for any large-customer security review.
  { key: CSP_HEADER_KEY, value: CSP_DIRECTIVES },
];

const nextConfig = {
  // Reduce Webpack memory usage during builds (Next.js 15+, low-risk experimental)
  experimental: {
    webpackMemoryOptimizations: true,
    optimizePackageImports: [
      "lucide-react",
      "framer-motion",
      "@stream-io/video-react-sdk",
      "stream-chat-react",
      "recharts",
      "date-fns",
      "@radix-ui/react-icons",
    ],
    // Next 15 defaults page segments to 0, which refetches RSC on every nav; this lets the client router cache hold payloads ~30s between navs.
    staleTimes: { dynamic: 30, static: 180 },
  },

  // This tells Next.js to explicitly process these packages during the build, which should resolve the module format conflict.
  transpilePackages: ["date-fns"],

  // Prevent pg (node-postgres) and related packages from being bundled into client-side code
  // These are server-only dependencies used by @prisma/adapter-pg
  serverExternalPackages: [
    "pg",
    "@prisma/adapter-pg",
    "pg-pool",
    "pg-connection-string",
    "@react-pdf/renderer",
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

  // Reduce JavaScript bundle size by removing console statements in production
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
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
  widenClientFileUpload: true,

  // Uncomment to route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  // tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
