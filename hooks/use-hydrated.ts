"use client";

import { useSyncExternalStore } from "react";

const subscribeNever = () => () => {};

/**
 * #1527 QA — false for the server render AND hydration, true after. Better
 * Auth's store hands a resolved session to a Suspense boundary that hydrates
 * late, so anything rendered from `useSession()` must wait for this or the
 * client prints what the server never rendered (#418).
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}
