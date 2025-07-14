"use client";

import { Suspense } from "react";
import { DashboardHomeSkeleton } from "@/components/ui/dashboard-skeleton";

interface SuspenseWrapperProps {
  children: React.ReactNode;
  fallback?: React.ComponentType;
}

export function SuspenseWrapper({
  children,
  fallback: FallbackComponent,
}: SuspenseWrapperProps) {
  const fallbackElement = FallbackComponent ? (
    <FallbackComponent />
  ) : (
    <DashboardHomeSkeleton />
  );

  return <Suspense fallback={fallbackElement}>{children}</Suspense>;
}

// Specific suspense wrappers for different use cases
export function DashboardSuspenseWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  return <Suspense fallback={<DashboardHomeSkeleton />}>{children}</Suspense>;
}

export function TableSuspenseWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <div className="space-y-4">
          <div className="h-8 bg-gray-200 rounded animate-pulse" />
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

export function FormSuspenseWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <div className="space-y-4 max-w-md">
          <div className="h-6 bg-gray-200 rounded animate-pulse" />
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-4 bg-gray-200 rounded animate-pulse w-24" />
                <div className="h-10 bg-gray-100 rounded animate-pulse" />
              </div>
            ))}
          </div>
          <div className="h-10 bg-gray-200 rounded animate-pulse w-24" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
