/**
 * Mail a stranger can aim at any address by typing it into a public auth form.
 * A forgot-password request for an unenrolled operator sends STAFF_INVITE, so
 * it is capped too, in its own bucket so reset floods cannot spend it.
 */
export const RECIPIENT_CAPPED_EMAIL_TYPES: ReadonlySet<string> = new Set([
  "EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "EXISTING_ACCOUNT_SIGN_UP",
  "STAFF_INVITE",
]);

/** Per address, per email type, per rolling 24 hours. Client-safe: the auth pages quote it. */
export const RECIPIENT_DAILY_CAP = 5;
