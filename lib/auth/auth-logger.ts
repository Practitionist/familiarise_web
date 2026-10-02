import * as Sentry from "@sentry/nextjs";

/**
 * BetterAuth → Sentry bridge (#1856).
 *
 * Forwards `error`-level logs to Sentry while suppressing expected
 * authentication outcomes (wrong password, unknown user, etc.) and throttling
 * schema-error message strings.
 */
type AuthLogLevel = "debug" | "info" | "warn" | "error";

const EXPECTED_AUTH_FAILURE_MESSAGES: ReadonlySet<string> = new Set([
  "Invalid password",
  "User not found",
  "Credential account not found",
  "Password not found",
  "Failed to create session",
  "Password is too short",
  "Password is too long",
  "Email and password is not enabled. Make sure to enable it in the options on you `auth.ts` file. Check `https://better-auth.com/docs/authentication/email-password` for more!",
]);

const SCHEMA_MESSAGE_THROTTLE_MS = 5 * 60 * 1000;
const SCHEMA_MESSAGE_THROTTLE_MAX_KEYS = 100;
const lastSchemaMessageAtByKey = new Map<string, number>();

export function reportAuthLogToSentry(
  level: AuthLogLevel,
  message: string,
  ...args: unknown[]
): void {
  if (level === "error") {
    console.error(`[Better Auth]: ${message}`, ...args);

    if (EXPECTED_AUTH_FAILURE_MESSAGES.has(message)) return;

    const err = args.find((a) => a instanceof Error);
    if (err) {
      Sentry.captureException(err, {
        tags: { subsystem: "auth" },
        extra: { authLog: message },
      });
      return;
    }

    const now = Date.now();
    if (
      now - (lastSchemaMessageAtByKey.get(message) ?? 0) <
      SCHEMA_MESSAGE_THROTTLE_MS
    ) {
      return;
    }
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
