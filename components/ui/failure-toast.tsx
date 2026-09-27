"use client";

import { ToastAction } from "@/components/ui/toast";
import type { ClientFailure } from "@/lib/errors/classification/client-failure";

/**
 * Renders a classified failure as a toast payload.
 *
 * The classifier is a plain `.ts` module so it stays testable and importable
 * from anywhere; the retry affordance is JSX, so it lives here. Spread the
 * result straight into `toast()` — that keeps every catch block one line and
 * stops the copy drifting between the four join surfaces.
 *
 * A stale deploy keeps its Refresh action: loading the current build is the
 * only fix. Any other failure re-runs through `onRetry` instead of reloading
 * the page and losing what the user had on screen (#1527).
 */
export function failureToast(
  failure: ClientFailure,
  opts: { onRetry?: () => void } = {},
) {
  const { onRetry } = opts;
  return {
    title: failure.title,
    description: failure.description,
    // A stale deploy is not the user's fault and reads better as information
    // than as an error.
    variant: failure.offerReload
      ? ("warning" as const)
      : ("destructive" as const),
    ...(failure.offerReload
      ? {
          action: (
            <ToastAction
              altText="Refresh the page to load the current version"
              onClick={() => window.location.reload()}
            >
              Refresh
            </ToastAction>
          ),
        }
      : onRetry
        ? {
            action: (
              <ToastAction altText="Try again" onClick={onRetry}>
                Try again
              </ToastAction>
            ),
          }
        : {}),
  };
}
