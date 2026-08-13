"use client";

import ExploreError from "../components/ExploreError";

// Named ProgramsError, not Error — shadowing the Error global is a Sonar
// reliability bug (S2137), and Next.js only requires the default export.
export default function ProgramsError(
  props: Readonly<{
    error: Error & { digest?: string };
    reset: () => void;
  }>,
) {
  return (
    <ExploreError
      {...props}
      fallbackMessage="An error occurred while loading the programs."
    />
  );
}
