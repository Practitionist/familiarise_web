"use client";

import { useMemo } from "react";

import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";
import { dataConsentHref } from "@/lib/dashboard/account-href";

import { createHandleApiError } from "./utils";

/** The checkout API error toaster, with the viewer's own consent link. */
export function useHandleApiError(toast: ReturnType<typeof useToast>["toast"]) {
  const { data: session } = useSession();
  const consentHref = session?.user ? dataConsentHref(session.user) : null;
  return useMemo(
    () => createHandleApiError(toast, consentHref),
    [toast, consentHref],
  );
}
