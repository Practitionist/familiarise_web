"use client";

import { createContext, useContext, useMemo } from "react";
import { useSession } from "@/lib/auth-client";
import { EMI_MIN_PAISE } from "@/lib/payments/client/checkout-options";

/**
 * Server-only checkout flags, handed to the client by the checkout layout.
 *
 * The plan pages are client components with no server parent of their own, so
 * a context is the one seam that reaches both the Checkout sheet and the order
 * summary. The default keeps EMI hidden if the provider is ever missing.
 */
interface CheckoutFlags {
  emiEnabled: boolean;
}

const CheckoutFlagsContext = createContext<CheckoutFlags>({
  emiEnabled: false,
});

export function CheckoutFlagsProvider({
  emiEnabled,
  children,
}: Readonly<{ emiEnabled: boolean; children: React.ReactNode }>) {
  const value = useMemo(() => ({ emiEnabled }), [emiEnabled]);
  return (
    <CheckoutFlagsContext.Provider value={value}>
      {children}
    </CheckoutFlagsContext.Provider>
  );
}

export function useCheckoutFlags(): CheckoutFlags {
  return useContext(CheckoutFlagsContext);
}

/**
 * #1780 row 1 — the instalment line under the total. Only a gateway-paid
 * checkout (no organisation, or PERSONAL funding) can offer bank EMI.
 */
export function EmiHint({
  totalPaise,
  organizationId,
}: Readonly<{ totalPaise: number; organizationId?: string | null }>) {
  const { emiEnabled } = useCheckoutFlags();
  const { data: session } = useSession();
  const memberships = session?.user?.organizationMemberships ?? [];
  const fundingSource = organizationId
    ? memberships.find((m) => m.organizationId === organizationId)
        ?.fundingSource
    : null;
  const gatewayPaid = !fundingSource || fundingSource === "PERSONAL";

  if (!emiEnabled || !gatewayPaid || totalPaise < EMI_MIN_PAISE) return null;
  return (
    <p className="text-xs text-muted-foreground">
      or pay in instalments with your bank
    </p>
  );
}
