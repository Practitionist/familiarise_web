"use client";

/**
 * App-router error boundary for `/dashboard/consultant/[consultantId]/**`.
 *
 * Catches errors thrown during server rendering or from React Server
 * Components (e.g. a failed SSR prefetch in a feature `page.tsx`). The
 * `DashboardErrorBoundary` inside the shell only catches client-side
 * throws after hydration — it can't recover from SSR failures, which is
 * why this route-level boundary exists (same pattern as the organization
 * dashboard's error.tsx).
 */

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function ConsultantDashboardError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const params = useParams<{ consultantId: string }>();
  const consultantId = params?.consultantId ?? "unknown";

  useEffect(() => {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "client" } },
    );
    console.error(
      JSON.stringify({
        event: "consultant_dashboard_error",
        scope: "dashboard/consultant",
        consultantId,
        digest: error.digest ?? null,
        message: error.message,
      }),
    );
  }, [error, consultantId]);

  return (
    <div className="container mx-auto pt-24 py-8 px-4 min-h-[calc(100vh-400px)]">
      <Card className="max-w-2xl mx-auto text-center">
        <CardHeader>
          <CardTitle>Something went wrong in your dashboard</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            {process.env.NODE_ENV === "development"
              ? error.message ||
                "An unexpected error occurred while loading the consultant dashboard."
              : "An unexpected error occurred. Please try again."}
          </p>
          {error.digest && (
            <p className="text-xs text-muted-foreground mt-2">
              Error ID: {error.digest}
            </p>
          )}
        </CardContent>
        <CardFooter className="justify-center space-x-4">
          <Button variant="outline" onClick={() => reset()}>
            Try again
          </Button>
          <Button variant="outline" asChild>
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
