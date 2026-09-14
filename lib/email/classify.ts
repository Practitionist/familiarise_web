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

// #1298 — how long a replayed link is still clickable. Mirrors lib/auth.ts:
// emailVerification.expiresIn = 3600 s, resetPasswordTokenExpiresIn = 1800 s.
export const EMAIL_TTL_MS: Record<string, number> = {
  EMAIL_VERIFICATION: 60 * 60 * 1000,
  PASSWORD_RESET: 30 * 60 * 1000,
};

/** True when a dead-lettered row of this type carries a link that has expired. */
export function isExpiredForReplay(
  emailType: string,
  createdAt: Date,
  now: Date,
): boolean {
  const ttl = EMAIL_TTL_MS[emailType];
  if (ttl === undefined) return false;
  return now.getTime() - createdAt.getTime() > ttl;
}
