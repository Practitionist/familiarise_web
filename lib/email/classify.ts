// #1298 — Resend failures that no retry can fix. Each entry is a reason slug
// the Sentry fingerprint groups on, so a dead key pages once, not per email.
const TERMINAL_PATTERNS: ReadonlyArray<[reason: string, pattern: RegExp]> = [
  ["invalid_api_key", /api key is invalid/i],
  ["domain_not_verified", /domain is not verified/i],
  ["not_verified", /not verified/i],
  ["validation_error", /validation_error/i],
  ["invalid_from", /invalid `from`/i],
  ["restricted_api_key", /restricted_api_key/i],
];

/** `name: message` for a Resend error body, so the name survives into lastError. */
export function resendErrorText(error: {
  name?: string | null;
  message?: string | null;
}): string {
  const message = error.message || "Resend API error";
  return error.name ? `${error.name}: ${message}` : message;
}

/** The reason slug for a terminal Resend error, or null when a retry may help. */
export function terminalSendReason(
  message: string | null | undefined,
): string | null {
  if (!message) return null;
  const hit = TERMINAL_PATTERNS.find(([, pattern]) => pattern.test(message));
  return hit ? hit[0] : null;
}

export function isTerminalSendError(
  message: string | null | undefined,
): boolean {
  return terminalSendReason(message) !== null;
}

// Their body carries a live single-use code or link, so the outbox stores it
// redacted and the relay never replays it; the user requests a fresh one.
const CREDENTIAL_EMAIL_TYPES: ReadonlySet<string> = new Set([
  "EMAIL_VERIFICATION",
  "PASSWORD_RESET",
]);

export const REDACTED_CREDENTIAL_BODY =
  "[redacted: this email carried a single-use credential]";

export function carriesCredential(emailType: string): boolean {
  return CREDENTIAL_EMAIL_TYPES.has(emailType);
}
