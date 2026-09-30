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
    className:
      "bg-zinc-900/90 hover:bg-zinc-800 border border-white/10 text-white font-medium h-11 rounded-xl transition-colors",
  },
  {
    id: "google" as const,
    label: "Google",
    className:
      "bg-zinc-900/90 hover:bg-zinc-800 border border-white/10 text-white font-medium h-11 rounded-xl transition-colors",
  },
  {
    id: "facebook" as const,
    label: "Facebook",
    className:
      "bg-zinc-900/90 hover:bg-zinc-800 border border-white/10 text-white font-medium h-11 rounded-xl transition-colors",
  },
] as const;

export type AuthProviderId = (typeof AUTH_PROVIDERS)[number]["id"];
