"use client";

import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UnscheduledEventCard } from "./UnscheduledEventCard";
import type { SectionQueryState } from "../../../types";

export interface UnscheduledEventItem {
  id: string;
  title: string;
  subtitle: string;
  onSetSchedule: () => void;
}

interface UnscheduledEventsSectionProps {
  title: string;
  items: UnscheduledEventItem[];
  /** Query state for this section — renders its own skeleton/error inline. */
  state?: SectionQueryState;
}

/**
 * "Unscheduled Classes/Webinars" block embedded at the top of the matching
 * type section of the appointments list. Owns its own loading/error
 * rendering so a slow events query can't blank the rest of the page.
 */
export function UnscheduledEventsSection({
  title,
  items,
  state,
}: UnscheduledEventsSectionProps) {
  if (state?.isLoading) {
    return (
      <div className="mb-4">
        <Skeleton className="h-4 w-48 mb-3" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    );
  }

  if (state?.isError) {
    return (
      <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 p-4 flex items-center justify-between gap-3">
        <p className="text-sm text-orange-800">
          Couldn&apos;t load {title.toLowerCase()}.
        </p>
        <Button variant="outline" size="sm" onClick={state.onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (items.length === 0) return null;

  return (
    <div className="mb-4">
      <h4 className="text-sm font-semibold text-orange-700 mb-3 flex items-center gap-2">
        <Clock className="h-4 w-4" />
        {title} ({items.length})
      </h4>
      <div className="space-y-3">
        {items.map((item) => (
          <UnscheduledEventCard
            key={item.id}
            title={item.title}
            subtitle={item.subtitle}
            onSetSchedule={item.onSetSchedule}
          />
        ))}
      </div>
    </div>
  );
}
