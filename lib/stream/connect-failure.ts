/**
 * What a failed Stream connect should tell the person in front of it, and
 * whether the provider should keep trying.
 *
 * The chat and video SDKs reject `connectUser` with an Error whose MESSAGE is
 * a JSON blob — `{"code":16,"StatusCode":404,"message":"WS failed with code 16
 * and reason - the user … was deactivated","isWSFailure":false}`. The provider
 * used to render that string verbatim and then retry it five times with
 * backoff, for both clients, on every dashboard page: one deactivated seed
 * account produced three Sentry error shapes per page load and a Retry button
 * that could never succeed.
 *
 * Stream's own `APIErrorCodes` table (stream-chat/src/errors.ts, not exported
 * at runtime) marks these codes non-retryable; the test pins this copy to it.
 * Code 16 (`DoesNotExistError`) on a connect means the user id itself cannot
 * connect — deactivated, deleted, or never created because the upsert was
 * refused — so it is an account state, not an outage.
 */
export type ConnectFailureKind =
  | "account-disabled"
  | "not-retryable"
  | "retryable";

export interface ConnectFailure {
  kind: ConnectFailureKind;
  /** Stream API error code when the failure carried one. */
  code: number | null;
  /** The raw message, for Sentry and the debug dialog — never for the UI. */
  detail: string;
  title: string;
  description: string;
  /** What the empty state offers: a retry that can succeed, a reload, or support. */
  action: "retry" | "reload" | "support";
}

/** Codes Stream marks `retryable: false` that a connect can surface. */
export const NON_RETRYABLE_STREAM_CODES: ReadonlySet<number> = new Set([
  2, 4, 6, 16, 17, 18, 19, 20, 21, 22, 24, 40, 41, 42, 43, 44, 46, 69, 70, 99,
]);

const ACCOUNT_DISABLED_CODE = 16;

function readStreamError(error: unknown): {
  code: number | null;
  message: string;
} {
  const e = error as { code?: unknown; message?: unknown } | null;
  const message =
    typeof e?.message === "string" ? e.message : String(error ?? "");
  if (typeof e?.code === "number") return { code: e.code, message };
  // The WS path stringifies its payload into Error.message.
  if (message.startsWith("{")) {
    try {
      const parsed = JSON.parse(message) as {
        code?: unknown;
        message?: unknown;
      };
      return {
        code: typeof parsed.code === "number" ? parsed.code : null,
        message: typeof parsed.message === "string" ? parsed.message : message,
      };
    } catch {
      // Not JSON after all; fall through with the raw text.
    }
  }
  return { code: null, message };
}

export const RETRYABLE_CONNECT_FAILURE: ConnectFailure = {
  kind: "retryable",
  code: null,
  detail: "",
  title: "Chat is unavailable",
  description:
    "We couldn't connect to the messaging service. Check your connection and try again.",
  action: "retry",
};

export function classifyConnectFailure(error: unknown): ConnectFailure {
  const { code, message } = readStreamError(error);
  if (code === ACCOUNT_DISABLED_CODE) {
    return {
      kind: "account-disabled",
      code,
      detail: message,
      title: "Messaging is turned off for this account",
      description:
        "Your account can't use chat or video calls right now. If you think this is a mistake, contact support and we'll sort it out.",
      action: "support",
    };
  }
  if (code !== null && NON_RETRYABLE_STREAM_CODES.has(code)) {
    return {
      kind: "not-retryable",
      code,
      detail: message,
      title: "Chat is unavailable",
      description:
        "Messaging couldn't be set up for your account. Reloading usually fixes this; if it doesn't, contact support.",
      action: "reload",
    };
  }
  return { ...RETRYABLE_CONNECT_FAILURE, code, detail: message };
}
