"use client";

import Link from "next/link";

/**
 * Degraded state for the expert detail page when a transient cross-region DB
 * timeout (#932) stops the profile loading — shown in place of a hard crash so
 * the visitor gets a retriable surface, not a 500. (FAMILIARISE_WEB-A)
 */
export function ConsultantUnavailable() {
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
            This profile is taking a moment to load
          </h1>
          <p className="text-muted-foreground">
            We couldn&apos;t reach this profile just now. It&apos;s usually
            temporary — please try again in a few seconds.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
