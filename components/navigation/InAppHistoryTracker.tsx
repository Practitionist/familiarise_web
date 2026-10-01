"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { recordInAppNavigation } from "@/lib/navigation/in-app-history";

/**
 * Records every pathname change so BackNavigationButton can decide whether
 * `router.back()` stays inside the app. Renders nothing.
 */
export default function InAppHistoryTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname) recordInAppNavigation(pathname);
  }, [pathname]);

  return null;
}
