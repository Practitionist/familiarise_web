"use client";

import { CloudOff, Loader2, UsersRound, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  JOIN_FAILURE_COPY,
  MAX_PROVIDER_AUTO_RETRIES,
  type JoinFailureKind,
} from "../join-failure";

interface JoinFailureCardProps {
  kind: JoinFailureKind;
  /** The underlying error text, shown beneath the guidance for support. */
  detail?: string;
  /** True while a retry is in flight. */
  isRetrying: boolean;
  /** Automatic retries spent so far; omit where nothing retries by itself. */
  autoRetryCount?: number;
  onRetry: () => void;
  /** `page` fills the viewport; `inline` sits inside the lobby card. */
  variant?: "page" | "inline";
}

const ICONS = {
  provider_unavailable: CloudOff,
  room_full: UsersRound,
  unknown: TriangleAlert,
} as const;

/** The designed face for a join that failed for a reason other than a typed refusal. */
export function JoinFailureCard({
  kind,
  detail,
  isRetrying,
  autoRetryCount,
  onRetry,
  variant = "page",
}: Readonly<JoinFailureCardProps>) {
  const copy = JOIN_FAILURE_COPY[kind];
  const Icon = ICONS[kind];
  const autoRetrying =
    kind === "provider_unavailable" &&
    autoRetryCount !== undefined &&
    autoRetryCount < MAX_PROVIDER_AUTO_RETRIES;

  const body = (
    <div
      data-testid="join-failure-card"
      data-failure-kind={kind}
      role="alert"
      className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-xl"
    >
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
        <Icon className="h-8 w-8 text-amber-600 dark:text-amber-400" />
      </div>
      <h2 className="mb-2 text-xl font-bold text-foreground">{copy.title}</h2>
      <p className="mb-3 text-muted-foreground">{copy.guidance}</p>
      {kind === "unknown" && detail && (
        <p className="mb-3 text-xs text-muted-foreground/70">{detail}</p>
      )}
      {autoRetrying && (
        <p
          data-testid="join-failure-auto-retry"
          className="mb-3 text-xs text-muted-foreground"
        >
          {isRetrying
            ? "Trying again…"
            : `Retrying automatically (${(autoRetryCount ?? 0) + 1} of ${MAX_PROVIDER_AUTO_RETRIES})…`}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Button
          onClick={onRetry}
          disabled={isRetrying}
          data-testid="join-retry"
        >
          {isRetrying ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Retrying…
            </>
          ) : (
            "Retry"
          )}
        </Button>
        {variant === "page" && (
          <Button variant="outline" onClick={() => window.history.back()}>
            Go Back
          </Button>
        )}
      </div>
    </div>
  );

  if (variant === "inline") return body;
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted p-4">
      {body}
    </div>
  );
}
