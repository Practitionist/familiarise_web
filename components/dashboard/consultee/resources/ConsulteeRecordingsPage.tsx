"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { ErrorState } from "@/components/dashboard/ErrorState";

import { ResourcesTab } from "./ResourcesTab";
import type { EventResource } from "./EventResourceCard";

/** One row of `/api/consultees/[id]/recordings` (the #1819 late-join-safe read). */
interface GroupRecording {
  id: string;
  title: string;
  durationInMinutes: number;
  recordedAt: string;
  status: string;
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  planType: "webinar" | "class" | null;
  planTitle: string | null;
  eventId: string | null;
  eventStatus: string | null;
  consultantName: string | null;
  consultantImage: string | null;
}

interface OwnBookingResources {
  consultations: EventResource[];
  subscriptions: EventResource[];
  trials?: EventResource[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}

/** Group-event recordings, one card per webinar/class run, newest first. */
function groupByEvent(
  rows: GroupRecording[],
  type: "webinar" | "class",
): EventResource[] {
  const byEvent = new Map<string, EventResource>();
  for (const rec of rows) {
    if (rec.planType !== type || !rec.eventId) continue;
    const card = byEvent.get(rec.eventId) ?? {
      id: rec.eventId,
      planTitle: rec.planTitle ?? "Session",
      consultantName: rec.consultantName ?? "",
      consultantImage: rec.consultantImage,
      status: rec.eventStatus ?? "COMPLETED",
      date: rec.recordedAt,
      materials: [],
      recordings: [],
    };
    card.recordings.push({
      id: rec.id,
      title: rec.title,
      durationInMinutes: rec.durationInMinutes,
      recordedAt: rec.recordedAt,
      playbackUrl: rec.playbackUrl,
      thumbnailUrl: rec.thumbnailUrl,
      status: rec.status,
    });
    byEvent.set(rec.eventId, card);
  }
  return [...byEvent.values()];
}

/**
 * The consultee Recordings page. #1527 P0 — webinar and class recordings come
 * from the late-join-safe read (#1819: a late joiner only sees sessions from
 * their seat on), not from the resources read whose paid-plan arms ignored
 * that rule. A 1:1 booking has no late joiner, so its recordings still come
 * from the learner's own bookings in the resources read.
 */
export function ConsulteeRecordingsPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = use(params);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["consultee-recordings", consulteeId],
    queryFn: async () => {
      const [group, own] = await Promise.all([
        getJson<{ recordings: GroupRecording[] }>(
          `/api/consultees/${consulteeId}/recordings`,
        ),
        getJson<{ data: OwnBookingResources }>(
          `/api/dashboard/consultee/${consulteeId}/resources`,
        ),
      ]);
      return {
        consultations: own.data.consultations,
        subscriptions: own.data.subscriptions,
        trials: own.data.trials ?? [],
        webinars: groupByEvent(group.recordings, "webinar"),
        classes: groupByEvent(group.recordings, "class"),
      };
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
