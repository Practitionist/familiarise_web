"use client";

import { createContext, useContext } from "react";
import type { AuthProviderId } from "@/lib/auth-providers";

const SocialProvidersContext = createContext<readonly AuthProviderId[]>([]);

/** Supplies the social providers whose credentials the server has configured. */
export function SocialProvidersProvider({
  providers,
  children,
}: Readonly<{
  providers: readonly AuthProviderId[];
  children: React.ReactNode;
}>) {
  return (
    <SocialProvidersContext.Provider value={providers}>
      {children}
    </SocialProvidersContext.Provider>
  );
}

export function useConfiguredSocialProviders(): readonly AuthProviderId[] {
  return useContext(SocialProvidersContext);
}
