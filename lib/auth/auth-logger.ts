import * as Sentry from "@sentry/nextjs";

/**
 * BetterAuth → Sentry bridge (#1856).
 *
 * BetterAuth swallows endpoint exceptions into 500 responses by design
 * (`better-auth/dist/api/index.mjs` `onError`): nothing ever throws out
 * of `app/api/auth/[...all]/route.ts`, so Next/Sentry's request-error
 * capture never fires and an auth-wide outage is invisible. Worse,
 * schema errors (`"no column"`, `"does not exist"`…) take a special
 * branch that logs the message string only and returns — which is
 * exactly why the pre-push missing-column 500s never reached Sentry.
 *
 * Wired as the `logger` option in `lib/auth.ts`. Only `error` forwards
 * to Sentry; every level keeps its current console behavior so Netlify
 * function logs are unchanged. Console output is replicated here
 * because providing `log` replaces the default console writer for all
 * levels at or above the threshold.
 *
 * Unit-tested in `__tests__/auth/auth-logger.test.ts`.
 */
type AuthLogLevel = "debug" | "info" | "warn" | "error";

export function reportAuthLogToSentry(
  level: AuthLogLevel,
  message: string,
  ...args: unknown[]
): void {
  if (level === "error") {
    // Preserve today's console behavior (Netlify function logs).
    console.error(`[Better Auth]: ${message}`, ...args);
    // Forward to Sentry. The schema-error branch passes the message
    // string with no Error object, so both shapes are handled: a real
    // Error (with stack) wins, otherwise the message is the event.
    const err = args.find((a) => a instanceof Error);
    if (err) {
      Sentry.captureException(err, {
        tags: { subsystem: "auth" },
        extra: { authLog: message },
      });
    } else {
      Sentry.captureMessage(`[better-auth] ${message}`, {
        tags: { subsystem: "auth" },
        level: "error",
      });
    }
    return;
  }
  if (level === "warn") {
    console.warn(`[Better Auth]: ${message}`, ...args);
    return;
  }
  console.log(`[Better Auth]: ${message}`, ...args);
}
