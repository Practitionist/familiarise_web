"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { BackofficeSurface } from "@/lib/auth/backoffice-permissions";
import { can, type BackofficeCapability } from "@/lib/backoffice/capability";

type CapabilityValue = BackofficeCapability & {
  can: (surface: BackofficeSurface) => boolean;
};

const BackofficeCapabilityContext = createContext<CapabilityValue | null>(null);

/**
 * #1527 — the server layout resolves the capability once and every console
 * component reads it here, instead of threading `isAdmin`/`tree`/`basePath`
 * props through each page.
 */
export function BackofficeCapabilityProvider({
  value,
  children,
}: Readonly<{ value: BackofficeCapability; children: ReactNode }>) {
  const ctx = useMemo<CapabilityValue>(
    () => ({ ...value, can: (surface) => can(value, surface) }),
    [value],
  );
  return (
    <BackofficeCapabilityContext.Provider value={ctx}>
      {children}
    </BackofficeCapabilityContext.Provider>
  );
}

export function useBackofficeCapability(): CapabilityValue {
  const ctx = useContext(BackofficeCapabilityContext);
  if (!ctx) {
    throw new Error(
      "useBackofficeCapability must be used inside the back-office layout",
    );
  }
  return ctx;
}
