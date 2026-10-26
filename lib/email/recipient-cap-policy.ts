/** Mail a stranger can aim at any address by typing it into a public auth form. */
export const RECIPIENT_CAPPED_EMAIL_TYPES: ReadonlySet<string> = new Set([
  "EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "EXISTING_ACCOUNT_SIGN_UP",
]);

/** Per address, per email type, per rolling 24 hours. Client-safe: the auth pages quote it. */
export const RECIPIENT_DAILY_CAP = 5;
