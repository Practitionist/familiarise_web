"use client";

import ExploreError from "../components/ExploreError";

export default function Error(
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
