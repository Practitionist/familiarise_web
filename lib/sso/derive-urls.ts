/**
 * The OIDC redirect URI the sso() plugin mounts, `/sso/callback/:providerId`
 * under BetterAuth's `/api/auth` base on `BETTER_AUTH_URL` (the plugin's
 * `ctx.context.baseURL`). Server-only: the API hands it to the settings page.
 */
export function deriveCallbackUrl(
  providerId: string,
  baseUrl: string = process.env.BETTER_AUTH_URL ?? "",
): string {
  const slug = providerId || "<provider-id>";
  return `${baseUrl}/api/auth/sso/callback/${slug}`;
}
