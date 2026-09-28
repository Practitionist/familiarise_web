/**
 * BetterAuth auto-mounts these routes from the `sso()` plugin. Keep this
 * derivation in sync with the plugin's default endpoint templates — changing
 * the paths here without a matching override in `lib/auth.ts` will break the
 * IdP-setup instructions shown to org workspace operators in the Add Provider dialog.
 *
 * Every path below was read out of `node_modules/@better-auth/sso@1.6.5`, not
 * recalled from a later version. `basePath` is not set in `lib/auth.ts`, so
 * BetterAuth's `/api/auth` default applies:
 *
 *   - OIDC redirect  — `dist/index.mjs:2700` `/sso/callback/:providerId`
 *   - SAML ACS       — `dist/index.mjs:2784` `/sso/saml2/sp/acs/:providerId`,
 *     and `:2797` independently rebuilds the same string as
 *     `currentCallbackPath`, which is what the assertion is validated against
 *   - SP metadata    — `dist/index.mjs:1823` `/sso/saml2/sp/metadata`, which
 *     reads `providerId` from the **query** (`:1836`), hence the `?providerId=`
 *     below rather than a path segment
 *
 * Re-run that check on every `@better-auth/sso` bump. The version this file
 * was last verified against is 1.6.5.
 *
 * These helpers are pure so they can be unit-tested without a DOM / React
 * runtime. See `__tests__/sso/derive-urls.test.ts`.
 */

export type SsoProviderType = "saml" | "oidc" | null;

export function deriveAcsUrl(
  providerId: string,
  type: SsoProviderType,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL ?? "",
): string {
  const slug = providerId || "<provider-id>";
  return type === "oidc"
    ? `${baseUrl}/api/auth/sso/callback/${slug}`
    : `${baseUrl}/api/auth/sso/saml2/sp/acs/${slug}`;
}

export function deriveMetadataUrl(
  providerId: string,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL ?? "",
): string {
  const slug = providerId || "<provider-id>";
  return `${baseUrl}/api/auth/sso/saml2/sp/metadata?providerId=${slug}`;
}
