"use client";

import { Skeleton } from "@/components/ui/skeleton";

// Generic page skeleton with title and content
export function PageSkeleton() {
  return (
    <div className="p-6 lg:p-8">
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

// Chat page skeleton
/**
 * Chat loading state.
 *
 * Sized to the same box the real chat surface occupies. It previously had NO
 * height — just `flex-1 flex m-4` — which only fills the viewport if the parent
 * is a flex container with a height. `loading.tsx` renders it as the whole
 * route, outside the `h-[calc(100dvh-…)]` wrapper the live `MessagesTab`
 * applies, so it collapsed to content height and covered a fraction of the
 * screen. The height calc here mirrors that wrapper: full viewport minus the
 * context bar, and minus the mobile tab bar below `md`.
 *
 * Colours are theme tokens rather than the hardcoded indigo it used to carry,
 * so it stops being the one light-only surface in a dark dashboard.
 */
export function ChatSkeleton() {
  return (
    <div className="-m-4 flex h-[calc(100dvh-3.5rem-4rem)] overflow-hidden border-border bg-card sm:-m-6 md:h-[calc(100dvh-3.5rem)] lg:-m-8">
      {/* Channel list */}
      <div className="hidden w-72 shrink-0 space-y-4 border-r border-border p-4 sm:block">
        <Skeleton className="h-10 w-full" />
        <div className="space-y-2">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="flex items-center gap-3 p-2">
              <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Conversation */}
      <div className="flex flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border p-4">
          <Skeleton className="h-10 w-10 rounded-full" />
          <Skeleton className="h-5 w-40" />
        </div>

        <div className="flex-1 space-y-4 overflow-hidden p-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-3">
              <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
              <div className="space-y-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          ))}
          {[1, 2].map((i) => (
            <div key={`out-${i}`} className="flex items-start justify-end gap-3">
              <div className="space-y-1 text-right">
                <Skeleton className="ml-auto h-4 w-40" />
                <Skeleton className="ml-auto h-3 w-24" />
              </div>
              <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            </div>
          ))}
        </div>

        <div className="border-t border-border p-4">
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </div>
  );
}

// Documents/Table page skeleton
export function TableSkeleton() {
  return (
    <div className="p-6 lg:p-8">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-10 w-32" />
        </div>

        {/* Table header */}
        <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
          <div className="border-b border-zinc-100 p-4">
            <div className="flex items-center gap-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20" />
            </div>
          </div>

          {/* Table rows */}
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="border-b border-zinc-100 p-4 last:border-0">
              <div className="flex items-center gap-4">
                <Skeleton className="h-10 w-10 rounded" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-6 w-20 rounded-full" />
                <Skeleton className="h-8 w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Requests page skeleton
export function RequestsSkeleton() {
  return (
    <div className="flex flex-col lg:flex-row gap-6 p-6 lg:p-8">
      {/* Left panel */}
      <div className="flex-1 space-y-4">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="bg-white rounded-xl border border-zinc-200 p-4 space-y-3"
          >
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
            <div className="flex gap-2">
              {[1, 2, 3].map((j) => (
                <Skeleton key={j} className="h-8 w-20" />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Right panel */}
      <div className="w-full lg:w-80 space-y-4">
        <Skeleton className="h-8 w-32" />
        <div className="bg-white rounded-xl border border-zinc-200 p-4 space-y-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Home dashboard skeleton
export function HomeSkeleton() {
  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-zinc-100/80 backdrop-blur-xl border-b border-zinc-200/50 px-6 py-4 lg:px-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64 mt-1" />
      </div>

      {/* Content */}
      <div className="px-6 py-6 lg:px-8 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="bg-white rounded-xl border border-zinc-200 p-5"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-8 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-11 w-11 rounded-xl" />
              </div>
            </div>
          ))}
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5">
              <Skeleton className="h-6 w-40 mb-4" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-32 rounded-xl" />
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5">
              <Skeleton className="h-6 w-32 mb-4" />
              <div className="space-y-3">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-9 w-9 rounded-full" />
                    <div className="flex-1 space-y-1">
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Settings skeleton
export function SettingsSkeleton() {
  return (
    <div className="p-6 lg:p-8">
      <div className="space-y-6 max-w-3xl">
        <div className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-64" />
        </div>

        {[1, 2, 3].map((section) => (
          <div
            key={section}
            className="bg-white rounded-xl border border-zinc-200 p-6 space-y-4"
          >
            <Skeleton className="h-6 w-40" />
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-10 w-24" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Help skeleton
export function HelpSkeleton() {
  return (
    <div className="min-h-screen bg-white">
      <div className="w-full px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <div className="animate-pulse space-y-6 sm:space-y-10">
          {/* Header */}
          <div className="space-y-4 sm:space-y-6">
            <div className="flex items-start sm:items-center gap-3 sm:gap-4">
              <Skeleton className="h-11 w-11 sm:h-14 sm:w-14 rounded-xl sm:rounded-2xl shrink-0" />
              <div className="space-y-1.5 sm:space-y-2">
                <Skeleton className="h-7 sm:h-8 w-36 sm:w-48" />
                <Skeleton className="h-4 w-56 sm:w-72" />
              </div>
            </div>

            {/* Search */}
            <Skeleton className="h-10 sm:h-12 w-full lg:max-w-xl rounded-lg sm:rounded-xl" />

            {/* Category filters */}
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton
                  key={i}
                  className="h-8 sm:h-10 w-20 sm:w-24 rounded-full"
                />
              ))}
            </div>
          </div>

          {/* FAQ Groups */}
          {[1, 2, 3].map((group) => (
            <div
              key={group}
              className="bg-zinc-50/50 border border-zinc-100 rounded-xl sm:rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4"
            >
              <div className="flex items-center gap-2.5 sm:gap-3">
                <Skeleton className="h-9 w-9 sm:h-10 sm:w-10 rounded-lg sm:rounded-xl shrink-0" />
                <div className="space-y-1">
                  <Skeleton className="h-4 sm:h-5 w-24 sm:w-28" />
                  <Skeleton className="h-3 w-16 sm:w-20" />
                </div>
              </div>
              <div className="space-y-1.5 sm:space-y-2">
                {[1, 2].map((item) => (
                  <Skeleton
                    key={item}
                    className="h-12 sm:h-14 w-full rounded-lg sm:rounded-xl"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Planner/Calendar skeleton
export function PlannerSkeleton() {
  return (
    <div className="px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
      <div className="space-y-6 sm:space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 sm:gap-0">
          <div className="space-y-1.5 sm:space-y-2">
            <Skeleton className="h-7 sm:h-8 w-40 sm:w-48" />
            <Skeleton className="h-4 w-56 sm:w-64" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 sm:h-10 w-full sm:w-32" />
            <Skeleton className="h-9 sm:h-10 w-full sm:w-32" />
          </div>
        </div>

        {/* Event cards grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4 sm:gap-5 lg:gap-6">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="bg-white rounded-xl border border-zinc-200 p-4 sm:p-5 space-y-3"
            >
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 sm:h-12 sm:w-12 rounded-lg sm:rounded-xl shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 sm:h-5 w-full max-w-[150px]" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
              <Skeleton className="h-10 sm:h-12 w-full" />
              <div className="flex justify-between items-center pt-2">
                <Skeleton className="h-5 sm:h-6 w-16 sm:w-20" />
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            </div>
          ))}
        </div>

        {/* Stats section */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="bg-zinc-50/80 rounded-xl sm:rounded-2xl p-4 sm:p-5"
            >
              <Skeleton className="h-3 sm:h-4 w-20 sm:w-24 mb-2" />
              <Skeleton className="h-6 sm:h-8 w-12 sm:w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
