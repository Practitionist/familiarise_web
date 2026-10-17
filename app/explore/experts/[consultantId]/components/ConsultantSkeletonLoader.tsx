import React from "react";
import { Skeleton } from "@/components/ui/skeleton";

export const ConsultantSkeletonLoader: React.FC = () => {
  return (
    <div
      className="explore-page min-h-screen"
      aria-busy="true"
      aria-label="Loading expert profile"
    >
      {/* Main Content Area */}
      <div className="explore-profile w-full px-4 md:px-8 lg:px-12 py-8 md:py-12">
        <Skeleton className="mb-6 h-5 w-40" />
        <div className="flex flex-col xl:flex-row gap-8 xl:gap-12">
          {/* Left Column (Main) */}
          <div className="flex-1 min-w-0 space-y-8">
            {/* Profile Header Skeleton */}
            <div className="rounded-2xl border border-border bg-card p-6 md:p-8 space-y-6">
              <div className="flex flex-col md:flex-row gap-6 items-start">
                <Skeleton className="w-32 h-32 md:w-40 md:h-48 rounded-xl flex-shrink-0 md:order-last" />
                <div className="flex-1 space-y-4 w-full">
                  <div className="space-y-2">
                    <Skeleton className="h-8 w-1/2 md:w-1/3" />
                    <Skeleton className="h-5 w-3/4 md:w-1/2" />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Skeleton className="h-6 w-20 rounded-full" />
                    <Skeleton className="h-6 w-24 rounded-full" />
                    <Skeleton className="h-6 w-16 rounded-full" />
                  </div>
                </div>
              </div>
            </div>

            {/* Offering preview */}
            <div className="rounded-2xl border border-border bg-card p-6 md:p-8 space-y-4">
              <Skeleton className="h-7 w-40" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            </div>

            {/* About */}
            <div className="rounded-2xl border border-border bg-card p-6 md:p-8 space-y-4">
              <Skeleton className="h-7 w-48" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Skeleton className="h-24 rounded-xl" />
                <Skeleton className="h-24 rounded-xl" />
              </div>
            </div>
          </div>

          {/* Right Column (Sidebar - Pricing) */}
          <div className="w-full xl:w-[450px] 2xl:w-[500px] flex-shrink-0">
            <div className="bg-card rounded-2xl p-6 shadow-sm border border-border space-y-6">
              {/* Tabs */}
              <div className="flex bg-muted p-1 rounded-xl">
                <Skeleton className="h-10 w-1/2 rounded-lg bg-card shadow-sm" />
                <Skeleton className="h-10 w-1/2 rounded-lg bg-transparent" />
              </div>

              {/* Plan choices and price */}
              <div className="space-y-4">
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-10 w-32" />
              </div>

              {/* Inclusions and purchase actions */}
              <div className="space-y-2">
                <Skeleton className="h-12 w-full rounded-xl" />
                <Skeleton className="h-12 w-full rounded-xl" />
                <Skeleton className="h-12 w-full rounded-xl" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
