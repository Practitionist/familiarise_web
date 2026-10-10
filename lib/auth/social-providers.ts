import { AUTH_PROVIDERS, type AuthProviderId } from "@/lib/auth-providers";

type Credentials = { clientId: string; clientSecret: string };

function credentials(id: AuthProviderId): Credentials | null {
  const prefix = id.toUpperCase();
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** BetterAuth `socialProviders`: only providers whose client id and secret are set. */
export function socialProviderConfig(): Partial<
  Record<AuthProviderId, Credentials>
> {
  const config: Partial<Record<AuthProviderId, Credentials>> = {};
  for (const { id } of AUTH_PROVIDERS) {
    const creds = credentials(id);
    if (creds) config[id] = creds;
  }
  return config;
}

/** The social buttons the auth pages may render. */
export function configuredSocialProviderIds(): AuthProviderId[] {
  return AUTH_PROVIDERS.filter(({ id }) => credentials(id) !== null).map(
    ({ id }) => id,
  );
}
