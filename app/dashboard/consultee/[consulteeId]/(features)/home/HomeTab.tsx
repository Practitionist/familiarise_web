"use client";

import { CONDUCT_REMOVAL_CATEGORY } from "@/lib/support/case-topic";
import Link from "next/link";
import { schedulableSessionsOf } from "@/lib/booking/entitlement";
import { useRouter } from "next/navigation";
import {
  Calendar,
  CheckCircle2,
  Loader2,
  LifeBuoy,
  MessageSquareText,
  Users,
  Video,
} from "lucide-react";
import { differenceInHours, differenceInDays } from "date-fns";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
// #248: do NOT statically import the Stream SDK (useStreamVideoClient) or
// lib/meeting (which imports the SDK) here — that would pull the heavy SDK into
// the dashboard-HOME bundle / critical path. The video client + meeting helper
// are acquired lazily inside the Join handler (only when a user clicks Join).
import {
  describeVideoClientWait,
  waitForGlobalVideoClient,
} from "@/lib/stream/disconnect";
import { useSession } from "@/lib/auth-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";
import { formatCurrencyAmount } from "@/utils/formatting";
import { reportSentryMessage } from "@/lib/observability/report";
import { reportClientFailure } from "@/lib/errors/classification/client-failure";
import { failureToast } from "@/components/ui/failure-toast";
import { useInFlightGuard } from "@/hooks/scheduling/useInFlightGuard";
import { useToast } from "@/hooks/use-toast";
import { useCurrency } from "@/hooks/useCurrency";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";
import { isDeliberateEnd } from "@/lib/appointments/occurrences";
import { noSessionLabel } from "@/lib/appointments/bucket";
import {
  toOccurrenceVM,
  type AppointmentKind,
  type NeedsActionReason,
} from "@/lib/appointments/view-model";
import { formatForViewer, type ViewerZone } from "@/lib/time/viewer-zone";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { Section } from "@/components/dashboard/Section";
import { Stat, StatRow } from "@/components/dashboard/Stat";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ActionRequiredPanel } from "@/components/dashboard/ActionRequiredPanel";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { deriveConsulteeActionItems } from "@/lib/dashboard/action-items";
import {
  personalHomeTitle,
  type ViewedPerson,
} from "@/lib/dashboard/operator-view";
import { isExternalPayHref } from "@/lib/payments/pay-link-href";
import { WaitingTimesStrip } from "@/components/booking/WaitingTimesStrip";
import { isInactiveStatus, isConfirmedStatus } from "@/lib/appointments/status";
import { bookingStatus } from "@/lib/appointments/booking-status";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  REJOIN_GRACE_MS,
  appointmentStatusChip,
  getOccurrenceJoinState,
  isDeadOccurrence,
  isOccurrenceOver,
} from "@/lib/appointments/occurrences";
import { useNowTick } from "@/hooks/use-now-tick";
import { resolveDashboardFacets } from "@/lib/labels/personal-dashboard";
import {
  openProposalTarget,
  type OpenRescheduleProposal,
} from "@/lib/appointments/consultee-affordances";
import type { ConsulteeMoneySummary } from "@/lib/data/consultee-payments";
import type { LibraryDocument, LibraryPage } from "@/lib/library/library-query";
import { MyAlerts } from "@/components/appointments/consultee/MyAlerts";
import { fetchPendingPayments } from "./PendingPaymentsWidget";
import {
  type ProcessedEvent,
  processAllEvents,
  getUpcomingEvents,
  selectNextUp,
  sessionsThisMonth,
} from "./event-processor";

const KIND_OF: Record<ProcessedEvent["type"], AppointmentKind> = {
  consultation: "CONSULTATION",
  subscription: "SUBSCRIPTION",
  webinar: "WEBINAR",
  class: "CLASS",
  trial: "TRIAL",
};

/** The shared Appointments chip; Home lists only bookings that can still happen. */
function homeStatusChip(event: ProcessedEvent) {
  return appointmentStatusChip(
    {
      status: event.status.toUpperCase(),
      kind: KIND_OF[event.type],
      bookingSource: event.bookingSource,
      seatStatus: event.seatStatus,
      paid: event.paid,
      payDeadline: event.payDeadline,
      payLapsed: event.payLapsed,
      reschedule: event.reschedule,
    },
    "consultee",
  );
}

const NEXT_UP_LIMIT = 3;
const RATE_PROMPT_LIMIT = 2;

const TYPE_LABEL: Record<ProcessedEvent["type"], string> = {
  consultation: "Consultation",
  subscription: "Subscription",
  class: "Class",
  webinar: "Webinar",
  trial: "Trial",
};

interface HomeTabProps {
  /**
   * The route's learner, never the signed-in operator. Nullable: the profile
   * fetch may land after the events query; only the greeting waits.
   */
  learner: ViewedPerson | null;
  /** Session-keyed reads (alerts, reviews, own cases, org links) answer only for the owner. */
  viewerOwnsProfile: boolean;
  eventsData: TConsulteeEventsResponse;
  consulteeId: string;
  /** From the RSC page, so server and client format one wall clock. #1703 */
  viewerZone: ViewerZone;
}

/** The card's corner badge, in the booking words the Appointments list uses. */
function awaitingLabel(reason: NeedsActionReason | null): string {
  switch (reason) {
    case "PAY_NOW":
      return bookingStatus(
        { kind: "CONSULTATION", status: "APPROVED_PENDING_PAYMENT" },
        "CONSULTEE",
      ).label;
    case "PENDING_APPROVAL":
      return bookingStatus(
        { kind: "CONSULTATION", status: "PENDING" },
        "CONSULTEE",
      ).label;
    default:
      return noSessionLabel(reason);
  }
}

// Get time away text
function getTimeAway(
  date: Date | null,
  reason: NeedsActionReason | null,
  endsAt?: Date | null,
  now: Date = new Date(),
  meetingEnded = false,
): { text: string; urgent: boolean } {
  if (meetingEnded) return { text: "Completed", urgent: false };
  if (!date)
    return { text: awaitingLabel(reason), urgent: reason === "PAY_NOW" };
  const startMs = date.getTime();
  const endMs = (endsAt ?? date).getTime() + REJOIN_GRACE_MS;
  const nowMs = now.getTime();
  if (nowMs >= startMs && nowMs <= endMs) {
    return { text: "In progress", urgent: true };
  }
  if (nowMs > endMs) return { text: "Past", urgent: false };

  const hoursAway = differenceInHours(date, now);
  const daysAway = differenceInDays(date, now);

  if (hoursAway < 1) return { text: "Starting soon", urgent: true };
  if (hoursAway < 24) {
    const mins = Math.floor((hoursAway % 1) * 60);
    return {
      text: `${Math.floor(hoursAway)}h ${mins > 0 ? `${mins}m` : ""} away`,
      urgent: hoursAway < 2,
    };
  }
  if (daysAway === 1) return { text: "1 day away", urgent: false };
  return { text: `${daysAway} days away`, urgent: false };
}

function initialsOf(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2);
}

function withWhom(event: ProcessedEvent): string {
  const collaborators = event.collaborators ?? [];
  if (collaborators.length === 0) return event.consultantName;
  if (collaborators.length === 1)
    return `${event.consultantName} & ${collaborators[0].name}`;
  return `${event.consultantName} + ${collaborators.length} others`;
}

/**
 * One "Next up" card. #1527 — the whole card opens the appointment: the title
 * link stretches over the card, and Join / Pay sit above it so they stay
 * their own targets (no nested interactive elements).
 */
function NextUpCard({
  event,
  href,
  viewerZone,
  now,
  onJoin,
  isJoining,
}: Readonly<{
  event: ProcessedEvent;
  href: string | null;
  viewerZone: ViewerZone;
  now: Date;
  onJoin?: () => void;
  isJoining?: boolean;
}>) {
  const timeAway = getTimeAway(
    event.startsAt,
    event.needsActionReason,
    event.endsAt,
    now,
    isDeliberateEnd(event.joinableOccurrence?.meeting),
  );

  // Shared guards (lib/appointments/status-guards.ts) — same semantics as the
  // Appointments tab cards.
  const isInactive = isInactiveStatus(event.status);
  const isGroup = event.type === "webinar" || event.type === "class";
  const isApproved = isGroup
    ? event.bookingStatus === "CONFIRMED"
    : // #1270 — SCHEDULED is confirmed but not APPROVED; one gate everywhere.
      isConfirmedStatus(event.status);
  const isTentative = event.joinableSlot?.isTentative ?? true;
  const canShowJoin = !isTentative && isApproved && !isInactive;

  // #1061 — the same predicate the Appointments tabs use, over the
  // occurrence's own bounds, so an ended call stops offering Join.
  const isWithinJoinWindow =
    !!event.joinableOccurrence &&
    getOccurrenceJoinState(event.joinableOccurrence, {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now,
    }) === "joinable";

  return (
    <div className="relative flex flex-col rounded-xl border border-border bg-card p-4 shadow-elevation-1 transition-colors hover:border-foreground/20">
      <div className="flex items-center gap-3">
        <Avatar className="h-10 w-10 shrink-0">
          <AvatarImage
            src={event.consultantImage ?? undefined}
            alt={event.consultantName}
          />
          <AvatarFallback className="bg-muted text-xs font-semibold text-muted-foreground">
            {initialsOf(event.consultantName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">
            {href ? (
              <Link
                href={href}
                className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
              >
                {event.title}
              </Link>
            ) : (
              event.title
            )}
          </h3>
          <p className="truncate text-xs text-muted-foreground">
            {withWhom(event)}
          </p>
        </div>
        <Badge
          className={cn(
            "shrink-0 whitespace-nowrap border-0 px-2 py-0.5 text-[11px] font-medium",
            timeAway.urgent
              ? "bg-rose-50 text-rose-700"
              : "bg-muted text-muted-foreground",
          )}
        >
          {timeAway.text}
        </Badge>
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Calendar className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {event.startsAt ? (
          <span className="truncate">
            {formatForViewer(event.startsAt, viewerZone, "EEE, d MMM · h:mm a")}
          </span>
        ) : (
          // Same words as the Appointments row for a slot-less booking.
          <span className="truncate">Not scheduled</span>
        )}
      </p>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 overflow-hidden">
          <span className="text-[11px] font-medium text-muted-foreground">
            {TYPE_LABEL[event.type]}
          </span>
          <StatusBadge {...homeStatusChip(event)} withDot size="sm" />
        </div>
        {/* #1775 P-1 — the processor resolves the target: our pay page for a
            Razorpay order id (in-app), or a hosted https link (new tab). */}
        {event.needsActionReason === "PAY_NOW" && event.pendingPaymentUrl && (
          <Button
            asChild
            size="sm"
            className="relative z-10 h-7 shrink-0 px-3 text-xs"
          >
            {isExternalPayHref(event.pendingPaymentUrl) ? (
              <a
                href={event.pendingPaymentUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Pay now
              </a>
            ) : (
              <Link href={event.pendingPaymentUrl}>Pay now</Link>
            )}
          </Button>
        )}
        {canShowJoin && (
          <Button
            size="sm"
            className="relative z-10 h-7 shrink-0 px-3 text-xs"
            onClick={onJoin}
            disabled={
              isJoining || !isWithinJoinWindow || !event.joinableAppointment
            }
          >
            {isJoining ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Video className="mr-1 h-3 w-3" />
            )}
            {isJoining ? "Joining..." : "Join"}
          </Button>
        )}
      </div>
    </div>
  );
}

type WithProposals = {
  id: string;
  rescheduleRequests?: OpenRescheduleProposal[];
};

/** Proposals from the expert that wait on this learner's answer. */
function proposalsAwaiting(
  eventsData: TConsulteeEventsResponse,
  learnerUserId: string | undefined,
) {
  if (!learnerUserId) return [];
  const rows = [
    ...(eventsData.consultations ?? []).map((c) => ({
      appointment: c.appointment as WithProposals | null | undefined,
      title: c.consultationPlan?.title ?? "Consultation",
      counterpartName:
        c.consultationPlan?.consultantProfile?.user?.name ?? "Your expert",
    })),
    ...(eventsData.subscriptions ?? []).map((s) => ({
      appointment: s.appointment as WithProposals | null | undefined,
      title: s.subscriptionPlan?.title ?? "Subscription",
      counterpartName:
        s.subscriptionPlan?.consultantProfile?.user?.name ?? "Your expert",
    })),
  ];
  return rows.flatMap((row) => {
    const target = openProposalTarget([row.appointment]);
    // The initiator waits; the other side answers (RescheduleProposalCard).
    if (!target || target.proposal.initiatedById === learnerUserId) return [];
    return [
      {
        appointmentId: target.appointmentId,
        title: row.title,
        counterpartName: row.counterpartName,
      },
    ];
  });
}

function hasLiveRenewal(
  renewal:
    | {
        id?: string;
        status?: string;
        deletedAt?: Date | string | null;
      }
    | null
    | undefined,
): boolean {
  if (!renewal?.id || renewal.deletedAt) return false;
  const st = renewal.status?.toUpperCase();
  return st !== "CANCELLED" && st !== "REJECTED" && st !== "EXPIRED";
}

function readSubscriptionRenewal(sub: object): {
  id?: string;
  status?: string;
  deletedAt?: Date | string | null;
} | null {
  if (!("renewal" in sub) || !sub.renewal || typeof sub.renewal !== "object") {
    return null;
  }
  const r = sub.renewal;
  const id = "id" in r && typeof r.id === "string" ? r.id : undefined;
  const status =
    "status" in r && typeof r.status === "string" ? r.status : undefined;
  const deletedAt =
    "deletedAt" in r &&
    (typeof r.deletedAt === "string" ||
      r.deletedAt instanceof Date ||
      r.deletedAt === null)
      ? r.deletedAt
      : undefined;
  return { id, status, deletedAt };
}

function lowSessionSubscriptions(
  eventsData: TConsulteeEventsResponse,
  now: Date,
) {
  return (eventsData.subscriptions ?? []).flatMap((sub) => {
    const status = sub.status.toUpperCase();
    if (status !== "APPROVED" && status !== "COMPLETED") return [];

    if (hasLiveRenewal(readSubscriptionRenewal(sub))) return [];

    const planId = sub.subscriptionPlan.id ?? sub.subscriptionPlanId;
    if (!planId) return [];

    const planTotal = schedulableSessionsOf(sub);
    if (!planTotal || planTotal <= 0) return [];

    const occurrences = sub.appointment?.occurrences ?? [];
    const completedOrPast = occurrences.filter(
      (o) => !isDeadOccurrence(o) && isOccurrenceOver(toOccurrenceVM(o), now),
    ).length;
    const remaining = Math.max(0, planTotal - completedOrPast);

    if (remaining > 1) return [];
    const title = sub.subscriptionPlan.title || "Subscription";
    const consultantName =
      sub.subscriptionPlan.consultantProfile?.user?.name ?? "your expert";
    return [
      {
        key: `renew-subscription:${sub.id}`,
        severity: "info" as const,
        title:
          remaining === 1
            ? `1 session left in ${title}`
            : `All sessions completed in ${title}`,
        body: `Continue working with ${consultantName} by renewing your subscription.`,
        ctaLabel: "Renew subscription",
        ctaHref: `/checkout/plans/subscription/${planId}?renewsSubscriptionId=${sub.id}`,
      },
    ];
  });
}

interface ReviewableSessionRow {
  appointmentId: string;
  consultantProfileId: string;
  consultantName: string | null;
  existingReview: unknown;
}

type SessionCaseRow = {
  id: string;
  category: string | null;
  status: string;
  appointment: { planTitle: string | null } | null;
};

/** Open conduct removal cases: support is reviewing them and wants the learner's side. */
function openRemovalReviews(rows: SessionCaseRow[] | undefined) {
  return (rows ?? [])
    .filter(
      (c) =>
        c.category === CONDUCT_REMOVAL_CATEGORY &&
        c.status !== "RESOLVED" &&
        c.status !== "CLOSED",
    )
    .map((c) => ({
      caseId: c.id,
      title: c.appointment?.planTitle ?? "Your removed seat",
    }));
}

async function fetchJson<T>(url: string, unwrap: boolean): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  const json = await res.json();
  return (unwrap ? json.data : json) as T;
}

function formatSpend(summary: ConsulteeMoneySummary | undefined): string {
  if (!summary) return "—";
  if (summary.spentThisMonth.length === 0)
    return formatCurrencyAmount(0, "INR");
  // Totalled per currency, never converted.
  return summary.spentThisMonth
    .map((s) => formatCurrencyAmount(s.paise, s.currency))
    .join(" + ");
}

export default function HomeTab({
  learner,
  viewerOwnsProfile: isOwner,
  eventsData,
  consulteeId,
  viewerZone,
}: Readonly<HomeTabProps>) {
  const router = useRouter();
  const basePath = `/dashboard/consultee/${consulteeId}`;
  const [joiningEventId, setJoiningEventId] = useState<string | null>(null);
  const guardJoin = useInFlightGuard();
  const { toast } = useToast();
  const { formatPrice } = useCurrency();
  const { data: session } = useSession();

  // #1280 2.7 — the ref-backed guard closes the double-click window that the
  // async `joiningEventId` state write leaves open.
  const handleJoinMeeting = (event: ProcessedEvent) =>
    guardJoin(`join:${event.id}`, () => joinMeetingForEvent(event));

  const joinMeetingForEvent = async (event: ProcessedEvent) => {
    if (!event.joinableAppointment || !event.joinableSlot) {
      toast({
        title: "Unable to join",
        description: "Meeting data is not available.",
        variant: "destructive",
      });
      return;
    }

    // #248: read the already-connected video client singleton at click time,
    // briefly waiting for the deferred connect instead of erroring.
    setJoiningEventId(event.id);
    const waitStartedAt = Date.now();
    const client = await waitForGlobalVideoClient();
    if (!client) {
      setJoiningEventId(null);
      reportSentryMessage("Video client not ready at Join", {
        subsystem: "client",
        op: "join-meeting",
        expected: true,
        extra: describeVideoClientWait(Date.now() - waitStartedAt),
      });
      toast({
        title: "Connecting…",
        description:
          "Setting up your meeting client. Please try Join again in a moment.",
        variant: "warning",
      });
      return;
    }

    try {
      // #248: lazy-import the meeting helper (it imports the SDK) on demand.
      const { getOrCreateAppointmentMeeting } = await import("@/lib/meeting");
      const meetingId = await getOrCreateAppointmentMeeting(event.joinableSlot);
      router.push(`/meetings/${meetingId}`);
      toast({
        title: "Joining meeting",
        description: "You will now be redirected to the meeting",
        variant: "success",
      });
    } catch (error) {
      console.error("Error joining meeting:", error);
      toast(
        failureToast(
          reportClientFailure(error, {
            subsystem: "client",
            op: "join-meeting",
            title: "Error joining meeting",
            extra: {
              appointmentId: event.joinableAppointment.id,
              slotId: event.joinableSlot.id,
            },
          }),
        ),
      );
    } finally {
      setJoiningEventId(null);
    }
  };

  const now = useNowTick();
  const processedEvents = useMemo(
    () => processAllEvents(eventsData, now),
    [eventsData, now],
  );
  const upcomingEvents = useMemo(
    () => getUpcomingEvents(processedEvents, now),
    [processedEvents, now],
  );
  // #1527 — Next up is live scheduled sessions only: an unpaid request is in
  // Needs you and a request waiting on the expert is Appointments' concern.
  const nextUp = selectNextUp(upcomingEvents, NEXT_UP_LIMIT);

  // Same key (and cache entry) as the Billing page's Needs-you band.
  const { data: money } = useQuery({
    queryKey: ["pending-payments", consulteeId],
    staleTime: 2 * 60_000,
    queryFn: () => fetchPendingPayments(consulteeId),
  });
  const { data: reviewable } = useQuery({
    queryKey: ["reviewable-sessions"],
    staleTime: 5 * 60_000,
    enabled: isOwner,
    queryFn: () =>
      fetchJson<ReviewableSessionRow[]>(
        "/api/user/reviews/reviewable-sessions?unreviewed=1",
        true,
      ),
  });
  const { data: revisions } = useQuery({
    queryKey: ["documents", "library", "consultee", consulteeId, "your-turn"],
    staleTime: 2 * 60_000,
    queryFn: () =>
      fetchJson<LibraryPage<LibraryDocument>>(
        `/api/dashboard/consultee/${consulteeId}/documents?status=your-turn`,
        false,
      ),
  });
  const { data: summary } = useQuery({
    queryKey: ["consultee-payments", consulteeId, "summary"],
    staleTime: 2 * 60_000,
    queryFn: () =>
      fetchJson<ConsulteeMoneySummary>(
        `/api/dashboard/consultee/${consulteeId}/payments?view=summary`,
        true,
      ),
  });

  const { data: sessionCases } = useQuery({
    queryKey: ["support-requests", "session", "home"],
    staleTime: 2 * 60_000,
    enabled: isOwner,
    queryFn: () =>
      fetchJson<SessionCaseRow[]>("/api/support/requests?scope=session", true),
  });

  const pendingPayments = money?.pendingPayments;
  const actionItems = useMemo(
    () => [
      ...deriveConsulteeActionItems({
        pendingPaymentCount: pendingPayments?.length ?? 0,
        pendingPaymentTotalPaise: (pendingPayments ?? []).reduce(
          (sum, p) => sum + (p.amount ?? 0),
          0,
        ),
        // startsAt/endsAt already describe the whole run here (#1061).
        upcomingSessions: upcomingEvents.flatMap((e) =>
          e.startsAt && e.endsAt
            ? [
                {
                  id: e.id,
                  appointmentId: e.appointmentId ?? null,
                  startsAt: e.startsAt,
                  endsAt: e.endsAt,
                  title: e.title,
                },
              ]
            : [],
        ),
        basePath,
        lapsedPayLinks: (money?.lapsedPayLinks ?? []).map((link) => ({
          id: link.id,
          consultantName: link.consultantName,
          href: link.requestAgainHref,
        })),
        rescheduleProposals: proposalsAwaiting(eventsData, learner?.userId),
        // Both keys are session-scoped and not per learner: a cached owner read must not reach an operator view.
        sessionsToRate: (isOwner ? (reviewable ?? []) : [])
          .filter((s) => !s.existingReview)
          .slice(0, RATE_PROMPT_LIMIT)
          .map((s) => ({
            key: s.appointmentId,
            consultantName: s.consultantName ?? "your expert",
            href: `/explore/experts/${s.consultantProfileId}#reviews`,
          })),
        documentsToRevise: (revisions?.groups ?? [])
          .flatMap((g) =>
            g.files
              .filter((f) => f.needsYou)
              .map((f) => ({
                id: f.id,
                name: f.title,
                appointmentId: g.session.appointmentId,
              })),
          )
          .slice(0, 5),
        failedRefunds: (money?.failedRefunds ?? []).map((r) => ({
          paymentId: r.paymentId,
          amountText: formatCurrencyAmount(r.amountPaise, r.currency),
        })),
        removalReviews: isOwner ? openRemovalReviews(sessionCases) : [],
        now,
      }),
      ...lowSessionSubscriptions(eventsData, now),
    ],
    [
      pendingPayments,
      money,
      upcomingEvents,
      basePath,
      eventsData,
      learner?.userId,
      reviewable,
      revisions,
      sessionCases,
      isOwner,
      now,
    ],
  );

  const orgDashboards = useMemo(
    () =>
      isOwner
        ? resolveDashboardFacets({
            role: session?.user.role,
            memberships: session?.user.organizationMemberships ?? [],
          }).organizations.filter((f) => f.kind === "organization")
        : [],
    [isOwner, session?.user.role, session?.user.organizationMemberships],
  );
  const title = personalHomeTitle(learner, isOwner);

  const monthSessions = useMemo(
    () => sessionsThisMonth(processedEvents, viewerZone.zone, now),
    [processedEvents, viewerZone.zone, now],
  );

  return (
    <div className="space-y-8">
      <PageHeader
        className="mb-0"
        title={
          title ?? (
            <span
              className="inline-block h-7 w-48 motion-safe:animate-pulse rounded-md bg-muted align-middle"
              aria-label="Loading greeting"
            />
          )
        }
        description="What needs you, and what's next."
      />

      {isOwner && <MyAlerts viewerZone={viewerZone} />}

      <ActionRequiredPanel
        items={actionItems}
        heading="Needs you"
        className="space-y-2"
        emptyState={
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
            <CheckCircle2
              className="h-5 w-5 shrink-0 text-emerald-600"
              aria-hidden
            />
            <div>
              <p className="text-sm font-semibold text-foreground">
                All caught up
              </p>
              <p className="text-sm text-muted-foreground">
                Nothing is waiting on you right now.
              </p>
            </div>
          </div>
        }
      />

      <Section
        title="Next up"
        actions={
          <Link
            href={`${basePath}/appointments`}
            className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
          >
            All appointments
          </Link>
        }
      >
        {nextUp.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {nextUp.map((event) => (
              <NextUpCard
                key={event.id}
                event={event}
                href={
                  event.appointmentId
                    ? `${basePath}/appointments/${event.appointmentId}`
                    : null
                }
                viewerZone={viewerZone}
                now={now}
                onJoin={() => handleJoinMeeting(event)}
                isJoining={joiningEventId === event.id}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Calendar}
            title="No upcoming sessions"
            description="Book a session with an expert to get started."
            action={
              <Button asChild>
                <Link href="/explore/experts">
                  <Users className="mr-2 h-4 w-4" />
                  Find experts
                </Link>
              </Button>
            }
          />
        )}
      </Section>

      <Section
        title="This month · personal"
        description={
          orgDashboards.length > 0 ? (
            <>
              Sessions and payments you made yourself. Organization-funded
              sessions appear on your organization dashboard:{" "}
              {orgDashboards.map((org, i) => (
                <span key={org.key}>
                  {i > 0 && ", "}
                  <Link
                    href={org.href}
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {org.label}
                  </Link>
                </span>
              ))}
              .
            </>
          ) : undefined
        }
      >
        <StatRow columns={3}>
          <Stat
            label="Sessions"
            value={monthSessions}
            hint="Your own, scheduled or held this month"
            href={`${basePath}/appointments`}
          />
          <Stat
            label="Spent personally"
            value={formatSpend(summary)}
            hint="Net of refunds"
            href={`${basePath}/payments?tab=history`}
          />
          <Stat
            label="Credits"
            value={summary ? formatPrice(summary.creditBalancePaise) : "—"}
            hint="Available to use"
            href={`${basePath}/payments?tab=credits`}
          />
        </StatRow>
      </Section>

      {/* #1778 — held times this learner asked to hear about. */}
      {isOwner && <WaitingTimesStrip />}

      {/* #1527 — answers live in the public Help Center; your private
          conversations with us live in Support cases. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <HelpCard
          href="/support"
          icon={LifeBuoy}
          title="Browse the Help Center"
          body="Answers about bookings, payments, and sessions."
        />
        <HelpCard
          href={`${basePath}/support`}
          icon={MessageSquareText}
          title="Open a support case"
          body="Ask our team about a booking or a payment."
        />
      </div>
    </div>
  );
}

function HelpCard({
  href,
  icon: Icon,
  title,
  body,
}: Readonly<{
  href: string;
  icon: typeof LifeBuoy;
  title: string;
  body: string;
}>) {
  return (
    <Link
      href={href}
      className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon
        className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </Link>
  );
}
