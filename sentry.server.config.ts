// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
//
// Init config lives in sentry.shared.config.ts (shared across runtimes — #913).

import { setAfterCapture } from "@/lib/observability/report";
import { scheduleSentryFlush } from "@/lib/observability/serverless-flush";
import { initSentry } from "./sentry.shared.config";

initSentry();

// A Netlify function can freeze as soon as it responds, so every server-side
// capture schedules a bounded flush (`after()` inside a request).
if (process.env.NETLIFY) {
  setAfterCapture(() => scheduleSentryFlush());
}
