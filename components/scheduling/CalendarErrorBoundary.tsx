import { captureClientException } from "@/lib/observability/client-capture";
import React, { Component, ErrorInfo, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Called after the boundary resets, so the host can remount and refetch. */
  onRetry?: () => void;
}

interface State {
  hasError: boolean;
}

const RELOAD_FLAG = "fw:calendar:chunk-reload-at";
const RELOAD_GUARD_MS = 10 * 60 * 1000;

/**
 * Reload once for a missing chunk; a second failure within the guard shows
 * the retry copy instead of looping (a deploy skew can outlive the CDN).
 */
function reloadOnceForChunk(): void {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_FLAG) ?? "0");
    if (Date.now() - last < RELOAD_GUARD_MS) return;
    window.sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch {
    // Without storage the loop cannot be guarded, so do not reload at all.
    return;
  }
  window.location.reload();
}

/** A failed code-split chunk only recovers by loading the page again. */
function isChunkLoadError(error: Error): boolean {
  return (
    error.name === "ChunkLoadError" ||
    /Loading chunk [\w-]+ failed/.test(error.message)
  );
}

/**
 * Keeps a calendar crash from taking the page with it. The screen gets plain
 * copy; the exception goes to Sentry and the console.
 */
class CalendarErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false };

  public static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    captureClientException(error, { tags: { subsystem: "client" } });
    console.error("Uncaught error in calendar:", error, errorInfo);
    if (isChunkLoadError(error) && typeof window !== "undefined") {
      reloadOnceForChunk();
    }
  }

  private handleRetry = () => {
    this.setState({ hasError: false });
    this.props.onRetry?.();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div role="alert" className="rounded-md bg-red-50 p-4 text-red-800">
          <h2 className="font-bold">The calendar stopped working</h2>
          <p className="mt-2 text-sm">
            We couldn&apos;t show this calendar. Try again, or reload the page
            if it keeps happening.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={this.handleRetry}
            className="mt-4"
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default CalendarErrorBoundary;
