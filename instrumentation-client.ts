// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { isNotDevelopmentEnvironment, isProductionEnvironment } from "@/utils/env";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  // No DSN => Sentry fully disabled. Also gated off in local `next dev` so a
  // developer's .env DSN doesn't flood the shared prod project with dev noise.
  enabled: Boolean(dsn) && isNotDevelopmentEnvironment(),
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: isProductionEnvironment() ? 0.1 : 1,
  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: false,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
