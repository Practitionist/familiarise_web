"use client";

import { use, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Button } from "@/components/ui/button";

import { ResourcesTab } from "./ResourcesTab";
import { EventResourceCard, type EventResource } from "./EventResourceCard";

interface BookingResources {
  consultations: EventResource[];
  subscriptions: EventResource[];
  webinars: EventResource[];
  classes: EventResource[];
  trials?: EventResource[];
  purchased?: EventResource[];
}

export type ConsulteeRecordingCategory =
  "all" | "webinar" | "class" | "consultation" | "subscription" | "purchased";

const RECORDING_CATEGORIES: {
  value: ConsulteeRecordingCategory;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "webinar", label: "Webinar" },
  { value: "class", label: "Class" },
  { value: "consultation", label: "Consultation" },
  { value: "subscription", label: "Subscription" },
  { value: "purchased", label: "Purchased" },
];

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}

export function ConsulteeRecordingsPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = use(params);
  const [category, setCategory] = useState<ConsulteeRecordingCategory>("all");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["consultee-recordings", consulteeId],
    queryFn: async () => {
      const { data } = await getJson<{ data: BookingResources }>(
        `/api/dashboard/consultee/${consulteeId}/resources`,
      );
      return {
        ...data,
        trials: data.trials ?? [],
        purchased: data.purchased ?? [],
      };
    },
    staleTime: 5 * 60 * 1000,
  });

  const scopedData = useMemo(() => {
    if (!data) return undefined;
    const purchasedItems = data.purchased ?? [];
    if (category === "webinar") {
      return {
        consultations: [],
        subscriptions: [],
        webinars: data.webinars,
        classes: [],
        trials: [],
      };
    }
    if (category === "class") {
      return {
        consultations: [],
        subscriptions: [],
        webinars: [],
        classes: data.classes,
        trials: [],
      };
    }
    if (category === "consultation") {
      return {
        consultations: data.consultations,
        subscriptions: [],
        webinars: [],
        classes: [],
        trials: [],
      };
    }
    if (category === "subscription") {
      return {
        consultations: [],
        subscriptions: data.subscriptions,
        webinars: [],
        classes: [],
        trials: [],
      };
    }
    if (category === "purchased") {
      return {
        consultations: [],
        subscriptions: [],
        webinars: purchasedItems,
        classes: [],
        trials: [],
      };
    }
    return data;
  }, [data, category]);

  if (isLoading) return <PageSkeleton />;

  if (error) {
    return (
      <ErrorState
        title="Couldn't load recordings"
        description="This is a loading problem, not an empty library."
        error={error}
        onRetry={() => void refetch()}
      />
    );
  }

  const purchasedItems = data?.purchased ?? [];

  return (
    <DashboardErrorBoundary>
      <div className="space-y-4">
        <div
          role="tablist"
          aria-label="Recording categories"
          className="flex flex-wrap items-center gap-1.5"
        >
          {RECORDING_CATEGORIES.map((tab) => (
            <Button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={category === tab.value}
              variant={category === tab.value ? "default" : "outline"}
              size="sm"
              onClick={() => setCategory(tab.value)}
            >
              {tab.label}
              {tab.value === "purchased" && purchasedItems.length > 0
                ? ` (${purchasedItems.length})`
                : ""}
            </Button>
          ))}
        </div>

        {category === "purchased" && purchasedItems.length > 0 ? (
          <div className="space-y-4">
            {purchasedItems.map((event) => (
              <EventResourceCard
                key={event.id}
                event={event}
                artifact="recordings"
              />
            ))}
          </div>
        ) : (
          <ResourcesTab
            data={scopedData}
            artifact="recordings"
            title="Recordings"
            subtitle="Recordings of the sessions you've attended and purchased replays"
          />
        )}
      </div>
    </DashboardErrorBoundary>
  );
}
