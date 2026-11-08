"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

/**
 * Tax and the total depend on the server's GST regime, so they render only once
 * the checkout context has loaded; a failed load offers a retry instead of a guess.
 */
export function TaxContextGate({
  status,
  onRetry,
  children,
}: Readonly<{
  status: "loading" | "loaded" | "failed";
  onRetry: () => void;
  children: ReactNode;
}>) {
  if (status === "loaded") return <>{children}</>;
  if (status === "loading") {
    return (
      <p className="text-sm text-muted-foreground">
        Calculating tax and total…
      </p>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <p className="text-destructive">
        We couldn&apos;t load tax for this booking.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
