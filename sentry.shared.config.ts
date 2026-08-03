// Shared Sentry.init() for all three runtimes (server / edge / client).
//
// The three Sentry entrypoints used to carry byte-identical init config; they
// differ only in that the client also exports onRouterTransitionStart. This
// centralizes the one config so a sampling/PII/env tweak lands in one place. (#913)

import * as Sentry from "@sentry/nextjs";
import {
  isNotDevelopmentEnvironment,
  isProductionEnvironment,
} from "@/utils/env";

type SentryInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;

/**
 * `overrides` is layered on last and exists for ONE caller: the cron-job runner
 * in lib/observability/job-sentry.ts, which runs in a bare Node process where
 * NODE_ENV is unset and so the gating below reads differently than it does for
 * the app. No app entrypoint passes it, so their behaviour is unchanged. (#1066)
 */
export function initSentry(overrides?: Partial<SentryInitOptions>): void {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

  Sentry.init({
    dsn,
    // No DSN => Sentry fully disabled. Also gated off in local `next dev` so a
    // developer's .env DSN doesn't flood the shared prod project with dev noise.
    enabled: Boolean(dsn) && isNotDevelopmentEnvironment(),
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,

    // Sample 10% of traces in production; everything outside production.
    tracesSampleRate: isProductionEnvironment() ? 0.1 : 1,

    // Send structured logs to Sentry.
    enableLogs: true,

    // Never attach PII to events.
    sendDefaultPii: false,

    // Drop non-actionable third-party noise before it reaches the dashboard.
    // - "Connection closed." — RSC flight-stream abort when a client navigates
    //   away mid-stream (react-server-dom-webpack). (FAMILIARISE_WEB-E)
    // - "func ... not found" / inpage.js — injected browser wallet extensions
    //   throwing inside their own provider bridge on our pages. (FAMILIARISE_WEB-F)
    // - "Object Not Found Matching Id" — CefSharp / Outlook Safe Links bots
    //   rejecting non-Error promises while scanning our pages. (FAMILIARISE_WEB-Y)
    // Do NOT add the Prisma pooler-timeout strings here: route-level fail-open
    // already degrades them to breadcrumbs, and they must stay visible so a NEW
    // unprotected route surfacing them is still detectable. (#932)
    ignoreErrors: [
      "Connection closed.",
      /func .* not found/,
      /inpage\.js/,
      /Object Not Found Matching Id/i,
    ],

    // Events whose top stack frame originates in an injected extension script
    // are never our code — drop them regardless of message.
    denyUrls: [
      /inpage\.js/,
      /extensions\//i,
      /^chrome-extension:\/\//i,
      /^moz-extension:\/\//i,
      /^safari-extension:\/\//i,
      /^safari-web-extension:\/\//i,
    ],

    // Last, so a caller can narrow a knob it has better information about.
    // Undefined spreads to nothing, which is what every app entrypoint does.
    ...overrides,
  });
}
