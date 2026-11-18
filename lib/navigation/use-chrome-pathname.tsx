"use client";

import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

const MARKER = "familiarise-chrome-path";
const noSubscription = () => () => {};

/**
 * Records the path the server rendered the chrome for. The prerendered root
 * not-found renders as `/_not-found` while the browser is on the real URL.
 */
export function ChromePathMarker() {
  const pathname = usePathname();
  return <meta name={MARKER} content={pathname} suppressHydrationWarning />;
}

const serverRenderedPath = () =>
  document.querySelector(`meta[name="${MARKER}"]`)?.getAttribute("content") ??
  null;

/**
 * The path the site chrome decides on: while hydrating, the one the server
 * rendered (so the markup matches), then the real one.
 */
export function useChromePathname(): string {
  const pathname = usePathname();
  return useSyncExternalStore(
    noSubscription,
    () => pathname,
    () =>
      typeof document === "undefined"
        ? pathname
        : (serverRenderedPath() ?? pathname),
  );
}
