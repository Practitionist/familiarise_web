import { useState, useEffect } from "react";

/**
 * Browser-zone detection with a loading state. Distinct from
 * `useViewerZone` (session-resolved zone, no loading state) — the two are
 * not aliases. Lives here (not in a route folder) so onboarding, settings
 * and the expert profile share one copy.
 */

export function useTimezone() {
  const [timezone, setTimezone] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    try {
      // Get timezone on client side
      const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // console.log("Browser timezone detected:", browserTimezone);
      setTimezone(browserTimezone);
    } catch (error) {
      console.error("Error detecting timezone:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { timezone, isLoading };
}
