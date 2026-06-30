"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import Link from "next/link";

/**
 * Segment error boundary for the expert detail page. The known cross-region
 * transient (#932) is caught upstream in page.tsx and never reaches here, so
 * anything that lands in this boundary is a genuine defect — report it and give
 * the visitor a retry instead of falling through to the global crash page.
 */
export default function ExpertProfileError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="bg-muted min-h-screen">
      <div className="bg-card border-b border-border">
        <div className="w-full px-4 py-4 md:px-8 lg:px-12">
          <Link
            href="/explore/experts"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Back to experts
          </Link>
        </div>
      </div>
      <div className="flex w-full items-center justify-center px-4 py-24 md:px-8 lg:px-12">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-semibold text-foreground">
            Something went wrong
          </h1>
          <p className="text-muted-foreground">
            We hit an unexpected error loading this profile. Please try again.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-2 inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
