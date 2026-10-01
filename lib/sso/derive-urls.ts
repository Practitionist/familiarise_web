/**
 * BetterAuth auto-mounts the OIDC redirect route from the `sso()` plugin.
 * Keep this derivation in sync with the plugin's default endpoint template —
 * changing the path here without a matching override in `lib/auth.ts` will
 * break the IdP-setup instructions shown to org workspace operators in the
 * Add Provider dialog.
 *
 * The path below was read out of `node_modules/@better-auth/sso@1.7.6`
 * (`dist/index.mjs` mounts `/sso/callback/:providerId`; the shared
 * `/sso/callback` is in `disabledPaths`). `basePath` is not set in `lib/auth.ts`, so
 * BetterAuth's `/api/auth` default applies.
 *
 * Re-run that check on every `@better-auth/sso` bump. The version this file
 * was last verified against is 1.7.6.
 *
 * The helper is pure so it can be unit-tested without a DOM / React
 * runtime. See `__tests__/sso/derive-urls.test.ts`.
 */

export function deriveCallbackUrl(
  providerId: string,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL ?? "",
): string {
  const slug = providerId || "<provider-id>";
  return `${baseUrl}/api/auth/sso/callback/${slug}`;
}
