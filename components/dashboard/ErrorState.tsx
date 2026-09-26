"use client";

import { AlertCircle, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";

export interface ErrorStateProps {
  title?: string;
  /** Human copy. The raw error text is never shown in production (#1527). */
  description?: ReactNode;
  /** A query refetch or a boundary reset. Never a page reload. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Next's server-error hash, shown so support can find the log line. */
  digest?: string;
  /** Development only: the caught error, printed under the description. */
  error?: unknown;
  /** A second way out, e.g. a link back to the dashboard home. */
  action?: ReactNode;
  variant?: "inline" | "page";
  className?: string;
}

const DEFAULT_DESCRIPTION =
  "Something went wrong on our side. Please try again in a moment.";

function devDetail(error: unknown): string | null {
  if (
    process.env.NODE_ENV !== "development" ||
    error === null ||
    error === undefined
  )
    return null;
  return error instanceof Error ? error.message : String(error);
}

/** The one "this failed to load" block (#1527 §15), inline or page-sized. */
export function ErrorState({
  title = "We couldn't load this",
  description = DEFAULT_DESCRIPTION,
  onRetry,
  retryLabel = "Try again",
  digest,
  error,
  action,
  variant = "inline",
  className,
}: Readonly<ErrorStateProps>) {
  const page = variant === "page";
  const Title = page ? "h2" : "p";
  const detail = devDetail(error);
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center text-center",
        page ? "px-4 py-16" : "py-8",
        className,
      )}
    >
      <AlertCircle
        className={cn(
          "mb-3 text-muted-foreground",
          page ? "h-8 w-8" : "h-6 w-6",
        )}
        aria-hidden
      />
      <Title
        className={cn(
          "font-medium text-foreground",
          page ? "text-base" : "text-sm",
        )}
      >
        {title}
      </Title>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {description}
      </p>
      {detail && (
        <p className="mt-2 max-w-md break-words font-mono text-xs text-muted-foreground">
          {detail}
        </p>
      )}
      {digest && (
        <p className="mt-2 text-xs text-muted-foreground">Error ID: {digest}</p>
      )}
      {(onRetry || action) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              <RotateCw className="mr-2 h-4 w-4" aria-hidden />
              {retryLabel}
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
