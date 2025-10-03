"use client";

import React, { Component, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

/**
 * AllocationErrorBoundary - Production Error Boundary for Slot Allocation
 *
 * Catches and handles errors in the slot allocation flow, providing
 * a user-friendly error UI with recovery options.
 *
 * Features:
 * - Catches React errors in allocation components
 * - Shows user-friendly error messages
 * - Provides retry/reset functionality
 * - Logs errors for debugging
 * - Custom fallback UI support
 *
 * @example
 * ```tsx
 * <AllocationErrorBoundary onError={(error) => logToSentry(error)}>
 *   <UnifiedCalendar {...props} />
 * </AllocationErrorBoundary>
 * ```
 */
export class AllocationErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log error to console in development
    if (process.env.NODE_ENV === "development") {
      console.error("AllocationErrorBoundary caught error:", error, errorInfo);
    }

    // Call custom error handler if provided
    this.props.onError?.(error, errorInfo);

    this.setState({
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI
      return (
        <div className="flex items-center justify-center min-h-[400px] p-6">
          <Alert variant="destructive" className="max-w-2xl">
            <AlertTitle className="text-lg font-semibold mb-2">
              Something went wrong
            </AlertTitle>
            <AlertDescription className="space-y-4">
              <p className="text-sm">
                An error occurred while loading the calendar. This might be due
                to:
              </p>
              <ul className="list-disc list-inside text-sm space-y-1 ml-2">
                <li>Network connectivity issues</li>
                <li>Invalid or missing event data</li>
                <li>Server-side errors</li>
              </ul>

              {process.env.NODE_ENV === "development" &&
                this.state.error && (
                  <details className="mt-4 p-3 bg-red-50 rounded text-xs">
                    <summary className="cursor-pointer font-medium">
                      Error Details (Development Only)
                    </summary>
                    <pre className="mt-2 overflow-auto text-xs">
                      {this.state.error.toString()}
                      {this.state.errorInfo?.componentStack}
                    </pre>
                  </details>
                )}

              <div className="flex gap-2 mt-4">
                <Button onClick={this.handleReset} variant="default" size="sm">
                  Try Again
                </Button>
                <Button
                  onClick={() => window.location.reload()}
                  variant="outline"
                  size="sm"
                >
                  Reload Page
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Hook-based wrapper for functional components
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   return (
 *     <AllocationErrorBoundaryWrapper>
 *       <Calendar />
 *     </AllocationErrorBoundaryWrapper>
 *   );
 * }
 * ```
 */
export function AllocationErrorBoundaryWrapper({
  children,
  onError,
}: {
  children: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}) {
  return (
    <AllocationErrorBoundary onError={onError}>
      {children}
    </AllocationErrorBoundary>
  );
}
