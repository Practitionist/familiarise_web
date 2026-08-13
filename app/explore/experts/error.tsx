"use client";

import ExploreError from "../components/ExploreError";

// Load-bearing under the rethrow policy: the page's reads no longer degrade
// to empty rows (#1119), so a transient failure on a cache MISS throws and
// must land here instead of replacing the whole app shell via app/error.tsx.
// Named ExpertsError, not Error — shadowing the Error global is a Sonar
// reliability bug (S2137), and Next.js only requires the default export.
export default function ExpertsError(
  props: Readonly<{
    error: Error & { digest?: string };
    reset: () => void;
  }>,
) {
  return (
    <ExploreError
      {...props}
      fallbackMessage="An error occurred while loading the experts."
    />
  );
}
