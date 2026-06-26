"use client";

/**
 * App-router error boundary for `/dashboard/organization/[orgId]/**`.
 *
 * Next.js 15 requires a file-convention `error.tsx` to catch errors thrown
 * during server rendering or from React Server Components. The existing
 * `DashboardErrorBoundary` in the layout only catches client-side throws
 * after hydration — it can't recover from SSR failures or navigation
 * errors, which is why we need this separate boundary at the route level.
 *
 * The `digest` on the error is the hash Next assigns to server-thrown
 * errors so ops can correlate a user-facing "Error ID" with the server
 * log. We log a structured payload so `orgId` shows up in the log line,
 * without depending on any logger abstraction.
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

export default function OrgDashboardError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const params = useParams<{ orgId: string }>();
  const orgId = params?.orgId ?? "unknown";

  useEffect(() => {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
    console.error(
      JSON.stringify({
        event: "org_dashboard_error",
        scope: "dashboard/organization",
        orgId,
        digest: error.digest ?? null,
        message: error.message,
      }),
    );
  }, [error, orgId]);

  return (
    <div className="container mx-auto pt-24 py-8 px-4 min-h-[calc(100vh-400px)]">
      <Card className="max-w-2xl mx-auto text-center">
        <CardHeader>
          <CardTitle>Something went wrong in this organization</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            {process.env.NODE_ENV === "development"
              ? error.message ||
                "An unexpected error occurred while loading the organization dashboard."
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
            <Link href="/dashboard">Switch organization</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
