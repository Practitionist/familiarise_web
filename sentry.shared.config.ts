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

export function initSentry(): void {
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
  });
}
