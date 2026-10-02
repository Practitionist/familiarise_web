"use client";

/**
 * Shared body for the app-router `error.tsx` boundaries of the dashboard
 * trees (organization / consultant / consultee).
 *
 * Next.js 15 requires a file-convention `error.tsx` per segment to catch
 * errors thrown during server rendering or from React Server Components —
 * the in-shell `DashboardErrorBoundary` only catches client-side throws
 * after hydration. The three route files stay as thin wrappers (the file
 * convention demands a default export per segment) and delegate here so
 * the Sentry capture, structured logging, and recovery UI can't drift
 * apart.
 *
 * The `digest` is the hash Next assigns to server-thrown errors so ops can
 * correlate a user-facing "Error ID" with the server log line.
 */

import * as Sentry from "@sentry/nextjs";
import { useEffect, startTransition } from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/dashboard/ErrorState";

export interface DashboardRouteErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  /** Log-line scope, e.g. "dashboard/consultant". */
  scope: string;
  /** Structured-log event name, e.g. "consultant_dashboard_error". */
  event: string;
  /** The route param identifying the entity (orgId / consultantId / …). */
  entityKey: string;
  entityId: string;
  title: string;
  devFallbackMessage: string;
  /** Escape link rendered next to "Try again". */
  escape: { href: string; label: string };
}

// A cold instance's connect timeout surfaces as a server-thrown
// 503; one silent refresh usually heals it, a second failure shows the card.
const autoRetried = new Map<string, number>();
const AUTO_RETRY_WINDOW_MS = 30_000;

// A server-thrown error needs fresh RSC data before reset() can render past it.
function refreshAndReset(
  router: Pick<ReturnType<typeof useRouter>, "refresh">,
  reset: () => void,
) {
  startTransition(() => {
    router.refresh();
    reset();
  });
}

export function DashboardRouteError({
  error,
  reset,
  scope,
  event,
  entityKey,
  entityId,
  title,
  devFallbackMessage,
  escape,
}: DashboardRouteErrorProps) {
  const router = useRouter();

  // Read on every render, not decided once per mount: a failed retry can come
  // back as an update of this same instance, and it must then show the card.
  // Only server-thrown errors (digest) with no attempt in the last 30 s.
  const retryKey =
    error.digest && typeof window !== "undefined"
      ? `${window.location.pathname}|${error.digest}`
      : null;
  const lastAttempt = retryKey ? autoRetried.get(retryKey) : undefined;
  const autoRetrying =
    retryKey !== null &&
    (lastAttempt === undefined ||
      Date.now() - lastAttempt >= AUTO_RETRY_WINDOW_MS);

  useEffect(() => {
    if (!autoRetrying || !retryKey) return;
    const t = setTimeout(() => {
      // Recorded when the retry fires, so StrictMode's remount can't spend it.
      autoRetried.set(retryKey, Date.now());
      refreshAndReset(router, reset);
    }, 1000);
    return () => clearTimeout(t);
  }, [autoRetrying, retryKey, router, reset]);

  // A self-healed blip must not spend Sentry quota.
  useEffect(() => {
    if (autoRetrying) return;
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "client" } },
    );
    console.error(
      JSON.stringify({
        event,
        scope,
        [entityKey]: entityId,
        digest: error.digest ?? null,
        message: error.message,
      }),
    );
  }, [autoRetrying, error, event, scope, entityKey, entityId]);

  if (autoRetrying) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Reconnecting…
      </div>
    );
  }

  // #1527: the shell owns the gutter, so no public-page geometry here.
  return (
    <ErrorState
      variant="page"
      title={title}
      description="An unexpected error occurred. Please try again."
      error={error.message ? error : devFallbackMessage}
      digest={error.digest}
      onRetry={() => refreshAndReset(router, reset)}
      action={
        <Button variant="outline" size="sm" asChild>
          <Link href={escape.href}>{escape.label}</Link>
        </Button>
      }
    />
  );
}
