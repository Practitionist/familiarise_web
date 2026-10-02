import * as Sentry from "@sentry/nextjs";

/**
 * BetterAuth → Sentry bridge (#1856).
 *
 * BetterAuth swallows endpoint exceptions into 500 responses by design
 * (`better-auth/dist/api/index.mjs` `onError`): nothing ever throws out
 * of `app/api/auth/[...all]/route.ts`, so Next/Sentry's request-error
 * capture never fires and an auth-wide outage is invisible. Worse,
 * schema errors (`"no column"`, `"does not exist"`) take a special
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

/**
 * Messages BetterAuth logs at `error` that are AUTHENTICATION OUTCOMES,
 * not defects.
 *
 * `better-auth@1.6.5` `api/routes/sign-in.mjs` logs four of them on the
 * credential path — and three carry the submitted `{ email }`:
 *
 *   213: logger.error("User not found", { email })
 *   219: logger.error("Credential account not found", { email })
 *   225: logger.error("Password not found", { email })
 *   232: logger.error("Invalid password")
 *
 * The client response is a uniform `INVALID_EMAIL_OR_PASSWORD` for all
 * four (so no enumeration over the wire), but the log level is not
 * discriminating. Without this set every mistyped password on the
 * public sign-in form becomes a billed, paging Sentry event, and an
 * unauthenticated caller controls that volume. Upstream agrees this is
 * a bug: better-auth#9785, fixed by PR #981.
 *
 * Matching is on the exact message — BetterAuth passes `args` alongside
 * it, and the first arg is an object, never the message, so a substring
 * match would be both unnecessary and a false-positive risk if the
 * library ever rewords.
 */
const EXPECTED_AUTH_FAILURE_MESSAGES: ReadonlySet<string> = new Set([
  "Invalid password",
  "User not found",
  "Credential account not found",
  "Password not found",
  "Failed to create session",
  // `api/routes/update-user.mjs:153,158` — changePassword/setPassword
  // length refusals, raised before the hash comparison.
  "Password is too short",
  "Password is too long",
  // `api/routes/sign-up.mjs:152,157`
  "Email and password is not enabled. Make sure to enable it in the options on you `auth.ts` file. Check `https://better-auth.com/docs/authentication/email-password` for more!",
]);

/**
 * Window for the message-shaped branch, which is the SCHEMA-ERROR path
 * (`api/index.mjs:203`, `ctx.logger?.error(e.message)` — a bare string
 * with no `Error`).
 *
 * That branch is a genuine signal and worth keeping — it is how a
 * missing column announces itself. But it fires once per affected
 * request, so a pre-push or bad-migration state would emit one event
 * per sign-in attempt. That is precisely the repetition class the
 * monthly quota guard in `sentry.shared.config.ts` exists for.
 *
 * `captureThrottled` cannot wrap this branch: it forwards to
 * `reportSentryError`, which is `captureException` only
 * (`lib/observability/report.ts:83`). Hence the local map, same shape
 * and same process-local rationale (a shared limiter needs the downed
 * dependency to answer, and Redis is the outage being guarded).
 */
const SCHEMA_MESSAGE_THROTTLE_MS = 5 * 60 * 1000;
const SCHEMA_MESSAGE_THROTTLE_MAX_KEYS = 100;
const lastSchemaMessageAtByKey = new Map<string, number>();

export function reportAuthLogToSentry(
  level: AuthLogLevel,
  message: string,
  ...args: unknown[]
): void {
  if (level === "error") {
    // Preserve today's console behavior (Netlify function logs). This
    // runs BEFORE every filter below on purpose: the Netlify function
    // log is the one signal operators can grep during an incident, and
    // the emails in `args` are useful there. Nothing below sends
    // `args` anywhere.
    console.error(`[Better Auth]: ${message}`, ...args);

    // An authentication outcome, not a fault. Console already has it.
    if (EXPECTED_AUTH_FAILURE_MESSAGES.has(message)) return;

    // Forward to Sentry. The schema-error branch passes the message
    // string with no Error object, so both shapes are handled: a real
    // Error (with stack) wins, otherwise the message is the event.
    const err = args.find((a) => a instanceof Error);
    if (err) {
      Sentry.captureException(err, {
        tags: { subsystem: "auth" },
        extra: { authLog: message },
      });
      return;
    }

    // Message-shaped: trickle per distinct message, not a firehose.
    const now = Date.now();
    if (
      now - (lastSchemaMessageAtByKey.get(message) ?? 0) <
      SCHEMA_MESSAGE_THROTTLE_MS
    ) {
      return;
    }
    // Messages can carry variable text, so the map is capped. When full, drop
    // expired keys; if it is still full, skip Sentry (console has it) rather
    // than reset, which would let every cycle of 101 messages through again.
    if (lastSchemaMessageAtByKey.size >= SCHEMA_MESSAGE_THROTTLE_MAX_KEYS) {
      for (const [key, at] of lastSchemaMessageAtByKey) {
        if (now - at >= SCHEMA_MESSAGE_THROTTLE_MS) {
          lastSchemaMessageAtByKey.delete(key);
        }
      }
      if (lastSchemaMessageAtByKey.size >= SCHEMA_MESSAGE_THROTTLE_MAX_KEYS) {
        return;
      }
    }
    lastSchemaMessageAtByKey.set(message, now);
    Sentry.captureMessage(`[better-auth] ${message}`, {
      tags: { subsystem: "auth" },
      level: "error",
    });
    return;
  }
  if (level === "warn") {
    console.warn(`[Better Auth]: ${message}`, ...args);
    return;
  }
  console.log(`[Better Auth]: ${message}`, ...args);
}

/** Test hook: reset the schema-message throttle between cases. */
export function __resetAuthLoggerThrottleForTests(): void {
  lastSchemaMessageAtByKey.clear();
}
