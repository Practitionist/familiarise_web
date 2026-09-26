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
import { useEffect } from "react";
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
  useEffect(() => {
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
  }, [error, event, scope, entityKey, entityId]);

  // #1527: the shell owns the gutter, so no public-page geometry here.
  return (
    <ErrorState
      variant="page"
      title={title}
      description="An unexpected error occurred. Please try again."
      error={error.message ? error : devFallbackMessage}
      digest={error.digest}
      onRetry={reset}
      action={
        <Button variant="outline" size="sm" asChild>
          <Link href={escape.href}>{escape.label}</Link>
        </Button>
      }
    />
  );
}
