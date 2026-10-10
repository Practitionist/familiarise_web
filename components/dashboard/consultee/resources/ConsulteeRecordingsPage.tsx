"use client";

import { use, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, Search } from "lucide-react";

import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { PageHeader } from "@/components/dashboard/PageScaffold";
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
  if (item.classId || item.classPlan) return true;
  if (item.webinarId || item.webinarPlan) return false;
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
  if ((event.contextTitle ?? "").toLowerCase().includes(q)) return true;
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
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

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

  const recordingsData = useMemo(() => {
    if (!data) return undefined;
    const hasRecording = (item: EventResource) => item.recordings.length > 0;
    return {
      consultations: data.consultations.filter(hasRecording),
      subscriptions: data.subscriptions.filter(hasRecording),
      webinars: data.webinars.filter(hasRecording),
      classes: data.classes.filter(hasRecording),
      trials: (data.trials ?? []).filter(hasRecording),
      purchased: (data.purchased ?? []).filter(hasRecording),
    };
  }, [data]);

  const totalAnyRecordings = useMemo(() => {
    if (!recordingsData) return 0;
    return (
      recordingsData.consultations.length +
      recordingsData.subscriptions.length +
      recordingsData.webinars.length +
      recordingsData.classes.length +
      recordingsData.trials.length +
      recordingsData.purchased.length
    );
  }, [recordingsData]);

  const scopedData = useMemo(() => {
    if (!recordingsData) return undefined;
    const purchasedItems = recordingsData.purchased;
    const purchasedClasses = purchasedItems.filter(isPurchasedClassRecording);
    const purchasedWebinars = purchasedItems.filter(
      (item) => !isPurchasedClassRecording(item),
    );
    const filterBySearch = (items: EventResource[]) =>
      items.filter((item) => matchesSearch(item, searchQuery));

    const allWebinars = mergeUniqueEvents(
      recordingsData.webinars,
      purchasedWebinars,
    );
    const allClasses = mergeUniqueEvents(
      recordingsData.classes,
      purchasedClasses,
    );

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
        consultations: filterBySearch(recordingsData.consultations),
        subscriptions: [],
        webinars: [],
        classes: [],
        trials: [],
      };
    }
    if (category === "subscription") {
      return {
        consultations: [],
        subscriptions: filterBySearch(recordingsData.subscriptions),
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
      consultations: filterBySearch(recordingsData.consultations),
      subscriptions: filterBySearch(recordingsData.subscriptions),
      webinars: filterBySearch(allWebinars),
      classes: filterBySearch(allClasses),
      trials: filterBySearch(recordingsData.trials),
    };
  }, [recordingsData, category, searchQuery]);

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

  if (totalAnyRecordings === 0) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Recordings"
          description="Recordings of the sessions you've attended and purchased replays"
        />
        <ResourcesTab
          data={recordingsData}
          artifact="recordings"
          sortDir={sortDir}
        />
      </div>
    );
  }

  const purchasedItems = [...(recordingsData?.purchased ?? [])]
    .filter((item) => matchesSearch(item, searchQuery))
    .sort((a, b) => {
      const diff = new Date(a.date).getTime() - new Date(b.date).getTime();
      return sortDir === "desc" ? -diff : diff;
    });
  const totalScopedCount =
    (scopedData?.consultations.length ?? 0) +
    (scopedData?.subscriptions.length ?? 0) +
    (scopedData?.webinars.length ?? 0) +
    (scopedData?.classes.length ?? 0) +
    (scopedData?.trials?.length ?? 0);
  const hasSearchOrCategoryFilter =
    searchQuery.trim().length > 0 || category !== "all";
  const purchasedCount = recordingsData?.purchased.length ?? 0;

  let recordingsContent: React.ReactNode;
  if (category === "purchased" && purchasedItems.length > 0) {
    recordingsContent = (
      <div className="space-y-4">
        {purchasedItems.map((event) => (
          <EventResourceCard
            key={event.id}
            event={event}
            artifact="recordings"
          />
        ))}
      </div>
    );
  } else if (hasSearchOrCategoryFilter && totalScopedCount === 0) {
    recordingsContent = (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="text-sm font-medium text-foreground">
          No recordings match your current filter
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Try clearing your search query or switching back to All recordings.
        </p>
      </div>
    );
  } else {
    recordingsContent = (
      <ResourcesTab data={scopedData} artifact="recordings" sortDir={sortDir} />
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Recordings"
        description="Recordings of the sessions you've attended and purchased replays"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Filter by offering type"
          className="flex flex-wrap items-center gap-1.5"
        >
          {RECORDING_CATEGORIES.map((tab) => {
            const badgeSuffix =
              tab.value === "purchased" && purchasedCount > 0
                ? ` (${purchasedCount})`
                : "";
            return (
              <Button
                key={tab.value}
                type="button"
                aria-pressed={category === tab.value}
                variant={category === tab.value ? "default" : "outline"}
                size="sm"
                onClick={() => setCategory(tab.value)}
              >
                {tab.label}
                {badgeSuffix}
              </Button>
            );
          })}
        </div>

        <div
          role="search"
          aria-label="Search and sort recordings"
          className="flex w-full items-center gap-2 sm:w-auto"
        >
          <div className="relative flex-1 sm:w-64">
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

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
          >
            <ArrowUpDown className="mr-2 h-4 w-4" />
            {sortDir === "desc" ? "Newest first" : "Oldest first"}
          </Button>
        </div>
      </div>

      <div aria-live="polite">
        <h2 className="sr-only">Session recordings</h2>
        {recordingsContent}
      </div>
    </div>
  );
}
