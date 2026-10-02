import * as Sentry from "@sentry/nextjs";
import { scrubStringValue } from "@/lib/observability/sentry-scrubber";

/**
 * BetterAuth → Sentry bridge (#1856, #1876).
 *
 * Forwards `error`-level logs to Sentry while suppressing expected
 * authentication outcomes (wrong password, unknown user, etc.), scrubbing
 * submitted email addresses / credentials from console and Sentry logs, and
 * throttling schema-error message strings.
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

const AUTH_SECRET_KEY_RX =
  /^(?:password|passwd|token|secret|authorization|cookie|code)$/i;

function sanitizeAuthLogArg(arg: unknown, depth = 0): unknown {
  if (depth > 4) return arg;
  if (typeof arg === "string") return scrubStringValue(arg);
  if (arg instanceof Error) return arg;
  if (Array.isArray(arg)) {
    return arg.map((item) => sanitizeAuthLogArg(item, depth + 1));
  }
  if (arg && typeof arg === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
      if (/^email$/i.test(k)) {
        out[k] =
          typeof v === "string" ? scrubStringValue(v) : "[REDACTED_EMAIL]";
      } else if (AUTH_SECRET_KEY_RX.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = sanitizeAuthLogArg(v, depth + 1);
      }
    }
    return out;
  }
  return arg;
}

export function reportAuthLogToSentry(
  level: AuthLogLevel,
  message: string,
  ...args: unknown[]
): void {
  const safeMessage = scrubStringValue(message);
  const safeArgs = args.map((a) => sanitizeAuthLogArg(a));

  if (level === "error") {
    console.error(`[Better Auth]: ${safeMessage}`, ...safeArgs);

    if (EXPECTED_AUTH_FAILURE_MESSAGES.has(message)) return;

    const err = args.find((a) => a instanceof Error);
    if (err) {
      Sentry.captureException(err, {
        tags: { subsystem: "auth" },
        extra: { authLog: safeMessage },
      });
      return;
    }

    const now = Date.now();
    if (
      now - (lastSchemaMessageAtByKey.get(safeMessage) ?? 0) <
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
    lastSchemaMessageAtByKey.set(safeMessage, now);
    Sentry.captureMessage(`[better-auth] ${safeMessage}`, {
      tags: { subsystem: "auth" },
      level: "error",
    });
    return;
  }
  if (level === "warn") {
    console.warn(`[Better Auth]: ${safeMessage}`, ...safeArgs);
    return;
  }
  console.log(`[Better Auth]: ${safeMessage}`, ...safeArgs);
}

/** Test hook: reset the schema-message throttle between cases. */
export function __resetAuthLoggerThrottleForTests(): void {
  lastSchemaMessageAtByKey.clear();
}
