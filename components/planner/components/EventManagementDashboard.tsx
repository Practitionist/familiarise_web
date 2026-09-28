"use client";

import { useMemo, useState, useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, SearchX } from "lucide-react";
// #248 bundle discipline: never statically import the Stream SDK or
// @/lib/meeting (which imports it) — the client singleton is read at
// click time and the meeting helper is lazy-imported on demand.
import {
  describeVideoClientWait,
  waitForGlobalVideoClient,
} from "@/lib/stream/disconnect";
import { reportSentryMessage } from "@/lib/observability/report";
import { reportClientFailure } from "@/lib/errors/classification/client-failure";
import { failureToast } from "@/components/ui/failure-toast";
import { useInFlightGuard } from "@/hooks/scheduling/useInFlightGuard";
import type { MeetingSlot } from "@/lib/meeting";
import {
  CONSULTANT_JOIN_WINDOW_MS,
  getCurrentOrNextOccurrence,
  getJoinableOccurrence,
  getOccurrenceJoinState,
} from "@/lib/appointments/occurrences";
import type {
  ConsultationPlanEvent,
  PlannerClassEvent,
  PlannerWebinarEvent,
  SubscriptionPlanEvent,
} from "@/types/planner-events";
import type { ConsultationPlan, SubscriptionPlan } from "@/schemas/plans";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";
import { useListParams } from "@/hooks/useListParams";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  fetchOfferingStats,
  offeringStatsQueryKey,
  type OfferingPlanType,
} from "@/lib/offerings/stats";
import { OfferingCard } from "@/components/offerings/list/OfferingCard";
import { NewOfferingMenu } from "@/components/offerings/list/NewOfferingMenu";
import {
  OFFERING_TYPE_FILTERS,
  buildOfferingRows,
  filterOfferingRows,
  type OfferingRow,
} from "@/components/offerings/list/offering-rows";
import {
  useArchiveOffering,
  useConsultationPlans,
  useDeleteOffering,
  useSubscriptionPlans,
} from "../hooks/usePlanner";

interface PlannerData {
  webinars: PlannerWebinarEvent[];
  classes: PlannerClassEvent[];
  participantCounts: Record<string, number>;
}

interface Props {
  consultantId: string;
  /**
   * Planner payload from the page's ["consultant-planner", …] query — the
   * SINGLE source of truth for webinar/class instances. Mutations invalidate
   * that key (usePlanner.ts) and fresh data flows back down.
   */
  data: PlannerData;
}

async function fetchPendingTrialCounts(
  consultantId: string,
): Promise<Record<string, number>> {
  const response = await fetch(
    `/api/trials?consultantProfileId=${encodeURIComponent(consultantId)}&status=PENDING`,
  );
  if (!response.ok) return {};
  const { data } = (await response.json()) as {
    data: { subscriptionPlanId: string }[];
  };
  const counts: Record<string, number> = {};
  for (const trial of data) {
    counts[trial.subscriptionPlanId] =
      (counts[trial.subscriptionPlanId] ?? 0) + 1;
  }
  return counts;
}

/**
 * The Offerings list (#1527 §7.2, the Event Planner renamed): type pills and a
 * search held in the URL, one card per offering with its status, stats and
 * actions. Webinar and class cards keep the host's Join.
 */
export function EventManagementDashboard({
  consultantId,
  data,
}: Readonly<Props>) {
  const webinars = data.webinars;
  const classes = data.classes;
  const { toast } = useToast();
  const router = useRouter();
  const basePath = `/dashboard/consultant/${consultantId}`;

  const [joiningEventId, setJoiningEventId] = useState<string | null>(null);
  // #1280 2.7 — `joiningEventId` is state, and it is set AFTER the first await
  // (`waitForGlobalVideoClient`, which can take a second on a cold provider),
  // so a second click reads a stale `null` and runs the whole chain again.
  // A ref is written synchronously and is what actually closes the window;
  // the state stays because it is what renders the spinner.
  const guardJoin = useInFlightGuard();

  // The join window closes with the clock, not with a re-render. Without a
  // tick the memo below keeps whatever answer it computed when the planner
  // mounted, so Join stays lit after a session ends (#1061). Thirty seconds is
  // fine for a window measured in minutes.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Compute which webinar/class events are currently joinable (inside the
  // shared host window before start, through to end). #1270 — the planner
  // used to declare its own 10-minute constant, so the SAME host got in five
  // minutes later here than from the appointments list. #1554 — measured over
  // the occurrence's own bounds.
  const joinableEventIds = useMemo(() => {
    const ids = new Set<string>();

    for (const webinar of webinars) {
      const run = getJoinableOccurrence(
        webinar.appointment?.occurrences ?? [],
        {
          joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
          now,
        },
      );
      if (run && webinar.id) ids.add(webinar.id);
    }

    for (const cls of classes) {
      const run = getJoinableOccurrence(cls.appointment?.occurrences ?? [], {
        joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
        now,
      });
      if (run && cls.id) ids.add(cls.id);
    }

    return ids;
  }, [webinars, classes, now]);

  // Handle joining a meeting from the planner. Reads the connected video
  // client singleton at click time (HomeTab idiom, #248) so the Stream SDK
  // stays off the planner bundle.
  const handleJoinWebinarMeeting = (webinar: PlannerWebinarEvent) =>
    guardJoin(`webinar:${webinar.id}`, () => joinWebinarMeeting(webinar));

  const joinWebinarMeeting = async (webinar: PlannerWebinarEvent) => {
    const waitStartedAt = Date.now();
    const streamClient = await waitForGlobalVideoClient();
    if (!streamClient) {
      // Kept distinct from a chunk failure in Sentry as well as in the toast;
      // the extras are what tell a cold start from a provider that never
      // connected at all.
      reportSentryMessage("Video client not ready at Join", {
        subsystem: "client",
        op: "join-webinar",
        expected: true,
        extra: describeVideoClientWait(Date.now() - waitStartedAt),
      });
      toast({
        title: "Connecting…",
        description: "Setting up your meeting client. Please try Join again.",
        variant: "warning",
      });
      return;
    }

    // The live occurrence, not whichever row happens to be first in the
    // payload: `occurrences` arrives unsorted, so `[0]` could hand an
    // arbitrary row's startsAt to the Stream call.
    const slots = webinar.appointment?.occurrences ?? [];
    const slot =
      getJoinableOccurrence(slots, {
        joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
      }) ?? getCurrentOrNextOccurrence(slots);
    if (!slot || !webinar.appointment) {
      toast({
        title: "Error",
        description: "Meeting slot information is not available.",
        variant: "destructive",
      });
      return;
    }

    // `getJoinableOccurrence` returns null for three different reasons —
    // countdown, disabled and ended — and the fallback fires for all of them.
    // Only `ended` must actually refuse: opening a room for a session the host
    // has already closed, or whose time has passed, walks straight through the
    // guard this change exists to build. Countdown still gets in, because
    // hosts have always been able to open the room a little early.
    if (
      getOccurrenceJoinState(slot, {
        joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
      }) === "ended"
    ) {
      toast({
        title: "Session has ended",
        description: "This session is over, so its meeting room is closed.",
        variant: "destructive",
      });
      return;
    }

    setJoiningEventId(webinar.id ?? null);
    try {
      const meetingSlot: MeetingSlot = {
        id: slot.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        appointmentId: webinar.appointment.id,
      };
      const { getOrCreateAppointmentMeeting } = await import("@/lib/meeting");
      const meetingId = await getOrCreateAppointmentMeeting(meetingSlot);
      toast({
        title: "Joining meeting",
        description: "Redirecting to the meeting room.",
      });
      router.push(`/meetings/${meetingId}`);
    } catch (error) {
      console.error("Error joining webinar meeting:", error);
      toast(
        failureToast(
          reportClientFailure(error, {
            subsystem: "client",
            op: "join-webinar",
            title: "Error joining meeting",
            extra: { appointmentId: webinar.appointment.id, slotId: slot.id },
          }),
        ),
      );
      setJoiningEventId(null);
    }
  };

  const handleJoinClassMeeting = (classEvent: PlannerClassEvent) =>
    guardJoin(`class:${classEvent.id}`, () => joinClassMeeting(classEvent));

  const joinClassMeeting = async (classEvent: PlannerClassEvent) => {
    const waitStartedAt = Date.now();
    const streamClient = await waitForGlobalVideoClient();
    if (!streamClient) {
      // Kept distinct from a chunk failure in Sentry as well as in the toast;
      // the extras are what tell a cold start from a provider that never
      // connected at all.
      reportSentryMessage("Video client not ready at Join", {
        subsystem: "client",
        op: "join-class",
        expected: true,
        extra: describeVideoClientWait(Date.now() - waitStartedAt),
      });
      toast({
        title: "Connecting…",
        description: "Setting up your meeting client. Please try Join again.",
        variant: "warning",
      });
      return;
    }

    // Find the nearest joinable session for this class. #1061 — evaluated over
    // the whole run of slot rows, so a two-hour class stays joinable (and in
    // the same room) past its first half hour instead of reporting "No
    // joinable session found".
    const now = new Date();
    const targetAppt = classEvent.appointment;
    const targetSlot = getJoinableOccurrence(targetAppt?.occurrences ?? [], {
      joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
      now,
    });

    if (!targetAppt || !targetSlot) {
      toast({
        title: "Error",
        description: "No joinable session found for this class.",
        variant: "destructive",
      });
      return;
    }

    setJoiningEventId(classEvent.id ?? null);
    try {
      const meetingSlot: MeetingSlot = {
        id: targetSlot.id,
        startsAt: targetSlot.startsAt,
        endsAt: targetSlot.endsAt,
        appointmentId: targetAppt.id,
      };
      const { getOrCreateAppointmentMeeting } = await import("@/lib/meeting");
      const meetingId = await getOrCreateAppointmentMeeting(meetingSlot);
      toast({
        title: "Joining meeting",
        description: "Redirecting to the meeting room.",
      });
      router.push(`/meetings/${meetingId}`);
    } catch (error) {
      console.error("Error joining class meeting:", error);
      toast(
        failureToast(
          reportClientFailure(error, {
            subsystem: "client",
            op: "join-class",
            title: "Error joining meeting",
            extra: { appointmentId: targetAppt.id, slotId: targetSlot.id },
          }),
        ),
      );
      setJoiningEventId(null);
    }
  };

  // The stats route is session-derived: only the owner's own stats are theirs.
  const { data: session } = useSession();
  const isOwner =
    (session?.user as { consultantProfileId?: string } | undefined)
      ?.consultantProfileId === consultantId;
  const stats = useQuery({
    queryKey: offeringStatsQueryKey(consultantId),
    queryFn: fetchOfferingStats,
    enabled: isOwner,
    staleTime: 60_000,
  });
  const statByKey = useMemo(
    () =>
      new Map(
        (stats.data?.rows ?? []).map((r) => [`${r.planType}:${r.planId}`, r]),
      ),
    [stats.data],
  );

  const pendingTrials = useQuery({
    queryKey: ["trials", consultantId, "PENDING", "counts"],
    queryFn: () => fetchPendingTrialCounts(consultantId),
    staleTime: 60_000,
  });

  const consultationPlans = useConsultationPlans(consultantId);
  const subscriptionPlans = useSubscriptionPlans(consultantId);

  const archive: Record<
    OfferingPlanType,
    ReturnType<typeof useArchiveOffering>
  > = {
    consultation: useArchiveOffering(consultantId, "consultation"),
    subscription: useArchiveOffering(consultantId, "subscription"),
    webinar: useArchiveOffering(consultantId, "webinar"),
    class: useArchiveOffering(consultantId, "class"),
  };
  const remove: Record<
    OfferingPlanType,
    ReturnType<typeof useDeleteOffering>
  > = {
    consultation: useDeleteOffering(consultantId, "consultation"),
    subscription: useDeleteOffering(consultantId, "subscription"),
    webinar: useDeleteOffering(consultantId, "webinar"),
    class: useDeleteOffering(consultantId, "class"),
  };

  const list = useListParams({ filterKeys: ["type"] as const });
  const rows = useMemo(
    () =>
      buildOfferingRows({
        consultationPlans: (consultationPlans.data ?? []).map(
          (plan: ConsultationPlan & { id: string }): ConsultationPlanEvent => ({
            type: "consultation",
            id: plan.id,
            consultationPlan: plan as ConsultationPlanEvent["consultationPlan"],
          }),
        ),
        subscriptionPlans: (subscriptionPlans.data ?? []).map(
          (plan: SubscriptionPlan & { id: string }): SubscriptionPlanEvent => ({
            type: "subscription",
            id: plan.id,
            subscriptionPlan: plan as SubscriptionPlanEvent["subscriptionPlan"],
          }),
        ),
        webinars,
        classes,
        participantCounts: data.participantCounts ?? {},
      }),
    [
      consultationPlans.data,
      subscriptionPlans.data,
      webinars,
      classes,
      data.participantCounts,
    ],
  );
  const visible = filterOfferingRows(rows, list.filters.type, list.q);

  const cardProps = (row: OfferingRow) => {
    const planId = row.planId;
    // The editor loads plans by id; a group card also names its instance so
    // the save lands on this batch, not the plan's first one.
    const instanceQuery = row.instanceId ? `?instance=${row.instanceId}` : "";
    const joinable =
      row.type === "webinar" || row.type === "class"
        ? {
            canJoin: joinableEventIds.has(row.instanceId ?? ""),
            isJoining: joiningEventId === row.instanceId,
            onJoin: () =>
              row.type === "webinar"
                ? handleJoinWebinarMeeting(row.event as PlannerWebinarEvent)
                : handleJoinClassMeeting(row.event as PlannerClassEvent),
          }
        : undefined;
    const deleteId = row.instanceId ?? planId;
    return {
      stat: row.statKey ? statByKey.get(row.statKey) : undefined,
      editHref: planId
        ? `${basePath}/offerings/${row.type}/${planId}/edit${instanceQuery}`
        : null,
      duplicateHref: planId
        ? `${basePath}/offerings/${row.type}/new?from=${planId}`
        : null,
      trials:
        row.type === "subscription" && planId
          ? {
              // Trial requests are a type tab of the Requests inbox (#1775).
              href: `${basePath}/requests?type=trial`,
              pending: pendingTrials.data?.[planId] ?? 0,
            }
          : undefined,
      join: joinable,
      onArchiveToggle: planId
        ? () =>
            archive[row.type].mutateAsync({
              id: planId,
              archived: !row.isArchived,
            })
        : undefined,
      onDelete: deleteId
        ? () => remove[row.type].mutateAsync(deleteId)
        : undefined,
    };
  };

  const plansLoading =
    (consultationPlans.isLoading && !consultationPlans.data) ||
    (subscriptionPlans.isLoading && !subscriptionPlans.data);
  const plansError = consultationPlans.error ?? subscriptionPlans.error;

  let body: ReactNode;
  if (plansLoading) {
    body = (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-52 rounded-xl" />
        ))}
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        icon={LayoutGrid}
        title="No offerings yet"
        description="Create a 1:1 session, a subscription, a webinar or a class to start taking bookings."
        action={<NewOfferingMenu consultantId={consultantId} />}
      />
    );
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        icon={SearchX}
        title="Nothing matches"
        description="Try another type or search."
        action={
          <Button variant="outline" size="sm" onClick={list.clear}>
            Clear filters
          </Button>
        }
      />
    );
  } else {
    body = (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map((row) => (
          <OfferingCard key={row.key} row={row} {...cardProps(row)} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {plansError && (
        <ErrorState
          variant="inline"
          title="Some of your plans didn't load"
          description="Your 1:1 and subscription plans may be missing below."
          onRetry={() => {
            void consultationPlans.refetch();
            void subscriptionPlans.refetch();
          }}
        />
      )}
      <FilterBar
        search={{
          label: "Search offerings",
          placeholder: "Search by title",
          value: list.q,
          onChange: list.setQ,
        }}
        chips={{
          label: "Type",
          options: [
            { value: "all", label: "All" },
            ...OFFERING_TYPE_FILTERS.map((f) => ({
              ...f,
              count: rows.filter((r) => r.type === f.value).length,
            })),
          ],
          value: list.filters.type ?? "all",
          onChange: (value) =>
            list.setFilter("type", value === "all" ? null : value),
        }}
        onClear={list.clear}
      />
      {body}
    </div>
  );
}
