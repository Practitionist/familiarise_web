/**
 * Centralized OAuth provider configuration.
 *
 * To add or remove a provider:
 * 1. Update `socialProviders` + `trustedProviders` in `lib/auth.ts`
 * 2. Add/remove entry here
 * 3. Add/remove icon in `components/auth/auth-icons.tsx` + PROVIDER_ICONS map
 * 4. Set the provider's env vars (CLIENT_ID + CLIENT_SECRET)
 */
export const AUTH_PROVIDERS = [
  {
    id: "github" as const,
    label: "GitHub",
    className: "bg-black hover:bg-gray-700",
  },
  {
    id: "google" as const,
    label: "Google",
    className: "bg-red-600 hover:bg-red-500",
  },
  {
    id: "facebook" as const,
    label: "Facebook",
    className: "bg-blue-600 hover:bg-blue-500",
  },
] as const;

export type AuthProviderId = (typeof AUTH_PROVIDERS)[number]["id"];
