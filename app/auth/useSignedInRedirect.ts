"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { forgetAuthState } from "@/lib/auth-remembered";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";

type SignedInUser = NonNullable<
  ReturnType<typeof authClient.useSession>["data"]
>["user"];

/**
 * Sends a signed-in visitor off an auth page. The session store can still hold
 * a user whose server session was revoked (a soft navigation never refetches),
 * and the server guards would send that visitor straight back here, so the
 * session is re-read first and a dead one is forgotten instead of followed.
 */
export function useSignedInRedirect(
  storeUser: SignedInUser | undefined,
  refetch: () => unknown,
  targetFor: (user: SignedInUser) => string,
): void {
  const router = useRouter();
  useEffect(() => {
    if (!storeUser) return;
    let cancelled = false;
    void authClient.getSession().then(({ data, error }) => {
      if (cancelled) return;
      // A failed read (503) keeps the store's view rather than stranding the page.
      const user = error ? storeUser : data?.user;
      if (!user) {
        forgetAuthState();
        refetch();
        return;
      }
      // Server pages treat an operator without 2FA as signed out.
      router.replace(
        isOperatorRole(user.role) && user.twoFactorEnabled !== true
          ? "/auth/two-factor/setup"
          : targetFor(user),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [storeUser, refetch, targetFor, router]);
}
