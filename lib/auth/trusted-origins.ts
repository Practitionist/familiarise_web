/** The origins Better Auth trusts, from BETTER_AUTH_TRUSTED_ORIGINS (comma-separated). */
export function betterAuthTrustedOrigins(): string[] {
  return (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
