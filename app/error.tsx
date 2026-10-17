"use client";

import { useEffect, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatEta } from "@/utils/formatting";

import familiariseLogo from "@/public/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif";

type MaintenancePhase = "OFF" | "DEGRADED" | "OFFLINE";

interface MaintenanceInfo {
  phase: MaintenancePhase | null;
  reason: string | null;
  estimatedEnd: string | null;
}

export default function GlobalError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const [maintenance, setMaintenance] = useState<MaintenanceInfo | null>(null);

  useEffect(() => {
    console.error("[GlobalError]", error);
    // Report client-boundary errors to Sentry — server render errors are already
    // captured by onRequestError, but a client error caught here was silent.
    Sentry.captureException(error);
  }, [error]);

  useEffect(() => {
    // #1554-follow — a single check, not the /maintenance page's polling loop:
    // this boundary only needs to know whether an active maintenance phase
    // explains the render it is already showing, not to track the phase over
    // time. /api/health is exempt from the maintenance gate (middleware.ts).
    let cancelled = false;
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setMaintenance({
          phase: data?.maintenance?.phase ?? null,
          reason: data?.maintenance?.reason ?? null,
          estimatedEnd: data?.maintenance?.estimatedEnd ?? null,
        });
      })
      .catch(() => {
        // A failed health call means the phase is genuinely unknown, so the
        // generic card below stays the honest default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isMaintenance =
    maintenance?.phase === "DEGRADED" || maintenance?.phase === "OFFLINE";

  if (isMaintenance) {
    return (
      <div className="container mx-auto flex min-h-[70vh] items-center justify-center px-4 py-12">
        <div
          data-testid="maintenance-error"
          className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-elevation-2"
        >
          <div className="mb-6">
            <Image
              src={familiariseLogo}
              alt="Familiarise"
              width={180}
              height={40}
              className="mx-auto"
              priority
            />
          </div>
          <h1 className="mb-2 text-2xl font-semibold tracking-tight text-foreground">
            We&apos;re doing scheduled maintenance
          </h1>
          <p className="mb-6 text-sm text-muted-foreground">
            {maintenance.reason ||
              "Familiarise is undergoing scheduled maintenance. We'll be back shortly with a better experience."}
          </p>
          {maintenance.estimatedEnd && (
            <div className="mb-6 rounded-xl border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                Estimated return:
              </span>{" "}
              {formatEta(maintenance.estimatedEnd)}
            </div>
          )}
          <div className="flex flex-col gap-2.5 sm:flex-row sm:justify-center">
            <Button onClick={() => reset()}>Try Again</Button>
            <Button variant="outline" asChild>
              <Link href="/">Return Home</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="generic-error"
      className="container mx-auto flex min-h-[70vh] items-center justify-center px-4 py-12"
    >
      <Card className="w-full max-w-md rounded-2xl border-border p-2 text-center shadow-elevation-2">
        <CardHeader className="pb-3">
          <div className="mx-auto mb-3 inline-flex items-center rounded-full border border-border bg-muted px-3 py-1 font-mono text-xs font-medium text-muted-foreground">
            Error
          </div>
          <CardTitle className="text-2xl font-semibold tracking-tight">
            Something went wrong
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-6">
          <p className="text-sm text-muted-foreground">
            {process.env.NODE_ENV === "development"
              ? error.message || "An unexpected error occurred."
              : "An unexpected error occurred. Please try again."}
          </p>
          {error.digest && (
            <p className="mt-3 font-mono text-xs text-muted-foreground">
              Error ID: {error.digest}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-2.5 sm:flex-row sm:justify-center">
          <Button onClick={() => reset()}>Try Again</Button>
          <Button variant="outline" asChild>
            <Link href="/">Return Home</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
