import * as Sentry from "@sentry/nextjs";
import { isProductionEnvironment } from "@/utils/env";

export const dynamic = "force-dynamic";

class SentryExampleAPIError extends Error {
  constructor(message: string | undefined) {
    super(message);
    this.name = "SentryExampleAPIError";
  }
}

// A faulty API route to test Sentry's error monitoring
export function GET() {
  // Verify-only fault route — never expose the permanent 500 in production.
  if (isProductionEnvironment()) {
    return new Response("Not Found", { status: 404 });
  }

  Sentry.logger.info("Sentry example API called");
  throw new SentryExampleAPIError(
    "This error is raised on the backend called by the example page.",
  );
}
