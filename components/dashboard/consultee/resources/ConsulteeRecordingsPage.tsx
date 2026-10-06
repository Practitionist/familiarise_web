"use client";

import { use, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  "all" | "consultation" | "subscription" | "webinar" | "class" | "purchased";

const RECORDING_CATEGORIES: {
  value: ConsulteeRecordingCategory;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "consultation", label: "Consultation" },
  { value: "subscription", label: "Subscription" },
  { value: "webinar", label: "Webinar" },
  { value: "class", label: "Class" },
  { value: "purchased", label: "Purchased" },
];

export function isPurchasedClassRecording(item: EventResource): boolean {
  if (item.classId) return true;
  if (item.webinarId) return false;
  const tag = (
    item.offeringType ??
    item.sourceType ??
    item.eventType ??
    ""
  ).toLowerCase();
  if (tag === "class" || tag === "classes" || tag === "purchased_class") {
    return true;
  }
  if (tag === "webinar" || tag === "webinars" || tag === "purchased_webinar") {
    return false;
  }
  return /\bclass\b/i.test(item.id) || /\bclass\b/i.test(item.planTitle);
}

function mergeUniqueEvents(
  primary: EventResource[],
  additional: EventResource[],
): EventResource[] {
  const seen = new Set(primary.map((item) => item.id));
  const merged = [...primary];
  for (const item of additional) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

function matchesSearch(event: EventResource, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (event.planTitle.toLowerCase().includes(q)) return true;
  if ((event.consultantName ?? "").toLowerCase().includes(q)) return true;
  return event.recordings.some((r) => r.title.toLowerCase().includes(q));
}

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
  const [searchQuery, setSearchQuery] = useState("");

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
    const purchasedClasses = purchasedItems.filter(isPurchasedClassRecording);
    const purchasedWebinars = purchasedItems.filter(
      (item) => !isPurchasedClassRecording(item),
    );
    const filterBySearch = (items: EventResource[]) =>
      items.filter((item) => matchesSearch(item, searchQuery));

    const allWebinars = mergeUniqueEvents(data.webinars, purchasedWebinars);
    const allClasses = mergeUniqueEvents(data.classes, purchasedClasses);

    if (category === "webinar") {
      return {
        consultations: [],
        subscriptions: [],
        webinars: filterBySearch(allWebinars),
        classes: [],
        trials: [],
      };
    }
    if (category === "class") {
      return {
        consultations: [],
        subscriptions: [],
        webinars: [],
        classes: filterBySearch(allClasses),
        trials: [],
      };
    }
    if (category === "consultation") {
      return {
        consultations: filterBySearch(data.consultations),
        subscriptions: [],
        webinars: [],
        classes: [],
        trials: [],
      };
    }
    if (category === "subscription") {
      return {
        consultations: [],
        subscriptions: filterBySearch(data.subscriptions),
        webinars: [],
        classes: [],
        trials: [],
      };
    }
    if (category === "purchased") {
      return {
        consultations: [],
        subscriptions: [],
        webinars: filterBySearch(purchasedWebinars),
        classes: filterBySearch(purchasedClasses),
        trials: [],
      };
    }
    return {
      consultations: filterBySearch(data.consultations),
      subscriptions: filterBySearch(data.subscriptions),
      webinars: filterBySearch(allWebinars),
      classes: filterBySearch(allClasses),
      trials: filterBySearch(data.trials ?? []),
    };
  }, [data, category, searchQuery]);

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

  const purchasedItems = (data?.purchased ?? []).filter((item) =>
    matchesSearch(item, searchQuery),
  );
  const totalScopedCount =
    (scopedData?.consultations.length ?? 0) +
    (scopedData?.subscriptions.length ?? 0) +
    (scopedData?.webinars.length ?? 0) +
    (scopedData?.classes.length ?? 0) +
    (scopedData?.trials?.length ?? 0);
  const hasSearchOrCategoryFilter =
    searchQuery.trim().length > 0 || category !== "all";

  return (
    <DashboardErrorBoundary>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
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
                {tab.value === "purchased" && (data?.purchased?.length ?? 0) > 0
                  ? ` (${data?.purchased?.length ?? 0})`
                  : ""}
              </Button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search recordings…"
              aria-label="Search consultee recordings"
              className="pl-8"
            />
          </div>
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
        ) : hasSearchOrCategoryFilter && totalScopedCount === 0 ? (
          <div className="rounded-lg border bg-card p-8 text-center">
            <p className="text-sm font-medium text-foreground">
              No recordings match your current filter
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Try clearing your search query or switching back to All
              recordings.
            </p>
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
