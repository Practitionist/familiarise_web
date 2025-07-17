import { useState, useEffect } from "react";

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
