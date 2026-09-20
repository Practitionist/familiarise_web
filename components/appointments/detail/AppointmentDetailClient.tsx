"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarX,
  CreditCard,
  ExternalLink,
  FileText,
  LifeBuoy,
  Users,
  Video,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/dashboard/DataCard";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { throwSupportError } from "@/lib/support/error-copy";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
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
import { trialCheckoutHref } from "@/lib/appointments/trial-checkout-href";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import {
  paymentStatusBadge,
  paymentStatusDot,
  recordingStatusBadge,
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
  isSponsoredPayment,
  paymentRailLabel,
  receiptHref,
  type PaymentDisplayLike,
} from "@/lib/appointments/payment-display";
import {
  paymentDisplayStatus,
  seatPaymentsByUser,
  summarizeSeatPayments,
} from "@/lib/appointments/seat-payments";
import {
  getOccurrenceVMJoinState,
  isDeadOccurrence,
  isOccurrenceOver,
} from "@/lib/appointments/occurrences";
import { NeedsYouCallout } from "./NeedsYouCallout";
import { TimelineStrip } from "./TimelineStrip";
import { CountdownBadge } from "../CountdownBadge";
import { KIND_LABEL } from "../AppointmentRow";
import { RowPrimaryAction } from "../RowPrimaryAction";
import { SessionTimeline } from "../SessionTimeline";
import { RescheduleProposalCard } from "./RescheduleProposalCard";
import { SupportThreadSheet } from "@/components/support/SupportThreadSheet";
import { AppointmentSupportStatusCard } from "@/components/support/AppointmentSupportStatusCard";
import { SessionRatingRow } from "@/components/reviews/SessionRatingRow";
import { useSessionFeedback } from "@/hooks/useSessionFeedback";

const PARTICIPANTS_PREVIEW = 5;

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function ResourceSubgroup({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof FileText;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        {title}
      </p>
      {children}
    </div>
  );
}

type MoneyRow = PaymentDisplayLike & {
  amount: number | string;
  currency: string | null;
  createdAt: string | Date;
};

/** One line per charge: amount, status, the rail it rode, the date — and the receipt. */
function MoneyLine({ payment }: { payment: MoneyRow }) {
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
  /** Role-specific documents block (consultee upload widget / consultant list). */
  renderDocuments?: (vm: AppointmentVM) => ReactNode;
  /** Consultant-only: participants management link resolver. */
  participantsHref?: (detail: TAppointmentDetail) => string | null;
  joinWindowMs?: number;
  /** Consultant-only: the dashboard whose Requests/allocate pages answer a request. */
  consultantId?: string;
}

export function AppointmentDetailClient({
  appointmentId,
  role,
  adapter,
  backHref,
  renderDocuments,
  participantsHref,
  joinWindowMs,
  consultantId,
}: AppointmentDetailClientProps) {
  const { data: session } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
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

  const mapped = detail ? mapAppointmentDetail(detail, role) : null;
  // #1540 — which calls of this booking the viewer has already rated, in ONE
  // request; #1554 made the booking one Appointment, so that is one row.
  const sessionFeedback = useSessionFeedback(appointmentId);
  useSetBreadcrumbLabel(mapped?.vm.title);

  const payments = detail?.appointment.payment ?? [];
  // One support sheet, two doors: "Get help" opens on the intent chips,
  // "Problem with this charge" opens already on PAYMENT_STATUS.
  const [help, setHelp] = useState<{ open: boolean; seed?: string }>({
    open: false,
  });

  if (isLoading && !detail) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
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

  const { vm, recordings } = mapped;
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
  // #1675 — a destructive overflow item (Withdraw/Cancel) no longer sits at
  // the front of the action bar next to Approve/Pay; it renders last, past
  // "Get help", where the row's other destructive secondary actions live.
  const overflowPrimary = overflow.filter((item) => !item.destructive);
  const overflowSecondary = overflow.filter((item) => item.destructive);
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
  // A single-sitting booking's one confirmed session is already the header's
  // date line; the Sessions card stays only while it carries something the
  // header cannot — a held row awaiting payment, or an open proposal.
  const soleSession =
    isSingleSessionKind(vm.kind) &&
    vm.occurrences.length === 1 &&
    !vm.occurrences[0].isTentative &&
    !openProposal
      ? vm.occurrences[0]
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
    ? vm.occurrences.find((s) => s.startsAt.getTime() === vm.nextAt?.getTime())
    : undefined;
  const hasConfirmedSessions = vm.occurrences.some((s) => !s.isTentative);
  const hasTentativeSessions = vm.occurrences.some((s) => s.isTentative);
  // #1429 F2 — a trial's Pay Now lands on our branded trial checkout, which
  // names the amount and the hold deadline; only a non-trial booking falls
  // through to the raw gateway link. #1428 added a second Pay Now here without
  // the branch, so both entry points now ask the one shared helper.
  const trialHref = trialCheckoutHref(vm);
  const openPendingPayment = () => {
    if (trialHref) {
      // Internal checkout page — SPA navigation (was full reload).
      router.push(trialHref);
      return;
    }
    if (vm.pendingPaymentUrl && /^https?:\/\//.test(vm.pendingPaymentUrl)) {
      window.open(vm.pendingPaymentUrl, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <DashboardErrorBoundary>
      <div className="w-full space-y-4">
        <Button variant="ghost" size="sm" className="-ml-2" asChild>
          <Link href={backHref}>
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            All appointments
          </Link>
        </Button>

        {/* Header card */}
        <div className="rounded-2xl border border-border bg-card shadow-sm p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-start gap-4">
            <Avatar className="h-14 w-14 border border-border shrink-0">
              <AvatarImage
                src={vm.counterpart.image ?? undefined}
                alt={vm.counterpart.name}
              />
              <AvatarFallback className="text-base font-medium">
                {initials(vm.counterpart.name) || "?"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold text-foreground">
                  {vm.title}
                </h1>
                <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {KIND_LABEL[vm.kind]}
                </span>
                <StatusBadge
                  {...toneBadge(bookingState.tone, bookingState.label)}
                  withDot
                  size="sm"
                />
                {sponsoredBy && (
                  <span className="rounded bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 px-1.5 py-px text-[10px] font-medium">
                    Sponsored · {sponsoredBy}
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                with {vm.counterpart.name}
                {vm.meta ? ` · ${vm.meta}` : ""}
                {vm.group && vm.group.total > 0 ? ` · ${groupCountLine}` : ""}
              </p>
              {vm.nextAt && (
                <div className="flex flex-wrap items-center gap-2 mt-2 text-sm">
                  <span className="font-medium text-foreground tabular-nums">
                    {format(vm.nextAt, "EEE, d MMM yyyy · h:mm a")}
                    {anchorSession?.endsAt && (
                      <span className="text-muted-foreground font-normal">
                        {" – "}
                        {format(anchorSession.endsAt, "h:mm a")}
                      </span>
                    )}
                  </span>
                  {vm.bucket !== "past" && vm.bucket !== "cancelled" && (
                    <CountdownBadge
                      targetDate={vm.nextAt}
                      sessionEndDate={anchorSession?.endsAt ?? undefined}
                    />
                  )}
                </div>
              )}
              {vm.collaborators.length > 0 && (
                <p className="text-xs text-muted-foreground mt-2">
                  Collaborators:{" "}
                  {vm.collaborators
                    .map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}`)
                    .join(", ")}
                </p>
              )}
            </div>
          </div>

          {/* Actions — full-width bar so buttons aren't cramped beside the title.
              Always rendered: "Get help" is available on every appointment. */}
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {/* #1675 — the needs-you callout owns Pay/Join/Approve; the bar
                keeps only what it does not (Set schedule). */}
            {action.kind !== "view" && nextAction.kind === "NONE" && (
              <RowPrimaryAction action={action} size="default" />
            )}
            {/* #705 — with the Sessions card folded away, the rating of the
                one session that happened takes the primary slot. Same gates
                as the session row: attended (or nobody could have recorded
                it), never on a dead or still-running call. */}
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
            {overflowPrimary.map((item) => (
              <Button
                key={item.key}
                variant="outline"
                size="sm"
                disabled={item.disabled}
                onClick={item.onClick}
              >
                {item.label}
              </Button>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setHelp({ open: true })}
            >
              <LifeBuoy className="mr-1.5 h-4 w-4" />
              Get help
            </Button>
            {overflowSecondary.map((item) => (
              <Button
                key={item.key}
                variant="outline"
                size="sm"
                disabled={item.disabled}
                onClick={item.onClick}
                className="text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-900/40 dark:hover:bg-red-900/20"
              >
                {item.label}
              </Button>
            ))}
          </div>

          {soleSession && soleSessionOver && sessionFeedback.isError && (
            <div className="mt-3">
              <RatingsUnavailable onRetry={() => sessionFeedback.retry()} />
            </div>
          )}

          {/* #support-hub — the live support conversation for THIS appointment:
              status + latest exchange inline; nothing renders until a thread
              exists. */}
          <AppointmentSupportStatusCard
            appointmentId={appointmentId}
            isOrgContext={!!orgName}
          />

          {vm.group && vm.group.total > 0 && postApproval && (
            <div className="mt-4 pt-4 border-t border-border">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                <span>Program progress</span>
                <span className="font-medium text-foreground">
                  {vm.group.completed} of {vm.group.total} sessions
                </span>
              </div>
              <Progress
                value={
                  // A group whose sessions have no slots yet has total 0,
                  // and 0/0 is NaN — which reaches Progress as an
                  // attribute value and renders a broken bar.
                  vm.group.total > 0
                    ? (vm.group.completed / vm.group.total) * 100
                    : 0
                }
                className="h-2"
              />
            </div>
          )}
        </div>

        <NeedsYouCallout
          presentation={presentation}
          names={names}
          heldCount={heldCount}
          pending={pendingRow}
          onPay={openPendingPayment}
          requestAgainHref={
            vm.consultantProfileId
              ? `/explore/experts/${vm.consultantProfileId}`
              : null
          }
          decision={decision}
          onHelp={() => setHelp({ open: true })}
        >
          {nextAction.kind === "JOIN" && action.kind === "join" ? (
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

        {/* A seat on a group event is bought, not requested: no path to draw. */}
        {!isGroup && <TimelineStrip events={presentation.timeline} />}

        {openProposal && (
          <RescheduleProposalCard
            appointmentId={appointmentId}
            proposal={openProposal}
            role={role}
          />
        )}

        <div className="grid w-full grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            {/* #705 — attendees only. The API authorizes any participant, so
                this used to offer a consultant a star rating on their own
                session, which then fed the org quality average.
                The per-call rating now lives on each session row below; only
                the public review is a card of its own, so the page no longer
                asks the same-looking question twice.

                #1300 — the public review has MOVED to the expert's profile,
                which is where it lives and where you read the others. Keeping a
                composer here as well is how the same five-star widget ended up
                on screen twice: a private per-call rating on each session row
                and a public review card above them, neither anchored to what
                the user thought they were rating. What stays here is a link. */}
            {/* #1300/#1542/#1675 — asking before a session has actually run
                invites a review of a call that never happened; the prompt
                waits for the derived state or a completed occurrence. */}
            {role === "consultee" &&
              vm.consultantProfileId &&
              (bookingState.state === "COMPLETED" ||
                detail.appointment.occurrences.some(
                  (o) => o.completionStatus === "COMPLETED",
                )) && (
                <p className="text-sm text-muted-foreground">
                  Reviewed this expert?{" "}
                  <Link
                    href={`/explore/experts/${vm.consultantProfileId}#reviews`}
                    className="font-medium text-foreground underline underline-offset-4"
                  >
                    Write or update your review on their profile
                  </Link>
                  .
                </p>
              )}
            {!soleSession && (
              <Section
                title={
                  heldCount > 0 && !postApproval
                    ? `Sessions · ${heldCount} held`
                    : "Sessions"
                }
              >
                {/* Without this the stars below simply disappeared (or showed
                  empty) on a call the viewer had already rated, which reads as
                  "your rating never happened". */}
                {sessionFeedback.isError ? (
                  <div className="mb-3">
                    <RatingsUnavailable
                      onRetry={() => sessionFeedback.retry()}
                    />
                  </div>
                ) : null}
                {hasConfirmedSessions || hasTentativeSessions ? (
                  <SessionTimeline
                    // #705 — the private per-call rating sits on the session it
                    // rates. Attendees only: the API authorizes any participant,
                    // and a consultant rating their own session would feed the
                    // org quality average.
                    renderSessionExtra={(session) => {
                      const rating =
                        sessionFeedback.ratings[session.occurrenceId] ?? null;
                      // Offer stars only where a rating would be ACCEPTED —
                      // you attended, or nobody could have recorded it. Showing
                      // them on a call the viewer never joined invited a click
                      // that the route then refused.
                      const canRate = sessionFeedback.rateable.has(
                        session.occurrenceId,
                      );
                      // While the read is failing, `rateable` is empty and
                      // `rating` is null for every row — indistinguishable from
                      // the truth. Show nothing per row and let the notice above
                      // say why, rather than inviting a click we cannot honour.
                      if (sessionFeedback.isError) return null;
                      if (role === "consultee" && !canRate && rating === null) {
                        return null;
                      }
                      return (
                        <SessionRatingRow
                          appointmentId={session.appointmentId ?? appointmentId}
                          bookingAppointmentId={appointmentId}
                          occurrenceId={session.occurrenceId}
                          existingRating={rating}
                          // The consultant sees what a call scored; only the
                          // attendee can set it.
                          readOnly={role !== "consultee" || !canRate}
                        />
                      );
                    }}
                    occurrences={vm.occurrences}
                    joinWindowMs={joinWindowMs}
                    defaultExpanded
                    isJoining={action.kind === "join" && !!action.busy}
                    onJoinSession={
                      action.kind === "join" && action.onClick
                        ? () => action.onClick!()
                        : undefined
                    }
                    showHeld
                    // #1675 — schedule words only; the pay verb is in the
                    // needs-you slot above.
                    heldRowLabel={presentation.sessionRowLabel}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No sessions scheduled yet.
                  </p>
                )}
              </Section>
            )}

            {role === "consultant" && (
              <Section title="Participants">
                {participants.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No participants on this session yet.
                  </p>
                ) : (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {previewParticipants.map((u) => {
                      const seat = isGroup ? seatPayments.get(u.id) : undefined;
                      const seatStatus = seat
                        ? paymentDisplayStatus(seat)
                        : null;
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
                            <AvatarImage
                              src={u.image ?? undefined}
                              alt={u.name}
                            />
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
                {manageHref && (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={manageHref}>
                      <Users className="mr-1.5 h-3.5 w-3.5" />
                      Manage participants
                    </Link>
                  </Button>
                )}
              </Section>
            )}
            <Section title={showSeatSummary ? "Payments" : "Payment"}>
              {showSeatSummary ? (
                payments.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No seat has been paid for yet.
                  </p>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                    <span className="font-medium text-foreground tabular-nums">
                      {seatSummary.paid} of {participants.length} seat
                      {participants.length === 1 ? "" : "s"} paid
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span className="tabular-nums text-foreground">
                      {formatCurrencyAmount(
                        seatSummary.collectedPaise,
                        seatSummary.currency,
                      )}{" "}
                      collected
                    </span>
                    {seatSummary.pending > 0 && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">
                          {seatSummary.pending} awaiting payment
                        </span>
                      </>
                    )}
                    {seatSummary.lapsed > 0 && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">
                          {seatSummary.lapsed} lapsed
                        </span>
                      </>
                    )}
                    {seatSummary.refunded > 0 && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">
                          {seatSummary.refunded} refunded
                        </span>
                      </>
                    )}
                    {seatSummary.otherCurrency > 0 && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">
                          {seatSummary.otherCurrency} in another currency
                        </span>
                      </>
                    )}
                  </div>
                )
              ) : (
                <div className="space-y-2">
                  {/* #1675 — money is ONE line (locked 2026-09-13): the
                      derived state's words, the receipt, the money door. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="text-foreground">{moneyState.line}</span>
                    {paidRow && receiptHref(paidRow) && (
                      <a
                        href={receiptHref(paidRow)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-foreground underline underline-offset-4"
                      >
                        View receipt
                      </a>
                    )}
                    {role === "consultee" && (
                      <button
                        type="button"
                        className="text-xs font-medium text-foreground underline underline-offset-4"
                        onClick={() =>
                          setHelp({ open: true, seed: "PAYMENT_STATUS" })
                        }
                      >
                        {hasOwnCharge
                          ? "Problem with this charge"
                          : "Problem with this booking"}
                      </button>
                    )}
                  </div>
                  {moneyState.detail && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {moneyState.detail}
                    </p>
                  )}
                  {/* A CHARGE_MEMBER co-pay the viewer paid themselves keeps
                      its own line with its receipt (#775). */}
                  {payments
                    .flatMap((p) => p.childPayments)
                    .filter((c) => c.userId === viewerId)
                    .map((c) => (
                      <MoneyLine key={c.id} payment={c} />
                    ))}
                </div>
              )}
            </Section>
          </div>

          <aside className="min-w-0 lg:sticky lg:top-20">
            <Section title="Resources">
              <div className="space-y-5">
                {supportsDocuments(vm.kind) && (
                  <>
                    <ResourceSubgroup title="Documents" icon={FileText}>
                      {renderDocuments ? (
                        renderDocuments(vm)
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Documents for this booking will appear here.
                        </p>
                      )}
                    </ResourceSubgroup>

                    <div className="border-t border-border" />
                  </>
                )}

                <ResourceSubgroup title="Recordings" icon={Video}>
                  {recordings.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Recordings of completed sessions will appear here.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {recordings.map((rec) => (
                        <div
                          key={rec.id}
                          className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {rec.title}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {format(rec.recordedAt, "d MMM yyyy")} ·{" "}
                              {rec.durationInMinutes} min
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <StatusBadge
                              {...recordingStatusBadge(rec.status)}
                              size="sm"
                            />
                            {rec.url && (
                              <Button variant="outline" size="sm" asChild>
                                <a
                                  href={rec.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  Watch
                                  <ExternalLink className="ml-1 h-3 w-3" />
                                </a>
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </ResourceSubgroup>
              </div>
            </Section>
          </aside>
        </div>
      </div>

      {/* Mounted HERE, not by each caller. This component renders the overflow
          menu whose every item opens one of these dialogs, so making the host
          remember to mount them separately is a contract that gets forgotten —
          and was: the consultee's detail page never did, leaving Reschedule,
          Cancel and Report issue setting state nothing was listening for. */}
      {adapter.renderDialogs()}
      <SupportThreadSheet
        appointmentId={appointmentId}
        isOrgContext={!!orgName}
        open={help.open}
        onOpenChange={(open) => setHelp(open ? { ...help, open } : { open })}
        seedCategory={help.seed}
      />
    </DashboardErrorBoundary>
  );
}
