"use client";

import { useCallback, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProvidedZone, useZonedFormat } from "@/lib/time/zoned-format";
import {
  formatInViewerZone,
  isValidTimeZone,
  zoneLabel,
} from "@/lib/time/viewer-zone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarClock,
  CalendarX,
  ChevronDown,
  CreditCard,
  LifeBuoy,
  Video,
  MessageSquare,
  Receipt,
  Star,
  Users,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/dashboard/DataCard";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { AppointmentDetailSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { throwSupportError } from "@/lib/support/error-copy";
import { requireJsonResponse } from "@/lib/fetch-helpers";
import { formatRole } from "@/components/collaborators/format";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import type {
  AppointmentActionAdapter,
  AppointmentChatTarget,
  OverflowItem,
} from "@/lib/appointments/adapter";
import { mapAppointmentDetail } from "@/lib/appointments/map-detail";
import {
  presentationNames,
  toPresentationInput,
} from "@/lib/appointments/presentation-input";
import {
  deriveBookingPresentation,
  toneBadge,
  type BookingStateKind,
} from "@/lib/dashboard/money-state";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import { bookingPayHref } from "@/lib/appointments/trial-checkout-href";
import { isExternalPayHref } from "@/lib/payments/pay-link-href";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import {
  paymentStatusBadge,
  paymentStatusDot,
  resolveSponsoringOrgName,
} from "@/lib/labels/session-labels";
import { AppointmentsType } from "@prisma/client";
import { useSession } from "@/lib/auth-client";
import { formatCurrencyAmount } from "@/utils/formatting";
import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";
import {
  isGroupKind,
  isSingleSessionKind,
  supportsDocuments,
} from "@/lib/appointments/kind-capabilities";
import {
  formatFundingBreakdown,
  isSponsoredPayment,
  paymentFundingBreakdown,
  paymentRailLabel,
  receiptHref,
  type PaymentDisplayLike,
} from "@/lib/appointments/payment-display";
import {
  paymentDisplayStatus,
  seatPaymentsByUser,
  summarizeSeatPayments,
} from "@/lib/appointments/seat-payments";
import { useNowTick } from "@/hooks/use-now-tick";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  appointmentStatusChip,
  getOccurrenceVMJoinState,
  isDeadOccurrence,
  isDeliberateEnd,
  isOccurrenceOver,
} from "@/lib/appointments/occurrences";
import { NeedsYouCallout } from "./NeedsYouCallout";
import { TimelineStrip } from "./TimelineStrip";
import { CountdownBadge } from "../CountdownBadge";
import { KIND_LABEL } from "../AppointmentRow";
import { RowPrimaryAction } from "../RowPrimaryAction";
import { useClassSessionActions } from "./ClassSessionControls";
import { useSubscriptionReturnActions } from "./SubscriptionReturnControls";
import { SessionSchedule, type SessionRowAction } from "./SessionSchedule";
import { SessionAttendance } from "./SessionAttendance";
import { RescheduleProposalCard } from "./RescheduleProposalCard";
import { LazyAppointmentChatSheet } from "../LazyAppointmentChatSheet";
import { caseKeyOf } from "@/lib/support/case-key";
import { AppointmentSupportStatusCard } from "@/components/support/AppointmentSupportStatusCard";
import { SessionRatingRow } from "@/components/reviews/SessionRatingRow";
import { useSessionFeedback } from "@/hooks/useSessionFeedback";
import { ResourceSnapshot, type ResourceHrefs } from "./ResourceSnapshot";
import { cn } from "@/utils/tailwind";

const PARTICIPANTS_PREVIEW = 5;

/** Overflow actions that change when sessions happen; they sit with the sessions. */
const SCHEDULE_KEYS = new Set(["reschedule", "new-time", "retime", "timings"]);

// #1675 — booking states from which the booking is a sold, scheduled thing:
// the progress bar and "Cancel booking" appear from here on; a request has
// Decline (consultant) instead.
const POST_APPROVAL = new Set<BookingStateKind>([
  "CONFIRMED",
  "AWAITING_ALLOCATION",
  "COMPLETED",
]);

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/80 bg-card p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

type MoneyRow = PaymentDisplayLike & {
  amount: number | string;
  currency: string | null;
  createdAt: string | Date;
};

/** One line per charge: amount, status, the rail it rode, the date — and the receipt. */
function MoneyLine({ payment }: { payment: MoneyRow }) {
  const format = useZonedFormat();
  const rail = paymentRailLabel(payment);
  const receipt = receiptHref(payment);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-muted px-3 py-2 text-sm">
      <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="font-medium text-foreground tabular-nums">
        {formatCurrencyAmount(
          Number(payment.amount),
          payment.currency ?? "INR",
        )}
      </span>
      <StatusBadge
        {...paymentStatusBadge(paymentDisplayStatus(payment))}
        size="sm"
      />
      <span className="text-xs text-muted-foreground">
        {rail ? `via ${rail} · ` : ""}
        {format(new Date(payment.createdAt), "d MMM yyyy")}
      </span>
      {receipt && (
        <a
          href={receipt}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-xs font-medium text-foreground underline underline-offset-4"
        >
          View receipt
        </a>
      )}
    </div>
  );
}

/** A failed ratings read must not render as "unrated" — say so, offer a retry. */
function RatingsUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2">
      <p className="text-sm text-muted-foreground">
        Couldn&apos;t load the ratings for these sessions.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * The rating of a single-sitting booking's one session, in the header's
 * primary slot once the Sessions card is folded away. Same gates as the
 * session row: stars only where a rating would be accepted, the consultant
 * reads what it scored and sets nothing.
 */
function SoleSessionRating({
  appointmentId,
  session,
  role,
  feedback,
}: {
  appointmentId: string;
  session: AppointmentVM["occurrences"][number];
  role: "consultee" | "consultant";
  feedback: ReturnType<typeof useSessionFeedback>;
}) {
  const rating = feedback.ratings[session.occurrenceId] ?? null;
  const canRate = feedback.rateable.has(session.occurrenceId);
  const readOnly = role !== "consultee" || !canRate;
  if (rating === null && readOnly) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-1.5 text-xs">
      <span className="font-medium text-foreground">
        {readOnly
          ? "Attendee's rating"
          : rating === null
            ? "Rate this session"
            : "Your rating"}
      </span>
      <SessionRatingRow
        appointmentId={session.appointmentId ?? appointmentId}
        bookingAppointmentId={appointmentId}
        occurrenceId={session.occurrenceId}
        existingRating={rating}
        readOnly={readOnly}
      />
    </div>
  );
}

interface AppointmentDetailClientProps {
  appointmentId: string;
  role: "consultee" | "consultant";
  adapter: AppointmentActionAdapter;
  backHref: string;
  /** This booking's Documents workspace and Recording details pages in the viewer's tree. */
  resourceHrefs: ResourceHrefs;
  /** Consultant-only: participants management link resolver. */
  participantsHref?: (detail: TAppointmentDetail) => string | null;
  joinWindowMs?: number;
  /** Consultant-only: the dashboard whose Requests/allocate pages answer a request. */
  consultantId?: string;
  /** Extra buttons for the header action row, e.g. the consultee's Book again / Add to calendar. */
  renderExtraActions?: (
    vm: AppointmentVM,
    actions: { openChat: (target: AppointmentChatTarget) => void },
  ) => ReactNode;
  /** Full-width banners above the sessions, e.g. a renewal nudge or an incident remedy. */
  renderNotices?: (vm: AppointmentVM) => ReactNode;
  /** `<tree>/support/requests` — "Get help" opens this booking's request page (#1527). */
  supportRequestsBase: string;
}

export function AppointmentDetailClient({
  appointmentId,
  role,
  adapter,
  backHref,
  resourceHrefs,
  participantsHref,
  joinWindowMs,
  consultantId,
  renderExtraActions,
  renderNotices,
  supportRequestsBase,
}: AppointmentDetailClientProps) {
  const format = useZonedFormat();
  const { data: session } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [chatTarget, setChatTarget] = useState<AppointmentChatTarget | null>(
    null,
  );
  const closeChat = useCallback(() => setChatTarget(null), []);
  const clickOf = (item: OverflowItem) => {
    const { chat } = item;
    return chat ? () => setChatTarget(chat) : item.onClick;
  };
  const {
    data: detail,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["appointment-detail", appointmentId] as const,
    queryFn: async (): Promise<TAppointmentDetail> => {
      const res = await fetch(`/api/appointments/${appointmentId}`);
      if (!res.ok) await throwSupportError(res, "appointment detail load");
      const { data } = await res.json();
      return data;
    },
  });

  // #1775 — the consultant's two actions on an unpaid approval; the callout
  // reads the 429 / 409 answers off the ApiResponseError these throw.
  let requestPath: string | null = null;
  if (detail?.appointment.consultation) {
    requestPath = `/api/bookings/consultations/${detail.appointment.consultation.id}`;
  } else if (detail?.appointment.subscription) {
    requestPath = `/api/bookings/subscriptions/${detail.appointment.subscription.id}`;
  }
  const postRequestAction = async (action: "remind" | "withdraw-approval") => {
    if (!requestPath) throw new Error("No request to act on");
    const res = await fetch(`${requestPath}/${action}`, { method: "POST" });
    return requireJsonResponse(res, "Request action");
  };
  const remindMutation = useMutation({
    mutationFn: () =>
      postRequestAction("remind") as Promise<{ nextAllowedAt: string }>,
  });
  const withdrawMutation = useMutation({
    mutationFn: () => postRequestAction("withdraw-approval"),
  });

  const mapped = detail
    ? mapAppointmentDetail(detail, role, new Date(), consultantId)
    : null;
  // #1540 — which calls of this booking the viewer has already rated, in ONE
  // request; #1554 made the booking one Appointment, so that is one row.
  const sessionFeedback = useSessionFeedback(appointmentId);
  useSetBreadcrumbLabel(mapped?.vm.title);
  const viewerZone = useProvidedZone();
  const now = useNowTick();
  const refreshDetail = () => {
    void queryClient.invalidateQueries({
      queryKey: ["appointment-detail", appointmentId],
    });
  };
  // Per-session actions live on the session rows; the hooks run before the
  // loading and error returns below, so they take the read as it stands.
  const classActions = useClassSessionActions({
    appointmentId,
    sessions: detail?.appointment.class ? detail.appointment.occurrences : [],
    role,
    // A seat's unit depends on when it was bought; the copy says "one
    // session" rather than guess a list price.
    unitLabel: null,
    onChanged: refreshDetail,
  });
  const returnActions = useSubscriptionReturnActions({
    appointmentId,
    sessions: detail?.appointment.occurrences ?? [],
    sessionsReturned: detail?.appointment.subscription?.sessionsReturned ?? 0,
    rescheduleOpen: !!detail?.appointment.rescheduleRequests?.[0],
    onChanged: refreshDetail,
    enabled:
      role === "consultee" &&
      detail?.appointment.subscription?.status === "APPROVED",
  });

  const payments = detail?.appointment.payment ?? [];
  // #1527 — one request page, two doors: "Get help" opens on the intent
  // options, "Problem with this charge" already on PAYMENT_STATUS.
  const supportHref = `${supportRequestsBase}/${caseKeyOf({ kind: "booking", id: appointmentId })}`;
  const openHelp = (intent?: string) =>
    router.push(intent ? `${supportHref}?intent=${intent}` : supportHref);

  if (isLoading && !detail) {
    return <AppointmentDetailSkeleton />;
  }

  if (error || !detail || !mapped) {
    return (
      <EmptyState
        icon={CalendarX}
        title="Couldn't load this appointment"
        description={
          error instanceof Error ? error.message : "Please try again."
        }
        action={
          <Button variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const { vm } = mapped;
  const action = adapter.primaryAction(vm);
  const orgName =
    detail.appointment.organization?.name ??
    resolveSponsoringOrgName(
      vm.organizationId,
      session?.user?.organizationMemberships ?? [],
    );
  const viewerId = session?.user?.id ?? null;
  const pendingRow =
    payments.find((p) => p.paymentStatus === "PENDING") ?? null;
  const paidRow = payments.find((p) => p.paymentStatus === "SUCCEEDED") ?? null;
  const paidBreakdown = paidRow ? paymentFundingBreakdown(paidRow.legs) : [];
  // Who funded THIS row. A seat on someone else's webinar is sponsored by the
  // attendee's own organisation, which is not the event's tag.
  const sponsorOf = (p: { organizationId: string | null }) =>
    (p.organizationId &&
    p.organizationId !== detail.appointment.organization?.id
      ? resolveSponsoringOrgName(
          p.organizationId,
          session?.user?.organizationMemberships ?? [],
        )
      : orgName) ?? "the organisation";
  // #1675 — ONE derivation of the booking's state, its money and this
  // viewer's next action; every block below reads it, none reads an enum.
  const names = presentationNames(detail, {
    role,
    name: session?.user?.name ?? null,
  });
  const presentation = deriveBookingPresentation(
    toPresentationInput(detail, {
      viewerId,
      names,
      sponsorOrgName: paidRow ? sponsorOf(paidRow) : orgName,
    }),
    role === "consultant" ? "CONSULTANT" : "CONSULTEE",
    { joinWindowMs },
  );
  const { bookingState, moneyState, nextAction } = presentation;
  const postApproval = POST_APPROVAL.has(bookingState.state);
  // A confirmed booking wears the learner's Appointments chip; other states say why.
  const headerChip =
    role === "consultee" && bookingState.state === "CONFIRMED"
      ? appointmentStatusChip(vm, role)
      : toneBadge(bookingState.tone, bookingState.label);
  // #1163 — the proposal card below IS the answer surface; the adapter's
  // "Review reschedule request" list affordance would only link back here.
  // "Report issue" opens the same per-appointment support thread as the
  // "Get help" button beside it — one entry point on this page.
  // #1675 — "Cancel booking" only from CONFIRMED on: the consultant answers
  // a request with Decline, and the payer's exit from one is a withdrawal.
  const overflow = adapter
    .overflowItems(vm)
    .filter(
      (item) => item.key !== "reschedule-proposal" && item.key !== "report",
    )
    .filter(
      (item) => item.key !== "cancel" || postApproval || role === "consultee",
    )
    .map((item) =>
      item.key === "cancel" && !postApproval
        ? { ...item, label: "Withdraw request" }
        : item,
    );
  const heldCount = detail.appointment.occurrences.filter(
    (o) => o.isTentative && !isDeadOccurrence(o),
  ).length;
  // #1675 — one session-count story: a plan's own header reads the held/plan
  // progress the money line no longer repeats, instead of a second, plain
  // total. SonarCloud (PR #1767) flagged the inline nested ternary this
  // replaced.
  const usesSessionProgress =
    (vm.kind === "SUBSCRIPTION" || vm.kind === "CLASS") &&
    !!presentation.sessionProgress;
  const groupCountLine = usesSessionProgress
    ? presentation.sessionProgress
    : `${vm.group?.total ?? 0} session${vm.group?.total === 1 ? "" : "s"}`;
  // The consultant's answer to a request, through the Requests page's own
  // mutations (request-decision.ts); no times → the allocator sets them.
  const request =
    detail.appointment.consultation ?? detail.appointment.subscription;
  const requestKind = detail.appointment.consultation
    ? AppointmentsType.CONSULTATION
    : AppointmentsType.SUBSCRIPTION;
  const decision =
    role === "consultant" && request && consultantId
      ? {
          request: {
            id: request.id,
            type: requestKind,
            tentativeSlotCount: detail.appointment.occurrences.filter(
              (o) => o.isTentative,
            ).length,
          },
          canApproveRequestedTimes:
            request.bookingSource === "REQUEST_SUBMITTED" &&
            heldCount > 0 &&
            !detail.appointment.occurrences.some(isReleasedForReschedule),
          allocateHref: `/dashboard/consultant/${consultantId}/requests/${request.id}/allocate?type=${requestKind.toLowerCase()}`,
          requestsHref: `/dashboard/consultant/${consultantId}/requests`,
          onDecided: () => {
            void queryClient.invalidateQueries({
              queryKey: ["appointment-detail", appointmentId],
            });
          },
        }
      : undefined;
  const participants = Array.from(
    new Map(
      detail.appointment.participants.map((seat) => [seat.user.id, seat.user]),
    ).values(),
  );
  const previewParticipants = participants.slice(0, PARTICIPANTS_PREVIEW);
  const hiddenParticipantCount = Math.max(
    0,
    participants.length - PARTICIPANTS_PREVIEW,
  );
  const manageHref = participantsHref?.(detail) ?? null;
  // A group event's money is one row per attendee. The host reads it as a
  // status on each seat plus a total; an attendee's `payments` is already
  // just their own (scopeAppointmentDetail).
  const isGroup = isGroupKind(vm.kind);
  const seatPayments = seatPaymentsByUser(payments);
  // The plan's settlement currency names the total, not whichever row came
  // first.
  const seatSummary = summarizeSeatPayments(
    seatPayments,
    detail.appointment.webinar?.webinarPlan?.priceCurrency ??
      detail.appointment.class?.classPlan?.priceCurrency ??
      "INR",
  );
  // #1163 — the read narrows to open statuses and takes one, so [0] is THE
  // live proposal; the card is the answer surface "Awaiting schedule
  // confirmation" never offered.
  const openProposal = detail.appointment.rescheduleRequests?.[0] ?? null;
  const showSeatSummary = role === "consultant" && isGroup;
  // Sponsorship is what the money says, not the org tag: checkout stamps
  // `Appointment.organizationId` on a PERSONAL-funded booking too, and that
  // member paid their own card. A group event keeps the tag as its label.
  const sponsoredBy =
    orgName && (isGroup || payments.some(isSponsoredPayment)) ? orgName : null;
  // Did the viewer pay anything on this page themselves? Names the money door.
  const hasOwnCharge = payments.some(
    (p) =>
      !isSponsoredPayment(p) ||
      p.childPayments.some((c) => c.userId === viewerId),
  );
  const liveVmOccurrences = vm.occurrences.filter((s) => !isDeadOccurrence(s));
  // A single-sitting booking's one confirmed session is already the header's
  // date line; the Sessions card stays only while it carries something the
  // header cannot — a held row awaiting payment, or an open proposal.
  const soleSession =
    isSingleSessionKind(vm.kind) &&
    liveVmOccurrences.length === 1 &&
    !liveVmOccurrences[0].isTentative &&
    !openProposal
      ? liveVmOccurrences[0]
      : null;
  const soleSessionOver =
    !!soleSession &&
    !isDeadOccurrence(soleSession) &&
    getOccurrenceVMJoinState(soleSession, { joinWindowMs }) !== "joinable" &&
    isOccurrenceOver(soleSession);
  // The one session's stars belong in the needs-you slot only while a rating
  // would be accepted (or one exists to show); otherwise nothing is due.
  const rateableSole =
    !!soleSession &&
    soleSessionOver &&
    !sessionFeedback.isError &&
    (sessionFeedback.rateable.has(soleSession.occurrenceId) ||
      (sessionFeedback.ratings[soleSession.occurrenceId] ?? null) !== null)
      ? soleSession
      : null;
  const anchorSession = vm.nextAt
    ? liveVmOccurrences.find(
        (s) => s.startsAt.getTime() === vm.nextAt?.getTime(),
      )
    : undefined;
  const hasConfirmedSessions = liveVmOccurrences.some((s) => !s.isTentative);
  const hasTentativeSessions = liveVmOccurrences.some((s) => s.isTentative);
  // #1429 F2 / #1775 P-1 — both Pay Now entry points ask the one shared
  // helper: the trial's branded page or our pay page (SPA push), else a hosted link.
  const payHref = bookingPayHref(vm);
  const openPendingPayment = () => {
    if (!payHref) return;
    if (isExternalPayHref(payHref)) {
      window.open(payHref, "_blank", "noopener,noreferrer");
      return;
    }
    router.push(payHref);
  };

  // Each overflow action is placed where it belongs on the page; items the
  // page already covers (Resources, Participants, the Set schedule button) drop.
  const coveredKeys = new Set<string>(["documents"]);
  if (manageHref) coveredKeys.add("participants");
  if (action.kind === "schedule") coveredKeys.add("timings");
  const placed = overflow.filter((item) => !coveredKeys.has(item.key));
  const chatItems = placed.filter((item) => item.chat && !item.destructive);
  const scheduleItems = placed.filter(
    (item) => !item.chat && !item.destructive && SCHEDULE_KEYS.has(item.key),
  );
  const manageItems = placed.filter(
    (item) => !chatItems.includes(item) && !scheduleItems.includes(item),
  );
  const renderActionButton = (item: OverflowItem) => (
    <Button
      key={item.key}
      variant="outline"
      size="sm"
      disabled={item.disabled}
      onClick={clickOf(item)}
      className={cn(
        item.destructive &&
          "border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-900/40 dark:text-red-400 dark:hover:bg-red-900/20",
      )}
    >
      {item.label}
    </Button>
  );
  const scheduleActions =
    scheduleItems.length > 0 ? (
      <div className="flex flex-wrap items-center gap-2">
        {scheduleItems.map(renderActionButton)}
      </div>
    ) : null;
  const showReviewCard =
    role === "consultee" &&
    !!vm.consultantProfileId &&
    (bookingState.state === "COMPLETED" ||
      detail.appointment.occurrences.some(
        (o) => o.completionStatus === "COMPLETED",
      ));
  const showProgress =
    !!vm.group && vm.group.total > 0 && postApproval && !usesSessionProgress;
  const hasDetails =
    vm.kind === "TRIAL" || !!sponsoredBy || vm.collaborators.length > 0;
  // A one-sitting consultee booking has nothing for a main column once the
  // header carries its session, so its cards flow as one grid instead.
  const compactLayout = !!soleSession && role === "consultee";
  // The other party's wall clock for the next session, when their zone is
  // known and differs, so neither side has to convert a time in their head.
  const counterpartZone = (() => {
    const seats = detail.appointment.participants as Array<{
      role: string;
      user: { id: string; timezone?: string | null };
    }>;
    if (isGroup) {
      return role === "consultee"
        ? (seats.find((s) => s.role === "CONSULTANT")?.user.timezone ?? null)
        : null;
    }
    const other = seats.filter((s) =>
      role === "consultee" ? s.role === "CONSULTANT" : s.role === "CONSULTEE",
    );
    return other.length === 1 ? (other[0].user.timezone ?? null) : null;
  })();
  const theirTime =
    vm.nextAt &&
    viewerZone &&
    isValidTimeZone(counterpartZone) &&
    formatInViewerZone(vm.nextAt, counterpartZone, "xxx") !==
      formatInViewerZone(vm.nextAt, viewerZone, "xxx")
      ? `${formatInViewerZone(vm.nextAt, counterpartZone, "EEE h:mm a")} for ${vm.counterpart.name.split(" ")[0]} (${zoneLabel(vm.nextAt, counterpartZone)})`
      : null;
  // The next session's Join lives in the Next up panel the whole time: live
  // once the join window opens, and until then a disabled button that says
  // when it opens, so nobody hunts for it at the last minute.
  const joinWindow = joinWindowMs ?? CONSULTEE_JOIN_WINDOW_MS;
  const joinOpensAt = anchorSession
    ? new Date(anchorSession.startsAt.getTime() - joinWindow)
    : null;
  const canJoinNow = action.kind === "join";
  const joinNotYet =
    !canJoinNow &&
    !!joinOpensAt &&
    !anchorSession?.isTentative &&
    bookingState.state === "CONFIRMED" &&
    vm.bucket !== "past" &&
    vm.bucket !== "cancelled" &&
    now.getTime() < joinOpensAt.getTime();

  const heroCaption = canJoinNow
    ? "Your session is open"
    : vm.bucket === "past"
      ? "Last session"
      : isGroup || (vm.group?.total ?? 0) > 1
        ? "Next session"
        : "Session";

  let stickyCta: ReactNode = null;
  if (nextAction.kind === "PAY" && pendingRow && payHref) {
    stickyCta = (
      <Button
        className="w-full bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-600 dark:hover:bg-amber-500"
        onClick={openPendingPayment}
      >
        <CreditCard className="mr-1.5 h-4 w-4" />
        {nextAction.label}
      </Button>
    );
  } else if (
    action.kind !== "view" &&
    (nextAction.kind === "NONE" ||
      (nextAction.kind === "JOIN" && action.kind === "join"))
  ) {
    stickyCta = <RowPrimaryAction action={action} size="default" />;
  }

  // The plan's weekly count, so the schedule can call out a short week.
  const sessionsPerWeek =
    detail.appointment.subscription?.sessionsPerWeek ??
    detail.appointment.subscription?.subscriptionPlan?.sessionsPerWeek ??
    detail.appointment.class?.classPlan?.sessionsPerWeek ??
    null;
  const sessionsCard = !soleSession && (
    <Section
      title={
        heldCount > 0 && !postApproval
          ? `Sessions · ${heldCount} held`
          : "Sessions"
      }
      action={scheduleActions}
    >
      {/* Without this the stars below simply disappeared (or showed empty)
          on a call the viewer had already rated. */}
      {sessionFeedback.isError ? (
        <div className="mb-3">
          <RatingsUnavailable onRetry={() => sessionFeedback.retry()} />
        </div>
      ) : null}
      {showProgress && vm.group && (
        <div className="mb-5">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium text-foreground tabular-nums">
              {vm.group.completed} of {vm.group.total} done
            </span>
            <span className="text-muted-foreground tabular-nums">
              {Math.max(0, vm.group.total - vm.group.completed)} to go
            </span>
          </div>
          <Progress
            value={(vm.group.completed / vm.group.total) * 100}
            className="h-1.5"
          />
        </div>
      )}
      {classActions.notices && (
        <div className="mb-4">{classActions.notices}</div>
      )}
      {hasConfirmedSessions || hasTentativeSessions ? (
        <SessionSchedule
          renderSessionExtra={(session) => {
            // The host side sees who attended each session.
            const attendance =
              role === "consultant" ? (
                <SessionAttendance
                  appointmentId={session.appointmentId ?? appointmentId}
                  occurrenceId={session.occurrenceId}
                />
              ) : null;
            const rating =
              sessionFeedback.ratings[session.occurrenceId] ?? null;
            // Stars only where a rating would be accepted: the viewer
            // attended, or nobody could have recorded attendance.
            const canRate = sessionFeedback.rateable.has(session.occurrenceId);
            // A failing read leaves every row looking unrated; the notice
            // above explains instead.
            if (sessionFeedback.isError) return attendance;
            if (role === "consultee" && !canRate && rating === null) {
              return attendance;
            }
            return (
              <>
                {attendance}
                <SessionRatingRow
                  appointmentId={session.appointmentId ?? appointmentId}
                  bookingAppointmentId={appointmentId}
                  occurrenceId={session.occurrenceId}
                  existingRating={rating}
                  // Only the attendee sets a rating; the consultant reads it.
                  readOnly={role !== "consultee" || !canRate}
                />
              </>
            );
          }}
          occurrences={vm.occurrences}
          joinWindowMs={joinWindowMs}
          isJoining={action.kind === "join" && !!action.busy}
          onJoinSession={
            action.kind === "join" && action.onClick
              ? action.onClick
              : undefined
          }
          // Schedule words only; the pay verb lives in the needs-you slot.
          heldRowLabel={presentation.sessionRowLabel}
          rowActions={(session): SessionRowAction[] => [
            ...classActions.rowActions(session.occurrenceId),
            ...returnActions.rowActions(session.occurrenceId),
          ]}
          sessionsPerWeek={sessionsPerWeek}
          footnote={returnActions.footnote}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          No sessions scheduled yet.
        </p>
      )}
    </Section>
  );

  const participantsCard = role === "consultant" && (
    <Section
      title={
        participants.length > 0
          ? `Participants · ${participants.length}`
          : "Participants"
      }
      action={
        manageHref ? (
          <Button variant="ghost" size="sm" className="-my-1.5 h-8" asChild>
            <Link href={manageHref}>
              <Users className="mr-1.5 h-3.5 w-3.5" />
              Manage
            </Link>
          </Button>
        ) : null
      }
    >
      {participants.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No participants on this session yet.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {previewParticipants.map((u) => {
            const seat = isGroup ? seatPayments.get(u.id) : undefined;
            const seatStatus = seat ? paymentDisplayStatus(seat) : null;
            const seatBadge = seatStatus
              ? paymentStatusBadge(seatStatus)
              : null;
            return (
              <span
                key={u.id}
                title={seatBadge?.label}
                className="flex items-center gap-1.5 rounded-full border border-border bg-muted py-0.5 pl-1 pr-2.5 text-xs text-foreground"
              >
                <Avatar className="h-5 w-5">
                  <AvatarImage src={u.image ?? undefined} alt={u.name} />
                  <AvatarFallback className="text-[9px]">
                    {initials(u.name) || "?"}
                  </AvatarFallback>
                </Avatar>
                {u.name}
                {seat && seatBadge && (
                  <>
                    <span
                      aria-hidden
                      className={`ml-0.5 inline-block h-1.5 w-1.5 rounded-full ${paymentStatusDot(seatStatus)}`}
                    />
                    <span className="sr-only">{seatBadge.label}</span>
                  </>
                )}
              </span>
            );
          })}
          {hiddenParticipantCount > 0 && (
            <span className="inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
              +{hiddenParticipantCount} more
            </span>
          )}
        </div>
      )}
    </Section>
  );

  // A paid seat that cost nothing (a free event, a full discount) is why a
  // host can read "1 of 2 seats paid" beside nothing collected; name it.
  const freeSeats = Array.from(seatPayments.values()).filter((row) => {
    const status = paymentDisplayStatus(row);
    return (
      (status === "SUCCEEDED" || status === "PARTIALLY_REFUNDED") &&
      Number(row.amount) === 0
    );
  }).length;
  const seatRows: Array<[string, number]> = [
    ["Free seats", freeSeats],
    ["Awaiting payment", seatSummary.pending],
    ["Lapsed", seatSummary.lapsed],
    ["Refunded", seatSummary.refunded],
    ["In another currency", seatSummary.otherCurrency],
  ];
  const creditNotes = paidRow?.consumerInvoice?.creditNotes ?? [];
  const ownCoPays = payments
    .flatMap((p) => p.childPayments)
    .filter((c) => c.userId === viewerId && !isSponsoredPayment(c));
  const showBreakdown =
    !!paidRow && paidBreakdown.length > 1 && moneyState.state !== "SPONSORED";
  const hasPaymentDetails =
    showBreakdown || creditNotes.length > 0 || ownCoPays.length > 0;
  const paidReceipt = paidRow ? receiptHref(paidRow) : null;

  const paymentCard = (
    <Section title={showSeatSummary ? "Payments" : "Payment"}>
      {showSeatSummary ? (
        payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No seat has been paid for yet.
          </p>
        ) : (
          <dl className="space-y-1.5 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">Seats paid</dt>
              <dd className="font-medium text-foreground tabular-nums">
                {seatSummary.paid} of {participants.length} seat
                {participants.length === 1 ? "" : "s"} paid
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">Collected</dt>
              <dd className="font-medium text-foreground tabular-nums">
                {seatSummary.collectedPaise === 0 &&
                seatSummary.paid > 0 &&
                freeSeats === seatSummary.paid
                  ? "Nothing — every paid seat was free"
                  : `${formatCurrencyAmount(
                      seatSummary.collectedPaise,
                      seatSummary.currency,
                    )} collected`}
              </dd>
            </div>
            {seatRows
              .filter(([, count]) => count > 0)
              .map(([label, count]) => (
                <div
                  key={label}
                  className="flex items-baseline justify-between gap-3"
                >
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-foreground tabular-nums">{count}</dd>
                </div>
              ))}
          </dl>
        )
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              {moneyState.line}
            </p>
            {moneyState.detail && (
              <p className="text-xs text-muted-foreground tabular-nums">
                {moneyState.detail}
              </p>
            )}
          </div>
          {(paidReceipt || role === "consultee") && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
              {paidReceipt && (
                <a
                  href={paidReceipt}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
                >
                  <Receipt className="h-3.5 w-3.5" />
                  View receipt
                </a>
              )}
              {role === "consultee" && (
                <button
                  type="button"
                  className="font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  onClick={() => openHelp("PAYMENT_STATUS")}
                >
                  {hasOwnCharge
                    ? "Problem with this charge"
                    : "Problem with this booking"}
                </button>
              )}
            </div>
          )}
          {hasPaymentDetails && (
            <details className="group border-t border-border pt-3">
              <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                Payment details
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-2 space-y-2">
                {showBreakdown && paidRow && (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    Paid with{" "}
                    {formatFundingBreakdown(
                      paidBreakdown,
                      paidRow.currency ?? "INR",
                    )}
                  </p>
                )}
                {/* A refund's credit note sits beside the charge it reverses. */}
                {paidRow &&
                  creditNotes.map((note) => (
                    <a
                      key={note.id}
                      href={`/api/payments/${paidRow.id}/credit-note/${note.id}/pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-xs font-medium text-foreground underline underline-offset-4"
                    >
                      Credit note {note.creditNoteNumber}
                    </a>
                  ))}
                {/* A co-pay the viewer paid themselves keeps its own receipt. */}
                {ownCoPays.map((c) => (
                  <MoneyLine key={c.id} payment={c} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </Section>
  );

  const detailsCard = hasDetails && (
    <Section title="Details">
      <dl className="space-y-2.5 text-sm">
        {vm.kind === "TRIAL" && (
          <div>
            <dt className="text-xs text-muted-foreground">Booking type</dt>
            <dd className="text-foreground">
              Trial booking — direct chat requires a paid plan
            </dd>
          </div>
        )}
        {sponsoredBy && (
          <div>
            <dt className="text-xs text-muted-foreground">Sponsored by</dt>
            <dd className="font-medium text-foreground">{sponsoredBy}</dd>
          </div>
        )}
        {vm.collaborators.length > 0 && (
          <div>
            <dt className="text-xs text-muted-foreground">Collaborators</dt>
            <dd className="text-foreground">
              {vm.collaborators
                .map(
                  (c) => `${c.name}${c.role ? ` (${formatRole(c.role)})` : ""}`,
                )
                .join(", ")}
            </dd>
          </div>
        )}
      </dl>
    </Section>
  );

  // A seat on a group event is bought, not requested: no path to draw.
  const timelineCard = !isGroup && presentation.timeline.length > 0 && (
    <Section title="Timeline">
      <TimelineStrip events={presentation.timeline} />
    </Section>
  );

  const resourcesCard = (
    <Section title="Resources">
      <ResourceSnapshot
        appointmentId={appointmentId}
        supportsDocuments={supportsDocuments(vm.kind)}
        hrefs={resourceHrefs}
      />
    </Section>
  );

  const helpCard = (
    <Section title="Need help?">
      {/* Renders nothing until a support thread exists for this booking. */}
      <div className="mb-3 empty:hidden [&>*]:mt-0">
        <AppointmentSupportStatusCard
          appointmentId={appointmentId}
          href={supportHref}
        />
      </div>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => openHelp()}
      >
        <LifeBuoy className="mr-1.5 h-4 w-4" />
        Get help
      </Button>
    </Section>
  );

  const manageCard = manageItems.length > 0 && (
    <section
      aria-label="Manage booking"
      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-border px-5 py-4"
    >
      <h2 className="text-sm font-semibold text-foreground">Manage booking</h2>
      <div className="flex flex-wrap items-center gap-2">
        {manageItems.map(renderActionButton)}
      </div>
    </section>
  );

  return (
    <DashboardErrorBoundary>
      <div className={cn("w-full space-y-4", stickyCta && "pb-24 md:pb-0")}>
        <Button variant="ghost" size="sm" className="-ml-2" asChild>
          <Link href={backHref}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            All appointments
          </Link>
        </Button>

        <header className="rounded-2xl border border-border/80 bg-card p-5 sm:p-7">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {KIND_LABEL[vm.kind]}
            </span>
            <StatusBadge {...headerChip} withDot size="sm" />
          </div>
          <h1 className="mt-2 text-xl font-semibold leading-tight tracking-tight text-foreground sm:text-2xl">
            {vm.title}
          </h1>
          <div className="mt-3 flex items-center gap-2.5 text-sm text-muted-foreground">
            <Avatar className="h-7 w-7 shrink-0 border border-border">
              <AvatarImage
                src={vm.counterpart.image ?? undefined}
                alt={vm.counterpart.name}
              />
              <AvatarFallback className="text-[11px] font-medium">
                {initials(vm.counterpart.name) || "?"}
              </AvatarFallback>
            </Avatar>
            {/* The kind is a fact about the booking, so it reads in the
                eyebrow rather than as a second chip beside the status. */}
            <p className="min-w-0">
              with{" "}
              <span className="font-medium text-foreground">
                {vm.counterpart.name}
              </span>
              {vm.meta ? ` · ${vm.meta}` : ""}
              {vm.group && vm.group.total > 0 ? ` · ${groupCountLine}` : ""}
            </p>
          </div>

          {vm.nextAt && (
            <div className="mt-5 flex flex-wrap items-center gap-4 rounded-xl border border-border/80 bg-muted/40 p-4">
              <div
                aria-hidden
                className="flex w-14 shrink-0 flex-col items-center rounded-lg border border-border bg-background py-1.5 leading-none"
              >
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {format(vm.nextAt, "EEE")}
                </span>
                <span className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                  {format(vm.nextAt, "d")}
                </span>
                <span className="mt-1 text-[10px] uppercase text-muted-foreground">
                  {format(vm.nextAt, "MMM")}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {heroCaption}
                </p>
                <p className="mt-0.5 text-base font-semibold text-foreground tabular-nums">
                  {format(vm.nextAt, "h:mm a")}
                  {anchorSession?.endsAt && (
                    <span className="font-normal text-muted-foreground">
                      {" – "}
                      {format(anchorSession.endsAt, "h:mm a")}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CalendarClock aria-hidden className="h-3.5 w-3.5" />
                  {format(vm.nextAt, "EEEE, d MMMM yyyy")}
                </p>
                {theirTime && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {theirTime}
                  </p>
                )}
              </div>
              {vm.bucket !== "past" && vm.bucket !== "cancelled" && (
                <CountdownBadge
                  targetDate={vm.nextAt}
                  sessionEndDate={anchorSession?.endsAt ?? undefined}
                  meetingEnded={
                    anchorSession
                      ? isDeliberateEnd({
                          endedAt: anchorSession.meetingEndedAt,
                          endedReason: anchorSession.meetingEndedReason,
                        })
                      : false
                  }
                />
              )}
              {canJoinNow ? (
                <RowPrimaryAction action={action} size="default" />
              ) : joinNotYet && joinOpensAt ? (
                <div className="flex flex-col items-end gap-1">
                  <Button
                    size="default"
                    disabled
                    aria-describedby="join-opens-at"
                  >
                    <Video className="mr-1.5 h-4 w-4" />
                    Join
                  </Button>
                  <span
                    id="join-opens-at"
                    className="text-[11px] text-muted-foreground"
                  >
                    Opens at {format(joinOpensAt, "h:mm a")}
                  </span>
                </div>
              ) : null}
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            {/* The needs-you callout owns Pay/Join/Approve; this row keeps
                only what it does not (e.g. Set schedule). */}
            {action.kind !== "view" &&
              action.kind !== "join" &&
              nextAction.kind === "NONE" && (
                <RowPrimaryAction action={action} size="default" />
              )}
            {/* With the Sessions card folded away, the one session's rating
                takes the primary slot, under the session row's gates. */}
            {soleSession &&
              soleSessionOver &&
              !sessionFeedback.isError &&
              nextAction.kind !== "RATE" && (
                <SoleSessionRating
                  appointmentId={appointmentId}
                  session={soleSession}
                  role={role}
                  feedback={sessionFeedback}
                />
              )}
            {chatItems.map((item) => (
              <Button
                key={item.key}
                variant="outline"
                size="sm"
                disabled={item.disabled}
                onClick={clickOf(item)}
              >
                <MessageSquare className="mr-1.5 h-4 w-4" />
                {item.label}
              </Button>
            ))}
            {soleSession && scheduleItems.map(renderActionButton)}
            {renderExtraActions?.(vm, { openChat: setChatTarget })}
          </div>

          {soleSession && soleSessionOver && sessionFeedback.isError && (
            <div className="mt-3">
              <RatingsUnavailable onRetry={() => sessionFeedback.retry()} />
            </div>
          )}

          <NeedsYouCallout
            embedded
            presentation={presentation}
            names={names}
            heldCount={heldCount}
            pending={pendingRow}
            onPay={payHref ? openPendingPayment : undefined}
            onExitSeries={
              role === "consultee" && detail.appointment.class && viewerId
                ? () =>
                    exitClassSeries(
                      detail.appointment.class!.id,
                      viewerId,
                    ).then(refreshDetail)
                : undefined
            }
            requestAgainHref={
              vm.consultantProfileId
                ? `/explore/experts/${vm.consultantProfileId}`
                : null
            }
            decision={decision}
            awaitingPayment={
              role === "consultant" && requestPath
                ? {
                    remind: remindMutation.mutateAsync,
                    withdraw: withdrawMutation.mutateAsync,
                    onChanged: refreshDetail,
                  }
                : undefined
            }
            onHelp={() => openHelp()}
          >
            {/* The Next up panel carries Join; without a next session time
                the callout keeps it. */}
            {nextAction.kind === "JOIN" && canJoinNow && !vm.nextAt ? (
              <RowPrimaryAction action={action} size="default" />
            ) : nextAction.kind === "RATE" && rateableSole ? (
              <SoleSessionRating
                appointmentId={appointmentId}
                session={rateableSole}
                role={role}
                feedback={sessionFeedback}
              />
            ) : null}
          </NeedsYouCallout>
        </header>

        <div
          className={cn(
            "grid w-full grid-cols-1 gap-4",
            compactLayout
              ? "md:grid-cols-2 md:items-start"
              : "lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)] lg:items-start",
          )}
        >
          <div
            className={cn(
              "flex min-w-0 flex-col gap-4 empty:hidden",
              compactLayout && "md:col-span-2",
            )}
          >
            {renderNotices?.(vm)}
            {openProposal && (
              <RescheduleProposalCard
                appointmentId={appointmentId}
                proposal={openProposal}
                role={role}
                readOnly={adapter.readOnly}
              />
            )}
            {/* The public review lives on the expert's profile; this card only
                links there, and waits until a session has actually run. */}
            {showReviewCard && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-5 py-4 shadow-sm">
                <div className="flex min-w-0 items-start gap-3">
                  <Star className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      Reviewed this expert?
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Share a public review on {vm.counterpart.name}&apos;s
                      profile.
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <Link
                    href={`/explore/experts/${vm.consultantProfileId}#reviews`}
                  >
                    Write or update your review
                  </Link>
                </Button>
              </div>
            )}
            {sessionsCard}
            {participantsCard}
          </div>

          {compactLayout ? (
            <>
              <div className="flex min-w-0 flex-col gap-4">
                {paymentCard}
                {detailsCard}
                {timelineCard}
              </div>
              <div className="flex min-w-0 flex-col gap-4">
                {resourcesCard}
                {helpCard}
              </div>
            </>
          ) : (
            <aside className="flex min-w-0 flex-col gap-4">
              {paymentCard}
              {detailsCard}
              {resourcesCard}
              {timelineCard}
              {helpCard}
            </aside>
          )}
        </div>

        {manageCard}
      </div>

      {stickyCta && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 backdrop-blur md:hidden [&>*]:w-full">
          {stickyCta}
        </div>
      )}

      {/* Mounted HERE, not by each caller: this component renders the
          actions whose clicks open these dialogs. */}
      {adapter.renderDialogs()}
      {classActions.dialog}
      {returnActions.dialog}
      <LazyAppointmentChatSheet target={chatTarget} onClose={closeChat} />
    </DashboardErrorBoundary>
  );
}

/** #1780 E-5 — the class exit right: a full refund of the remaining sessions. */
async function exitClassSeries(classId: string, userId: string) {
  const res = await fetch(
    `/api/participants/class/${classId}?userId=${encodeURIComponent(userId)}&mode=exit`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not leave the class");
  }
}
