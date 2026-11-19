// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
//
// Init config lives in sentry.shared.config.ts (shared across runtimes — #913).

import * as Sentry from "@sentry/nextjs";
import { flushAfterEveryServerEvent } from "@/lib/observability/serverless-flush";
import { initSentry } from "./sentry.shared.config";

initSentry();

// A Netlify function can freeze once it responds, so every server error or
// message event schedules a bounded flush. No client exists during `next build`.
const client = process.env.NETLIFY ? Sentry.getClient() : undefined;
if (client) flushAfterEveryServerEvent(client);
