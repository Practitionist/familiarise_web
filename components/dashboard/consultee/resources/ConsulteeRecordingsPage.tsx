"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { ErrorState } from "@/components/dashboard/ErrorState";

import { ResourcesTab } from "./ResourcesTab";
import type { EventResource } from "./EventResourceCard";

interface BookingResources {
  consultations: EventResource[];
  subscriptions: EventResource[];
  webinars: EventResource[];
  classes: EventResource[];
  trials?: EventResource[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The consultee Recordings page. The resources read enforces the #1819
 * late-join rule server-side, so one read covers 1:1, group and free events.
 */
export function ConsulteeRecordingsPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = use(params);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["consultee-recordings", consulteeId],
    queryFn: async () => {
      const { data } = await getJson<{ data: BookingResources }>(
        `/api/dashboard/consultee/${consulteeId}/resources`,
      );
      return { ...data, trials: data.trials ?? [] };
    },
    staleTime: 5 * 60 * 1000,
  });

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

  return (
    <DashboardErrorBoundary>
      <ResourcesTab
        data={data}
        artifact="recordings"
        title="Recordings"
        subtitle="Session recordings from the events you've attended"
      />
    </DashboardErrorBoundary>
  );
}
