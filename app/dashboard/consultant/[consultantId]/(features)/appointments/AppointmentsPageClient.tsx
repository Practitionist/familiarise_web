"use client";

import { useMemo, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Button } from "@/components/ui/button";
import { AppointmentsShell } from "@/components/appointments/AppointmentsShell";
import type { ViewerZone } from "@/lib/time/viewer-zone";
import { AppointmentsPageSkeleton } from "@/components/appointments/skeletons";
import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import {
  CONSULTANT_APPOINTMENTS_RECENT_CAP,
  CONSULTANT_APPOINTMENTS_RECENT_PAST,
} from "@/lib/appointments/window";
import { useConsultantAppointmentsAdapter } from "./ConsultantAppointmentsAdapter";
import { useSession } from "@/lib/auth-client";

/** The trials side list shows the newest page; older trials live in history. */
const TRIALS_PAGE = 100;

/** Old HomeTab deep-links carry groupRecurringAppointments keys — map the
 *  non-recurring "single-<appointmentId>" form onto the VM row id. */
function normalizeHighlight(param: string | null): string | null {
  if (!param) return null;
  if (param.startsWith("single-")) {
    return `appointment-${param.slice("single-".length)}`;
  }
  return param;
}

function SideQueryNotice({
  label,
  onRetry,
}: {
  label: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">{label} couldn&apos;t be loaded.</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}

export default function AppointmentsPageClient({
  consultantId,
  viewerZone,
}: Readonly<{ consultantId: string; viewerZone: ViewerZone }>) {
  const searchParams = useSearchParams();
  const highlightedId = normalizeHighlight(
    searchParams?.get("highlight") ?? null,
  );

  // keepPreviousData: refetches show the previous list while the new one
  // loads instead of a skeleton flash (#346).
  const consultantQueries = createConsultantQueries(consultantId);
  const {
    data: recentAppointments,
    isLoading,
    error,
    refetch: refetchAppointments,
  } = useQuery({
    ...consultantQueries.appointments,
    placeholderData: keepPreviousData,
  });

  // The default read stops 12 months back; "Load older" appends one keyset
  // page of earlier history per click.
  const [showOlder, setShowOlder] = useState(false);
  const older = useInfiniteQuery({
    ...consultantQueries.appointmentsOlder,
    enabled: showOlder,
  });
  const olderLoading = older.isFetching;
  const olderError = older.isError;
  // A second click after a failed read must start a new request; flipping
  // an already-true flag starts nothing.
  const olderButtonLabel = (loading: boolean, failed: boolean): string => {
    if (loading) return "Loading…";
    if (failed) return "Retry";
    return "Load older";
  };
  const loadOlder = () => {
    if (!showOlder) setShowOlder(true);
    else if (older.isError) void older.refetch();
    else void older.fetchNextPage();
  };
  const olderRows = useMemo(
    () => older.data?.pages.flatMap((page) => page.rows) ?? [],
    [older.data],
  );
  // A row that ended between two reads can arrive twice; the list keys by id.
  const appointments = useMemo(
    () =>
      recentAppointments
        ? [
            ...new Map(
              [...recentAppointments, ...olderRows].map((row) => [row.id, row]),
            ).values(),
          ]
        : undefined,
    [recentAppointments, olderRows],
  );
  // The recent read caps live rows; say so rather than drop them silently.
  const liveCapped =
    (recentAppointments ?? []).filter((row) => {
      const live = (row.occurrences ?? []).filter((o) => !o.deletedAt);
      return (
        live.length === 0 ||
        live.some((o) => new Date(o.endsAt).getTime() >= Date.now())
      );
    }).length >= CONSULTANT_APPOINTMENTS_RECENT_CAP;
  const historyComplete = showOlder && older.isSuccess && !older.hasNextPage;

  // Side queries keep their own state so a slow/failed trials or
  // classes/webinars read degrades to a notice instead of blanking the list.
  const {
    data: trialsData,
    isError: trialsError,
    refetch: refetchTrials,
  } = useQuery({
    placeholderData: keepPreviousData,
    // Side lists change slowly; a short stale window dedupes remount refetches.
    staleTime: 2 * 60_000,
    queryKey: ["trials", consultantId, "ALL"] as const,
    queryFn: async (): Promise<
      NonNullable<
        Parameters<typeof mapConsultantAppointments>[0]["scheduledTrials"]
      >
    > => {
      const res = await fetch(
        `/api/trials?consultantProfileId=${consultantId}&limit=${TRIALS_PAGE}&page=1`,
      );
      if (!res.ok) throw new Error("Failed to fetch trials");
      const json = await res.json();
      return Array.isArray(json.data) ? json.data : [];
    },
  });

  const {
    data: classEventsData,
    isError: classesError,
    refetch: refetchClasses,
  } = useQuery({
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    queryKey: ["consultant-classes", consultantId] as const,
    queryFn: async () => {
      const res = await fetch(
        `/api/bookings/classes?consultantProfileId=${consultantId}&unscheduled=1`,
      );
      if (!res.ok) throw new Error("Failed to fetch classes");
      const { data } = await res.json();
      return data ?? [];
    },
  });

  const {
    data: webinarEventsData,
    isError: webinarsError,
    refetch: refetchWebinars,
  } = useQuery({
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    queryKey: ["consultant-webinars-unscheduled", consultantId] as const,
    queryFn: async () => {
      const res = await fetch(
        `/api/bookings/webinars?consultantProfileId=${consultantId}&unscheduled=1`,
      );
      if (!res.ok) throw new Error("Failed to fetch webinars");
      const { data } = await res.json();
      return data ?? [];
    },
  });

  const adapter = useConsultantAppointmentsAdapter(consultantId);

  const viewerUserId = useSession().data?.user?.id ?? null;
  const vms = useMemo(
    () =>
      mapConsultantAppointments({
        appointments: appointments ?? [],
        scheduledTrials: trialsData ?? [],
        unscheduledClasses: classEventsData ?? [],
        unscheduledWebinars: webinarEventsData ?? [],
        consultantId,
        viewerUserId,
      }),
    [
      appointments,
      trialsData,
      classEventsData,
      webinarEventsData,
      consultantId,
      viewerUserId,
    ],
  );

  const notices =
    trialsError || classesError || webinarsError ? (
      <div className="space-y-2">
        {trialsError && (
          <SideQueryNotice
            label="Trials"
            onRetry={() => void refetchTrials()}
          />
        )}
        {classesError && (
          <SideQueryNotice
            label="Unscheduled classes"
            onRetry={() => void refetchClasses()}
          />
        )}
        {webinarsError && (
          <SideQueryNotice
            label="Unscheduled webinars"
            onRetry={() => void refetchWebinars()}
          />
        )}
      </div>
    ) : null;

  return (
    <DashboardErrorBoundary>
      <DashboardHeader
        title="Appointments"
        subtitle="Your consultations, subscriptions, webinars, and classes"
      />
      <div className="pt-6">
        {isLoading && !appointments ? (
          <AppointmentsPageSkeleton />
        ) : error && !appointments ? (
          <ErrorState
            title="Couldn't load appointments"
            description="Check your connection and try again."
            error={error}
            onRetry={() => void refetchAppointments()}
          />
        ) : (
          <AppointmentsShell
            vms={vms}
            adapter={adapter}
            viewerZone={viewerZone}
            highlightedId={highlightedId}
            notices={notices}
            footer={
              <div className="flex flex-wrap items-center justify-center gap-3 py-4 text-xs text-muted-foreground">
                {liveCapped && (
                  <span>
                    Showing your {CONSULTANT_APPOINTMENTS_RECENT_CAP} most
                    recent upcoming appointments.
                  </span>
                )}
                {historyComplete ? (
                  <span>Showing your full history.</span>
                ) : (
                  <>
                    <span>
                      {showOlder
                        ? "Showing everything upcoming and earlier history."
                        : `Showing everything upcoming and your latest ${CONSULTANT_APPOINTMENTS_RECENT_PAST} past appointments.`}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={olderLoading}
                      onClick={loadOlder}
                    >
                      {olderButtonLabel(olderLoading, olderError)}
                    </Button>
                    {olderError && (
                      <span className="text-destructive">
                        Couldn&apos;t load older appointments.
                      </span>
                    )}
                  </>
                )}
              </div>
            }
            requestsHref={`/dashboard/consultant/${consultantId}/requests`}
          />
        )}
      </div>
    </DashboardErrorBoundary>
  );
}
