import * as Sentry from "@sentry/nextjs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { toast } from "@/components/ui/use-toast";
import { AppointmentsType, AppointmentStatus } from "@prisma/client";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  RequestedSlotsDialog,
  type RequestedSlotsConfirmation,
} from "./components/RequestedSlotsDialog";
import { PaymentRequiredBadge } from "./components/PaymentRequiredBadge";
import {
  ConsultationApiResponse,
  ListMeta,
  RequestedBy,
  RescheduleProposalInfo,
  SubscriptionApiResponse,
} from "./types";
import { REQUEST_LIST_DEFAULT_LIMIT } from "@/lib/booking/list-query";
import { createAvailabilityPoller } from "@/lib/scheduling/availabilityPolling";
import {
  REQUESTS_COUNT_POLL_INTERVAL_MS,
  requestsFreshnessBadge,
} from "@/lib/scheduling/requestsFreshness";
import { countSundayWeeksInclusive } from "@/lib/scheduling/calendarUtils";
import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";
import {
  allocatedElsewhere,
  allocationFailed,
  allocationFailedWithCode,
  planConfigIncomplete,
  requestChangedElsewhere,
  timesConfirmed,
} from "@/lib/scheduling/allocationMessages";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import {
  formatInViewerZone,
  zoneLabel,
  type ViewerZone,
} from "@/lib/time/viewer-zone";
import { getRequestTypeLabel } from "./labels";
import type { AllocationAttemptKey } from "@/hooks/scheduling/useScheduling";
// #1675 — the approve/decline mutations are shared with the appointment
// detail page's needs-you slot; the guards and the calls live in one module.
import {
  approveRequestedTimes,
  classifyRequestedConflict,
  declineRequest,
} from "./request-decision";
import { cn } from "@/utils/tailwind";

// Slot with tentative status for reschedule visibility. completionStatus
// separates a fresh hold (tentative + SCHEDULED) from a reschedule release
// (tentative + RESCHEDULED) — only the latter is "needing a new time".
interface RequestedSlot {
  startsAt: string;
  isTentative: boolean;
  completionStatus?: string | null;
}

interface Request {
  id: string;
  type: AppointmentsType;
  title: string;
  requestedBy: RequestedBy;
  requestedAt: string;
  requestedTimes?: string[]; // Kept for backward compatibility
  requestedSlots?: RequestedSlot[]; // New: includes isTentative flag
  status: AppointmentStatus;
  /** undefined = plan data is incomplete (no totalSessions AND no scheduling
   * period) — the server would reject any allocation, so actions are disabled. */
  requiredSlots?: number;
  allocatedSlots?: string[];
  durationInMonths?: number;
  sessionsPerWeek?: number;
  sessionDurationInHours?: number;
  durationInHours?: number;
  startDate?: Date;
  endDate?: Date;
  /** Limit day/week bucket timezone (ADR B9); Subscription column default. */
  schedulingTimezone?: string;
  bookingSource?: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED"; // Booking source - direct checkout or request submitted
  totalSessions?: number; // Authoritative session count from plan (overrides weeks × sessionsPerWeek)
  // Reschedule info
  tentativeSlotCount?: number;
  totalSlotCount?: number;
  /** Slots released by a reschedule. Their startsAt is still the ORIGINAL time,
   * so "Use Requested Times" would re-confirm what the consultee asked to move. */
  rescheduledSlotCount?: number;
  /** The times the consultee asked for, when they named any. */
  proposal?: RescheduleProposalInfo;
  /** Which appointment carries `proposal` — the respond endpoint is keyed by
   * appointment, and a subscription's proposal sits on ONE child. #1163 */
  proposalAppointmentId?: string;
  /** What the consultee said when booking. */
  requestNotes?: string | null;
}

// interface SlotInterval { ... } // Removed - Now imported

type RequestType = "all" | "consultation" | "subscription";
type PagedKind = Exclude<RequestType, "all">;
const PAGED_KINDS: readonly PagedKind[] = ["consultation", "subscription"];

interface RequestSchedulingTabProps {
  type: RequestType;
  onUpdate: () => void;
  /**
   * Whose requests to allocate. Falls back to the `[consultantId]` route param
   * so the consultant tree keeps working untouched; the org tree has no such
   * param and passes it explicitly.
   */
  consultantProfileId?: string;
  /**
   * Funding context, forwarded as `?orgScope=`.
   *
   * `/api/bookings/{consultations,subscriptions}` EXCLUDE org-funded rows when
   * this is absent, so omitting it is how org-sponsored requests became
   * invisible: the only allocation surface in the product sat in the consultant
   * tree and silently dropped them, and an org-sponsored subscription was paid
   * for and never scheduled. Personal keeps the B2C-only behaviour; an org id
   * narrows to that organization.
   */
  orgScope?: "personal" | (string & {});
}

/**
 * The times currently on offer.
 *
 * A countered request carries the consultee's round-1 times AND the
 * consultant's round-2 counter. Showing both under one heading would read as a
 * single, contradictory list — only the latest round is an open offer.
 */
function currentRoundSlots(proposal: RescheduleProposalInfo) {
  return proposal.proposedTimes.filter((slot) => slot.round === proposal.round);
}

/**
 * The live reschedule proposal on an appointment, if the consultee named times.
 *
 * The list select already narrows to open statuses and takes one, so this is
 * just "the first, if any" — but it keeps the two mapping branches honest about
 * the fact that only one proposal can be live per appointment.
 */
function proposalOf(
  appointment: { rescheduleRequests?: RescheduleProposalInfo[] } | undefined,
): RescheduleProposalInfo | undefined {
  return appointment?.rescheduleRequests?.[0];
}

/**
 * The proposal "Use Requested Times" can honestly answer via the respond
 * endpoint: open, consultee-initiated, naming concrete times (#1163).
 *
 * COUNTERED stays null — the consultant already answered with a counter and
 * the ball is with the consultee. So does a preference-only request: with no
 * named times there is nothing to accept, only the allocate page.
 */
function answerableProposal(request: Request): RescheduleProposalInfo | null {
  const proposal = request.proposal;
  if (
    !proposal ||
    proposal.status !== "PENDING_REVIEW" ||
    proposal.initiatorRole !== "CONSULTEE" ||
    !request.proposalAppointmentId ||
    currentRoundSlots(proposal).length === 0
  ) {
    return null;
  }
  return proposal;
}

// Helper function to fetch and process data. `meta` is the server's page
// envelope; the tab used to discard it and so could never page (#1704).
async function fetchDataFromApi<T>(url: string): Promise<{
  ok: boolean;
  data: T | null;
  meta?: ListMeta;
  error?: string;
  /** The server's structured code, when the body carried one. #1705 */
  code?: string;
}> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to fetch ${url}:`, errorText);
      return {
        ok: false,
        data: null,
        // Keep server errors somewhat specific
        error: `Server error (${response.status}) while fetching data.`,
        code: readErrorCode(errorText),
      };
    }
    const data = await response.json();
    // Ensure data exists and has the expected structure
    if (data && data.data !== undefined) {
      return {
        ok: true,
        data: data.data as T,
        meta: data.meta,
        error: undefined,
      };
    } else {
      console.error(`Unexpected response structure from ${url}:`, data);
      return {
        ok: false,
        data: null,
        error: "Received unexpected data structure from server.",
      };
    }
  } catch (err) {
    let message = "An unknown error occurred while fetching data.";
    // Specifically check for the browser's network error
    if (err instanceof TypeError && err.message === "Failed to fetch") {
      // Use warn (not error) — this is a transient network hiccup, not a code bug
      console.warn(
        `Network error fetching ${url}: server temporarily unreachable`,
      );
      message =
        "Network error: Could not connect to the server. Please check your internet connection.";
    } else if (err instanceof Error) {
      console.error(`Error fetching ${url}:`, err);
      message = err.message;
    }
    return { ok: false, data: null, error: message };
  }
}

/** `code` off an error body, if the body was JSON and carried one. */
const ErrorBodySchema = z.object({ code: z.string() });
function readErrorCode(body: string): string | undefined {
  try {
    const parsed = ErrorBodySchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.code : undefined;
  } catch {
    // Not JSON — an edge/HTML error page.
    return undefined;
  }
}

/** One line, one time, always with its zone: the consultee who asked for
 * these times is often in another one (#1705). */
function formatDateTime(value: string | Date, viewer: ViewerZone): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return `${formatInViewerZone(date, viewer.zone, "d MMM yyyy, h:mm a")} ${zoneLabel(date, viewer.zone)}`;
}

/** Beyond this the list stops being scannable and starts being a wall. */
const MAX_VISIBLE_SLOTS = 3;

/**
 * The consultee's note, clamped to 3 lines with an expand toggle underneath.
 *
 * The toggle appears only when the clamp is actually cutting text off — a
 * permanent "Read more" under a two-line note is noise nobody asked for. And
 * the overflow is measured rather than guessed from a character count: this
 * column is `max-w-[26rem]` but flexes narrower, so the same string clips at
 * one width and not another.
 *
 * `components/ui/collapsible` is the wrong primitive here — it hides its
 * content outright, and the point of this cell is that three lines stay
 * readable while collapsed. Same chevron-and-"Show less" shape as the other
 * in-place expanders (`SessionTimeline`, `FacetGroup`).
 */
function RequestNote({ notes }: Readonly<{ notes: string }>) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isClamped, setIsClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = textRef.current;
    // Measured only while COLLAPSED. Expanding drops the clamp, so an expanded
    // paragraph always reports scrollHeight === clientHeight; re-measuring
    // then would decide it no longer overflows and remove the only control
    // that collapses it again.
    if (!el || expanded) return;

    // +1 absorbs the subpixel rounding between scrollHeight and clientHeight
    // that would otherwise flag an exactly-3-line note as clipped.
    const measure = () => setIsClamped(el.scrollHeight > el.clientHeight + 1);
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [notes, expanded]);

  return (
    <div className="max-w-[26rem] text-left">
      <p
        ref={textRef}
        className={cn(
          "text-xs italic text-muted-foreground",
          !expanded && "line-clamp-3",
        )}
      >
        &ldquo;{notes}&rdquo;
      </p>
      {isClamped && (
        <button
          type="button"
          aria-expanded={expanded}
          className="mt-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((prev) => !prev)}
        >
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              expanded && "rotate-180",
            )}
          />
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}

/**
 * The live offer: who wants what, and until when.
 *
 * Given its own bordered block with an accent rail because it is the one thing
 * on the row that has to be read before any button is pressed — everything
 * else is context for it.
 */
/**
 * "weekday mornings", "mornings", "weekends" — whichever halves were stated.
 *
 * Returns null when neither was, so the caller can treat "no preference" and
 * "no proposal" the same way.
 */
function preferenceSummary(proposal: RescheduleProposalInfo): string | null {
  const days =
    proposal.preferredDays === "WEEKDAYS"
      ? "weekday"
      : proposal.preferredDays === "WEEKENDS"
        ? "weekend"
        : null;
  const timeOfDay =
    proposal.preferredTimeOfDay === "MORNING"
      ? "mornings"
      : proposal.preferredTimeOfDay === "AFTERNOON"
        ? "afternoons"
        : proposal.preferredTimeOfDay === "EVENING"
          ? "evenings"
          : null;

  if (days && timeOfDay) return `${days} ${timeOfDay}`;
  if (timeOfDay) return timeOfDay;
  // No band to pluralise against, so the day half has to stand on its own.
  if (days) return `${days}s`;
  return null;
}

function ProposalBlock({
  proposal,
  viewer,
}: {
  proposal: RescheduleProposalInfo;
  viewer: ViewerZone;
}) {
  const slots = currentRoundSlots(proposal);
  const preference = preferenceSummary(proposal);
  // A preference-only request names no times but is still the whole reason this
  // booking is back in the queue, so it has to render on its own (#1065).
  if (slots.length === 0 && !preference) return null;

  return (
    <div className="rounded-md border border-l-2 border-border/70 border-l-primary bg-muted/40 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <CalendarClock className="h-3 w-3" />
          {slots.length === 0
            ? "Any time works"
            : proposal.initiatorRole === "CONSULTEE"
              ? "Consultee asked for"
              : "You proposed"}
        </span>
        {proposal.round > 1 && (
          <Badge
            variant="outline"
            className="border-border px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide"
          >
            Counter-offer
          </Badge>
        )}
      </div>
      {slots.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {slots.map((slot) => (
            <li
              key={slot.startsAt}
              className="text-sm font-medium tabular-nums text-foreground lg:whitespace-nowrap"
            >
              {formatDateTime(slot.startsAt, viewer)}
            </li>
          ))}
        </ul>
      )}
      {preference && (
        <p className="mt-1 text-sm font-medium text-foreground">
          Ideally {preference}
        </p>
      )}
      {proposal.reason && (
        <p className="mt-1 line-clamp-2 text-xs italic text-muted-foreground">
          &ldquo;{proposal.reason}&rdquo;
        </p>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground lg:whitespace-nowrap">
        Expires {formatDateTime(proposal.expiresAt, viewer)}
      </p>
    </div>
  );
}

/**
 * Whether this is a whole-booking reschedule or a single session moving.
 *
 * Lives beside the title rather than in the times column: it describes the
 * request, not any one time, and stacking it above the times was what made
 * that column three blocks tall.
 */
/**
 * Slots are 30-minute atoms (ADR B1); a session is however many of them the
 * plan's duration needs. Reporting the raw count called a one-hour
 * consultation "2 sessions".
 */
function sessionsFromSlots(request: Request, slotCount: number): number {
  const hours =
    request.type === AppointmentsType.CONSULTATION
      ? request.durationInHours
      : request.sessionDurationInHours;
  const perSession = Math.max(1, Math.round((hours ?? 0.5) / 0.5));
  return Math.max(1, Math.round(slotCount / perSession));
}

/** "just now" / "4m ago" / a time — enough to judge whether to hit Refresh. */
function formatRelativeTime(at: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - at.getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * "Showing 1–10 of 12 consultations" with Prev/Next. One per list, because
 * the two lists page independently on the server and a single combined
 * pager would have to lie about one of them (#1704).
 */
function ListPager({
  label,
  meta,
  page,
  disabled,
  onPage,
}: Readonly<{
  label: string;
  meta: ListMeta;
  page: number;
  disabled: boolean;
  onPage: (page: number) => void;
}>) {
  if (meta.total === 0) return null;
  const start = (page - 1) * meta.limit + 1;
  const end = Math.min(meta.total, page * meta.limit);
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span aria-live="polite">
        Showing {start}&ndash;{end} of {meta.total} {label}
      </span>
      {meta.totalPages > 1 && (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || page <= 1}
            onClick={() => onPage(page - 1)}
            aria-label={`Previous page of ${label}`}
          >
            Prev
          </Button>
          <span className="tabular-nums">
            {page} / {meta.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || page >= meta.totalPages}
            onClick={() => onPage(page + 1)}
            aria-label={`Next page of ${label}`}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function RescheduleBadge({ request }: { request: Request }) {
  // Only actual reschedule releases badge. A fresh REQUEST_SUBMITTED hold is
  // tentative too, but those times ARE the request — badging them "Full
  // reschedule" sent consultants hunting for a reschedule that never happened
  // (E2E on preview #1682).
  const rescheduledSlots = request.rescheduledSlotCount ?? 0;
  const totalSlots = request.totalSlotCount;
  if (rescheduledSlots === 0 || totalSlots === undefined) return null;

  const moved = sessionsFromSlots(request, rescheduledSlots);
  const total = sessionsFromSlots(request, totalSlots);

  if (rescheduledSlots === totalSlots) {
    return (
      <Badge
        variant="secondary"
        className="gap-1 px-1.5 py-0.5 text-[11px] font-medium"
      >
        <RefreshCw className="h-3 w-3" />
        Full reschedule &middot; {total} session{total !== 1 ? "s" : ""}
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="gap-1 border-amber-500/40 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
    >
      <AlertTriangle className="h-3 w-3" />
      {moved} of {total} need{moved === 1 ? "s" : ""} a new time
    </Badge>
  );
}

/**
 * The times already on the appointment.
 *
 * With a live proposal these are what the consultee is moving away from, so
 * they read as the quiet "from" half under the offer; without one they are the
 * request itself. Tentative slots sort first because in a partial reschedule
 * they are the only ones needing a decision, and the truncation used to hide
 * them behind a dozen untouched sessions.
 */
function StoredTimes({
  request,
  viewer,
}: {
  request: Request;
  viewer: ViewerZone;
}) {
  const slots =
    request.requestedSlots && request.requestedSlots.length > 0
      ? request.requestedSlots
      : request.requestedTimes?.map((startsAt) => ({
          startsAt,
          isTentative: false,
          completionStatus: null,
        }));

  if (slots && slots.length > 0) {
    const ordered = [...slots].sort(
      (a, b) => Number(b.isTentative) - Number(a.isTentative),
    );
    const hidden = ordered.length - MAX_VISIBLE_SLOTS;

    return (
      <div className="space-y-0.5">
        {request.proposal && (
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Currently
          </p>
        )}
        {ordered.slice(0, MAX_VISIBLE_SLOTS).map((slot, index) => (
          <div
            key={`${request.id}-slot-${index}`}
            className={cn(
              "flex items-center gap-1.5 text-xs tabular-nums lg:whitespace-nowrap",
              // Amber is reserved for released reschedules: a fresh hold is
              // tentative too, but those times ARE the request.
              isReleasedForReschedule(slot)
                ? "text-amber-600"
                : "text-muted-foreground",
            )}
          >
            {isReleasedForReschedule(slot) ? (
              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
            ) : (
              <CheckCircle2 className="h-3 w-3 flex-shrink-0 text-emerald-600/70" />
            )}
            <span>{formatDateTime(slot.startsAt, viewer)}</span>
            {isReleasedForReschedule(slot) && (
              <span className="sr-only">(needs rescheduling)</span>
            )}
          </div>
        ))}
        {hidden > 0 && (
          <p className="pl-[18px] text-[11px] text-muted-foreground">
            +{hidden} more slot{hidden !== 1 ? "s" : ""}
          </p>
        )}
      </div>
    );
  }

  if (
    request.type === AppointmentsType.SUBSCRIPTION &&
    request.startDate &&
    request.endDate
  ) {
    return (
      <div className="text-xs">
        <p className="font-medium text-foreground">Scheduling period</p>
        <p className="text-muted-foreground lg:whitespace-nowrap">
          {formatInViewerZone(request.startDate, viewer.zone, "d MMM yyyy")}{" "}
          &ndash;{" "}
          {formatInViewerZone(request.endDate, viewer.zone, "d MMM yyyy")}
        </p>
      </div>
    );
  }

  return <p className="text-xs text-muted-foreground">Not available</p>;
}

/** 44 px on the phone cards (WCAG 2.5.5), the compact table height from lg. */
const TOUCH_TARGET = "min-h-11 lg:min-h-8";

export function RequestSchedulingTab({
  type,
  onUpdate,
  consultantProfileId,
  orgScope = "personal",
}: RequestSchedulingTabProps) {
  const params = useParams();
  const routeConsultantId = params.consultantId as string | undefined;
  // The allocate page lives in the consultant tree behind a personal-profile
  // check, and this id passes it on both mount points: the consultant route
  // supplies its own, and the org route supplies the VIEWER's own consultant
  // profile (allocation is a delivery act — only the deliverer allocates).
  const consultantId = consultantProfileId ?? (routeConsultantId as string);
  const viewer = useViewerZone();
  const allocateHrefFor = (request: Pick<Request, "id" | "type">) =>
    `/dashboard/consultant/${consultantId}/requests/${request.id}/allocate?type=${request.type.toLowerCase()}`;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; code?: string } | null>(
    null,
  );
  const [requests, setRequests] = useState<Request[]>([]);
  /** One page cursor and one envelope per list; the two lists page apart. */
  const [pages, setPages] = useState<Record<PagedKind, number>>({
    consultation: 1,
    subscription: 1,
  });
  const [listMeta, setListMeta] = useState<Record<PagedKind, ListMeta | null>>({
    consultation: null,
    subscription: null,
  });
  /** When the rows on screen were last successfully read. */
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  /** "N new — Refresh" from the count poll; null while the list is current. */
  const [freshnessBadge, setFreshnessBadge] = useState<string | null>(null);
  /** Totals the rows on screen were read at, and when a count last landed. */
  const knownTotalsRef = useRef<Record<PagedKind, number> | null>(null);
  /** Page-1 top row per kind (requestedAt desc, id desc), so an equal-total
   * swap still raises the badge. Kept across later pages; null = unknown. */
  const knownTopIdsRef = useRef<Record<PagedKind, string | null>>({
    consultation: null,
    subscription: null,
  });
  const lastCountAtRef = useRef<number>(Number.NaN);
  /** Latest list read; an older one that lands later must not overwrite it. */
  const fetchRunRef = useRef(0);
  const [requestedSlotsDialogOpen, setRequestedSlotsDialogOpen] =
    useState(false);
  const [selectedRequestForDialog, setSelectedRequestForDialog] =
    useState<Request | null>(null);
  /** Respond-accept in flight — holds the dialog and disables its exits. #1163 */
  const [respondInFlight, setRespondInFlight] = useState(false);
  /** A confirm that succeeded: the dialog shows it, and the row leaves the
   * list only when the dialog closes (#1703 F5). */
  const [confirmation, setConfirmation] =
    useState<RequestedSlotsConfirmation | null>(null);
  const [allocatingRequest, setAllocatingRequest] = useState(false);
  /** Row awaiting the decline confirmation, and the decline in flight. */
  const [declineTarget, setDeclineTarget] = useState<Request | null>(null);
  const [declining, setDeclining] = useState(false);

  // Fetch requests, available slots, and existing appointments
  const fetchData = useCallback(async () => {
    const run = ++fetchRunRef.current;
    const isCurrent = () => run === fetchRunRef.current;
    setLoading(true);
    setError(null);
    // Local, not the `error` state: reading that in `finally` sees the value
    // from render time, not the one just set, so a failed fetch still stamped
    // "Updated" with a timestamp it had not earned.
    let succeeded = false;

    try {
      // Fetch data in parallel (only PENDING requests), one page each.
      const [consultationsResult, subscriptionsResult] = await Promise.all([
        fetchDataFromApi<ConsultationApiResponse[]>(
          `/api/bookings/consultations?consultantProfileId=${consultantId}&status=PENDING&orgScope=${orgScope}&page=${pages.consultation}&limit=${REQUEST_LIST_DEFAULT_LIMIT}`,
        ),
        fetchDataFromApi<SubscriptionApiResponse[]>(
          `/api/bookings/subscriptions?consultantProfileId=${consultantId}&status=PENDING&orgScope=${orgScope}&page=${pages.subscription}&limit=${REQUEST_LIST_DEFAULT_LIMIT}`,
        ),
      ]);

      // A page/type/scope change started a newer read while this one was in
      // flight; its rows and pager belong to the newer read.
      if (!isCurrent()) return;

      // Check results for the first error
      const results = [consultationsResult, subscriptionsResult];

      for (const result of results) {
        if (!result.ok && result.error) {
          // Set the first encountered error and stop. `finally` clears loading.
          setError({ message: result.error, code: result.code });
          return;
        }
      }

      // If we reach here, all fetches were successful (or returned data: null without error)

      // --- Process Data (only if all fetches were ok) ---
      const processedRequests: Request[] = [];

      // Process consultations
      if (
        consultationsResult.ok &&
        consultationsResult.data &&
        (type === "all" || type === "consultation")
      ) {
        processedRequests.push(
          ...consultationsResult.data.map((consultation) => {
            const slots = consultation.appointment?.occurrences || [];
            const tentativeCount = slots.filter((s) => s.isTentative).length;
            const rescheduledCount = slots.filter(
              isReleasedForReschedule,
            ).length;
            const totalCount = slots.length;

            return {
              id: consultation.id,
              type: AppointmentsType.CONSULTATION,
              title: consultation.consultationPlan?.title || "Untitled Plan",
              requestedBy: consultation.requestedBy,
              requestedAt: consultation.requestedAt,
              requestedTimes: slots.map((slot) => slot.startsAt),
              requestedSlots: slots.map((slot) => ({
                startsAt: slot.startsAt,
                isTentative: slot.isTentative ?? false,
                completionStatus: slot.completionStatus ?? null,
              })),
              status: consultation.status,
              requiredSlots: Math.ceil(
                (consultation.consultationPlan?.durationInHours || 1) / 0.5,
              ), // Convert hours to 30-min slots
              durationInHours:
                consultation.consultationPlan?.durationInHours || 1,
              bookingSource: consultation.bookingSource,
              requestNotes: consultation.requestNotes,
              tentativeSlotCount: tentativeCount,
              rescheduledSlotCount: rescheduledCount,
              proposal: proposalOf(consultation.appointment),
              proposalAppointmentId: proposalOf(consultation.appointment)
                ? consultation.appointment?.id
                : undefined,
              totalSlotCount: totalCount,
            };
          }),
        );
      }

      // Process subscriptions
      if (
        subscriptionsResult.ok &&
        subscriptionsResult.data &&
        (type === "all" || type === "subscription")
      ) {
        processedRequests.push(
          ...subscriptionsResult.data.map((subscription) => {
            const sessionDuration =
              subscription.subscriptionPlan?.sessionDurationInHours || 1;
            const slotsPerSession = Math.ceil(sessionDuration / 0.5);
            // One wrapper per subscription (#1554); the server selects the
            // singular `appointment` and the old plural walk saw nothing (#1704).
            const proposalAppointment = proposalOf(subscription.appointment)
              ? subscription.appointment
              : undefined;
            const allSlots = subscription.appointment?.occurrences ?? [];
            const tentativeCount = allSlots.filter((s) => s.isTentative).length;
            const rescheduledCount = allSlots.filter(
              isReleasedForReschedule,
            ).length;
            const totalCount = allSlots.length;

            return {
              id: subscription.id,
              type: AppointmentsType.SUBSCRIPTION,
              title: subscription.subscriptionPlan?.title || "Untitled Plan",
              requestedBy: subscription.requestedBy,
              requestedAt: subscription.requestedAt,
              requestedTimes: allSlots.map((slot) => slot.startsAt),
              requestedSlots: allSlots.map((slot) => ({
                startsAt: slot.startsAt,
                isTentative: slot.isTentative ?? false,
                completionStatus: slot.completionStatus ?? null,
              })),
              status: subscription.status,
              // When rescheduling (tentative slots exist), only require replacing those slots
              requiredSlots:
                tentativeCount > 0
                  ? tentativeCount
                  : (() => {
                      const totalSessions =
                        subscription.subscriptionPlan?.totalSessions;
                      if (totalSessions && totalSessions > 0) {
                        return totalSessions * slotsPerSession;
                      }
                      // Fallback: week-based calculation
                      const startDate = subscription.schedulingPeriodStartsAt
                        ? new Date(subscription.schedulingPeriodStartsAt)
                        : undefined;
                      const endDate = subscription.schedulingPeriodEndsAt
                        ? new Date(subscription.schedulingPeriodEndsAt)
                        : undefined;
                      const sessionsPerWeek =
                        subscription.subscriptionPlan?.sessionsPerWeek ?? 0;
                      if (startDate && endDate) {
                        const weeks = countSundayWeeksInclusive(
                          startDate,
                          endDate,
                        );
                        return weeks * sessionsPerWeek * slotsPerSession;
                      }
                      // No totalSessions AND no period: the server throws for
                      // such subscriptions, so any client guess (the old
                      // sessionsPerWeek×4×months) produced an allocation the
                      // server rejected. Surface a degraded state instead.
                      Sentry.captureMessage(
                        "Subscription plan missing totalSessions and scheduling period",
                        {
                          tags: {
                            subsystem: "client",
                            feature: "scheduling",
                          },
                          extra: { subscriptionId: subscription.id },
                        },
                      );
                      return undefined;
                    })(),
              totalSessions:
                tentativeCount > 0
                  ? tentativeCount / slotsPerSession
                  : subscription.subscriptionPlan?.totalSessions,
              durationInMonths: subscription.subscriptionPlan?.durationInMonths,
              sessionsPerWeek: subscription.subscriptionPlan?.sessionsPerWeek,
              sessionDurationInHours: sessionDuration,
              // Scheduling period for subscriptions (using correct field names from Prisma schema)
              startDate: subscription.schedulingPeriodStartsAt
                ? new Date(subscription.schedulingPeriodStartsAt)
                : undefined,
              endDate: subscription.schedulingPeriodEndsAt
                ? new Date(subscription.schedulingPeriodEndsAt)
                : undefined,
              schedulingTimezone: subscription.schedulingTimezone,
              bookingSource: subscription.bookingSource,
              requestNotes: subscription.requestNotes,
              tentativeSlotCount: tentativeCount,
              rescheduledSlotCount: rescheduledCount,
              proposal: proposalOf(proposalAppointment),
              proposalAppointmentId: proposalAppointment?.id,
              totalSlotCount: totalCount,
            };
          }),
        );
      }

      // --- Update State ---
      setRequests(processedRequests);
      setListMeta({
        consultation: consultationsResult.meta ?? null,
        subscription: subscriptionsResult.meta ?? null,
      });
      knownTotalsRef.current = {
        consultation: consultationsResult.meta?.total ?? 0,
        subscription: subscriptionsResult.meta?.total ?? 0,
      };
      if (pages.consultation === 1) {
        knownTopIdsRef.current.consultation =
          consultationsResult.data?.[0]?.id ?? null;
      }
      if (pages.subscription === 1) {
        knownTopIdsRef.current.subscription =
          subscriptionsResult.data?.[0]?.id ?? null;
      }
      lastCountAtRef.current = Date.now();
      setFreshnessBadge(null);
      succeeded = true;
    } catch (err) {
      // This catch block now primarily handles errors during data *processing*
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { tags: { subsystem: "client" } },
      );
      console.error("Error processing fetched data:", err);
      if (!isCurrent()) return;
      setError({
        message:
          err instanceof Error
            ? err.message
            : "An unexpected error occurred while processing data.",
      });
    } finally {
      // Loading always clears; the timestamp only moves on a real success.
      if (isCurrent()) {
        setLoading(false);
        if (succeeded) setLastUpdated(new Date());
      }
    }
    // orgScope belongs here: fetchData builds both URLs from it, so without it
    // a scope change without a remount keeps refetching the previous org's rows.
    // `pages` too: a page change is a new read.
    //
    // `error` must NOT: it is written by this callback and read by the effect
    // that calls it, so a failing endpoint looped — fail, set error, new
    // identity, refire, clear error, new identity, refire — hammering the API
    // and never letting the error view settle.
  }, [consultantId, type, orgScope, pages]);

  // A page past the end (the last row on it was allocated) snaps back to the
  // last real page rather than showing an empty table with a Prev button.
  useEffect(() => {
    for (const kind of PAGED_KINDS) {
      const meta = listMeta[kind];
      if (meta && meta.totalPages > 0 && pages[kind] > meta.totalPages) {
        setPages((prev) => ({ ...prev, [kind]: meta.totalPages }));
      }
    }
  }, [listMeta, pages]);

  // The rows fetch once per page/scope change and otherwise only on Refresh
  // or after this tab's own write. Staleness is safe to leave: allocation
  // re-validates server-side under the lock, so a stale row cannot
  // double-book — at worst a submit is refused with a clear message.
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // #1706 decision B — what DOES run on its own is a count poll: limit=1
  // reads of the same two lists, every 45 s while visible, plus a refetch on
  // focus/visibility return behind the shared 5 s staleness floor. It never
  // touches the rows; it only raises the "N new — Refresh" badge.
  const pollCounts = useCallback(async () => {
    const [consultations, subscriptions] = await Promise.all([
      fetchDataFromApi<ConsultationApiResponse[]>(
        `/api/bookings/consultations?consultantProfileId=${consultantId}&status=PENDING&orgScope=${orgScope}&page=1&limit=1`,
      ),
      fetchDataFromApi<SubscriptionApiResponse[]>(
        `/api/bookings/subscriptions?consultantProfileId=${consultantId}&status=PENDING&orgScope=${orgScope}&page=1&limit=1`,
      ),
    ]);
    lastCountAtRef.current = Date.now();
    const known = knownTotalsRef.current;
    if (!known || !consultations.meta || !subscriptions.meta) return;
    const counts = (kind: PagedKind) => type === "all" || type === kind;
    const knownTotal =
      (counts("consultation") ? known.consultation : 0) +
      (counts("subscription") ? known.subscription : 0);
    const polledTotal =
      (counts("consultation") ? consultations.meta.total : 0) +
      (counts("subscription") ? subscriptions.meta.total : 0);
    const knownTop = knownTopIdsRef.current;
    const topRowChanged =
      (counts("consultation") &&
        knownTop.consultation !== null &&
        consultations.data?.[0]?.id !== knownTop.consultation) ||
      (counts("subscription") &&
        knownTop.subscription !== null &&
        subscriptions.data?.[0]?.id !== knownTop.subscription);
    setFreshnessBadge(
      requestsFreshnessBadge(knownTotal, polledTotal, topRowChanged),
    );
  }, [consultantId, orgScope, type]);

  useEffect(() => {
    const poller = createAvailabilityPoller({
      isEnabled: () => Boolean(consultantId),
      visibilityState: () => document.visibilityState,
      msSinceLastFetch: () => Date.now() - lastCountAtRef.current,
      inFlight: () => null,
      fetch: pollCounts,
      intervalMs: REQUESTS_COUNT_POLL_INTERVAL_MS,
    });
    poller.arm();
    const onFocus = () => poller.onReturn();
    const onVisibilityChange = () => poller.onVisibilityChange();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      poller.dispose();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [consultantId, pollCounts]);

  // Idempotency key for the requested-times flow; a retry of the same request
  // reuses the key so the server replays instead of double-booking (#837).
  // A ref, not state — two clicks before a rerender must see the same key.
  const attemptKeyRef = useRef<AllocationAttemptKey | null>(null);

  /** Shared 409 handling: another session already allocated this request. */
  const handleConflict = useCallback(
    (requestId?: string) => {
      toast(allocatedElsewhere());
      setRequestedSlotsDialogOpen(false);
      setSelectedRequestForDialog(null);
      if (requestId) {
        setRequests((prev) => prev.filter((r) => r.id !== requestId));
      }
      fetchData();
      onUpdate();
    },
    [fetchData, onUpdate],
  );

  /**
   * #1163 — the consultee proposed these times, so confirming them is
   * ANSWERING the proposal, not allocating: the respond endpoint re-validates
   * through the full allocator under the wide lock and finalizes the request
   * ACCEPTED, which the allocate PATCH would leave dangling open.
   */
  const acceptProposal = async (request: Request) => {
    setRespondInFlight(true);
    try {
      const response = await fetch(
        `/api/appointments/${request.proposalAppointmentId}/reschedule/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "accept" }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };

      if (response.status === 409 || response.status === 404) {
        // Withdrawn/answered elsewhere, or the allocator refused the times —
        // either way this snapshot is stale; resync instead of retrying.
        toast({
          title: "Could not confirm",
          description: data.error || "This proposal can no longer be accepted.",
          variant: "destructive",
        });
        setRequestedSlotsDialogOpen(false);
        setSelectedRequestForDialog(null);
        fetchData();
        onUpdate();
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || "Failed to confirm the proposed times");
      }

      toast({
        ...timesConfirmed(),
        description:
          data.message ?? "The booking has moved to the proposed times.",
      });
      setRequestedSlotsDialogOpen(false);
      setSelectedRequestForDialog(null);
      setRequests((prev) => prev.filter((r) => r.id !== request.id));
      onUpdate();
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client", feature: "scheduling" } },
      );
      toast(
        allocationFailed(
          error instanceof Error
            ? error.message
            : "Failed to confirm the proposed times",
        ),
      );
    } finally {
      setRespondInFlight(false);
    }
  };

  /** Every exit from the confirm dialog; a confirmed row leaves the list here. */
  const closeRequestedSlotsDialog = () => {
    const confirmedId = confirmation ? selectedRequestForDialog?.id : undefined;
    setRequestedSlotsDialogOpen(false);
    setSelectedRequestForDialog(null);
    setConfirmation(null);
    if (confirmedId) {
      setRequests((prev) => prev.filter((r) => r.id !== confirmedId));
      onUpdate();
    }
  };

  const handleRequestedAllocation = async (override: boolean) => {
    if (!selectedRequestForDialog) return;

    // A live consultee proposal answers through respond, never allocate. #1163
    if (answerableProposal(selectedRequestForDialog)) {
      await acceptProposal(selectedRequestForDialog);
      return;
    }

    // Pending state for the confirm button: without it clicks give zero
    // feedback and double-submits are only saved by the idempotency ref.
    setAllocatingRequest(true);
    try {
      const result = await approveRequestedTimes(
        selectedRequestForDialog,
        attemptKeyRef,
        override,
      );

      const conflict = classifyRequestedConflict(result);
      if (conflict === "stale") {
        // The row changed elsewhere: close (the open dialog still shows the
        // stale tentative count and would rebuild the same burned
        // precondition on retry) and refetch; the row itself stays.
        toast(requestChangedElsewhere());
        setRequestedSlotsDialogOpen(false);
        setSelectedRequestForDialog(null);
        fetchData();
        onUpdate();
        return;
      }
      if (conflict === "stay-open") {
        toast(
          allocationFailedWithCode(
            result.error ?? "Failed to allocate slots",
            result.errorCode,
          ),
        );
        return;
      }
      if (conflict === "genuine-conflict") {
        handleConflict(selectedRequestForDialog.id);
        return;
      }

      if (!result.success) {
        throw new Error(result.error || "Failed to allocate slots");
      }

      toast(timesConfirmed());

      // Stay open in the success state; closing removes the row (#1703 F5).
      const appointmentId = result.data?.[0]?.id;
      setConfirmation({
        appointmentHref: appointmentId
          ? `/dashboard/consultant/${consultantId}/appointments/${appointmentId}`
          : null,
      });
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client", feature: "scheduling" } },
      );
      toast(
        allocationFailed(
          error instanceof Error ? error.message : "Failed to allocate slots",
        ),
      );
    } finally {
      setAllocatingRequest(false);
    }
  };

  /** Runs after the confirm dialog — declining rejects a request someone is
   *  waiting on (and refunds anything paid), so it is never one click. */
  const handleDeclineConfirm = async () => {
    const request = declineTarget;
    if (!request) return;
    setDeclining(true);
    try {
      await declineRequest(request);
      toast({
        title: "Request declined",
        description: `The ${getRequestTypeLabel(request.type).toLowerCase()} request has been declined.`,
        variant: "default",
      });
      setRequests((prev) => prev.filter((r) => r.id !== request.id));
      setDeclineTarget(null);
      onUpdate();
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Couldn't decline request",
        description:
          error instanceof Error ? error.message : "Failed to decline request",
        variant: "destructive",
      });
    } finally {
      setDeclining(false);
    }
  };

  // No heading here: both mount points already render a "Requests" page header,
  // so anything this component titles itself is the second copy of it.
  if (loading) {
    return (
      <Card className="border-0 shadow-none rounded-none">
        <CardContent
          role="status"
          aria-live="polite"
          className="flex flex-col items-center justify-center gap-3 p-8"
        >
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-foreground"></div>
          <p className="text-sm text-muted-foreground">
            Loading requests and availability...
          </p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-0 shadow-none rounded-none">
        <CardHeader>
          <CardTitle>Couldn&apos;t load requests</CardTitle>
          <CardDescription>
            {error.message}
            {error.code && (
              <span className="ml-2 font-mono text-xs">({error.code})</span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* In place, not a page reload: the reload lost every filter and
              the scroll position for the same fetch (#1705). */}
          <Button onClick={() => fetchData()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const columns: ResponsiveColumn<Request>[] = [
    {
      key: "type",
      header: "Type",
      headClassName: "w-[96px]",
      className: "align-top whitespace-nowrap",
      cell: (request) => getRequestTypeLabel(request.type),
    },
    {
      key: "title",
      header: "Title",
      primary: true,
      headClassName: "w-[190px]",
      className: "align-top",
      // The reschedule state and the slot count both describe the booking, so
      // they belong under its name — not stacked on top of the times.
      cell: (request) => (
        <div className="flex flex-col items-start gap-1">
          <span className="font-medium text-foreground">{request.title}</span>
          <RescheduleBadge request={request} />
          <span className="text-xs text-muted-foreground">
            {request.requiredSlots === undefined
              ? "Slot count unavailable"
              : `${request.requiredSlots} slot${
                  request.requiredSlots !== 1 ? "s" : ""
                } to allocate`}
          </span>
        </div>
      ),
    },
    {
      key: "requestedBy",
      header: "Requested By",
      headClassName: "w-[124px]",
      className: "align-top",
      cell: (request) => (
        <span
          className="block max-w-[124px] truncate"
          title={request.requestedBy.user.name}
        >
          {request.requestedBy.user.name}
        </span>
      ),
    },
    {
      key: "requestedAt",
      header: "Requested",
      headClassName: "w-[112px]",
      className: "align-top",
      cell: (request) => {
        const requestedAt = new Date(request.requestedAt);
        return (
          <div className="text-xs lg:whitespace-nowrap">
            <div className="text-foreground">
              {formatInViewerZone(requestedAt, viewer.zone, "d MMM yyyy")}
            </div>
            <div className="text-muted-foreground">
              {formatInViewerZone(requestedAt, viewer.zone, "h:mm a")}{" "}
              {zoneLabel(requestedAt, viewer.zone)}
            </div>
          </div>
        );
      },
    },
    {
      key: "requestedTimes",
      header: "Requested Times",
      // The min-width rides on the <td> (desktop only) so it cannot force a
      // phone card wider than the screen. Nowrap times give this column the
      // widest max-content in the table, which is what finally makes the auto
      // layout hand it the slack instead of padding out the right-hand edge.
      className: "min-w-[220px] align-top",
      // The live offer on top, the times it moves away from underneath: one
      // "from -> to" reading instead of two competing cards.
      cell: (request) => (
        <div className="space-y-1.5 text-left">
          {request.proposal && (
            <ProposalBlock proposal={request.proposal} viewer={viewer} />
          )}
          <StoredTimes request={request} viewer={viewer} />
        </div>
      ),
    },
    {
      key: "note",
      header: "Note",
      // The row's flexible column. The table had ~200px of dead space between
      // the times and the status, while the one thing explaining WHY the
      // consultee wants those times was fetched by nobody and shown nowhere —
      // so the consultant allocated without ever reading the request.
      className: "align-top",
      cell: (request) =>
        request.requestNotes?.trim() ? (
          <RequestNote notes={request.requestNotes.trim()} />
        ) : (
          // An em dash rather than blank: "they said nothing" and "we failed to
          // load it" should not look identical.
          <span className="text-xs text-muted-foreground/60">&mdash;</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      headClassName: "w-[116px]",
      className: "align-top",
      cell: (request) =>
        // One badge per state (#1705): the payment case used to stack a
        // status pill AND the payment pill with two different labels.
        request.status === AppointmentStatus.APPROVED_PENDING_PAYMENT ? (
          <PaymentRequiredBadge variant="full" />
        ) : (
          <Badge variant={getRequestStatusBadgeVariant(request.status)}>
            {getRequestStatusLabel(request.status)}
          </Badge>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      headClassName: "w-[152px]",
      className: "align-top",
      cell: (request) =>
        request.status === AppointmentStatus.PENDING ? (
          <div className="flex flex-col gap-1.5">
            {request.requiredSlots === undefined ? (
              // Not a dead end: say what to do, name the request, offer a
              // re-read (#1705).
              <div className="space-y-1.5 text-xs text-muted-foreground">
                <p>{planConfigIncomplete().description}</p>
                <p className="font-mono text-[11px]">Request {request.id}</p>
                <div className="flex flex-wrap gap-1.5">
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`/dashboard/consultant/${consultantId}/support`}
                    >
                      Contact support
                    </Link>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={TOUCH_TARGET}
                    onClick={() => fetchData()}
                  >
                    Refresh
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {/* A page, not a dialog: placing N sessions across a
                    scheduling period under per-day and per-week caps needs
                    the width, and a URL the notification can link to. */}
                <Button
                  asChild
                  size="sm"
                  className={cn("w-full", TOUCH_TARGET)}
                >
                  <Link href={allocateHrefFor(request)}>Allocate Slots</Link>
                </Button>
                {/* Hidden for directly booked consultations (Bug #8 fix), and
                    for a reschedule that names NO times: released slots still
                    carry the ORIGINAL startsAt, so "using" them would
                    re-confirm the times the consultee just asked to move.
                    A live proposal lifts that suppression — the button then
                    answers with the PROPOSED times via respond-accept. #1163 */}
                {answerableProposal(request) ||
                (request.requestedTimes &&
                  request.requestedTimes.length > 0 &&
                  request.bookingSource === "REQUEST_SUBMITTED" &&
                  (request.rescheduledSlotCount ?? 0) === 0) ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn("w-full", TOUCH_TARGET)}
                    disabled={respondInFlight}
                    onClick={() => {
                      setSelectedRequestForDialog(request);
                      setRequestedSlotsDialogOpen(true);
                    }}
                  >
                    Use Requested Times
                  </Button>
                ) : (
                  request.bookingSource === "DIRECT_CHECKOUT" && (
                    // Say why the affordance is absent instead of leaving a
                    // gap the consultant reads as "broken" (#1705).
                    <p className="text-[11px] text-muted-foreground">
                      Booked at checkout without requested times — pick them in
                      Allocate Slots.
                    </p>
                  )
                )}
              </>
            )}
            {/* Quiet by design: declining is the rarer branch, and nothing is
                destroyed until the confirm dialog is answered. #1163 adds the
                subscription arm — its PATCH gained the same consultant-only
                REJECTED path (#1004). */}
            {(request.type === AppointmentsType.CONSULTATION ||
              request.type === AppointmentsType.SUBSCRIPTION) && (
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "w-full text-destructive hover:bg-destructive/10 hover:text-destructive",
                  TOUCH_TARGET,
                )}
                disabled={declining}
                onClick={() => setDeclineTarget(request)}
              >
                Decline
              </Button>
            )}
          </div>
        ) : null,
    },
  ];

  return (
    <Card className="border-0 shadow-none rounded-none">
      <CardContent className="p-0 sm:p-6">
        {/* Staleness is stated rather than implied: the rows are a snapshot
            until Refresh, and the count poll says when that snapshot is
            behind (#1706). */}
        <div className="mb-3 flex items-center justify-end gap-3">
          <span role="status" aria-live="polite">
            {freshnessBadge && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => fetchData()}
                disabled={loading}
                className="gap-1.5 bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200"
              >
                {freshnessBadge} &mdash; Refresh
              </Button>
            )}
          </span>
          {lastUpdated && (
            <span
              className="text-xs text-muted-foreground"
              title={lastUpdated.toLocaleString()}
            >
              Updated {formatRelativeTime(lastUpdated)}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchData()}
            disabled={loading}
            className="gap-1.5"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
              aria-hidden
            />
            Refresh
          </Button>
        </div>

        {requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
              <AlertTriangle className="h-8 w-8 text-muted-foreground/70" />
            </div>
            <h4 className="text-lg font-semibold text-foreground">
              No pending requests
            </h4>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">
              When consultees request sessions through your profile, they will
              appear here for slot allocation.
            </p>
          </div>
        ) : (
          // Cards until lg: seven columns of dense, non-wrapping content need
          // ~1000px, and the md default left tablets with a table that either
          // scrolled sideways or squeezed the times into unreadable fragments.
          <ResponsiveTable<Request>
            columns={columns}
            rows={requests}
            getRowId={(r) => r.id}
            breakpoint="lg"
          />
        )}

        {(listMeta.consultation || listMeta.subscription) && (
          <div className="mt-4 space-y-2 px-4 sm:px-0">
            {PAGED_KINDS.map((kind) => {
              const meta = listMeta[kind];
              if (!meta || (type !== "all" && type !== kind)) return null;
              return (
                <ListPager
                  key={kind}
                  label={
                    kind === "consultation" ? "consultations" : "subscriptions"
                  }
                  meta={meta}
                  page={pages[kind]}
                  disabled={loading}
                  onPage={(next) =>
                    setPages((prev) => ({ ...prev, [kind]: next }))
                  }
                />
              );
            })}
          </div>
        )}

        <RequestedSlotsDialog
          open={requestedSlotsDialogOpen}
          onOpenChange={(next) => {
            if (!next) closeRequestedSlotsDialog();
            else setRequestedSlotsDialogOpen(true);
          }}
          confirmation={confirmation}
          requestId={selectedRequestForDialog?.id || ""}
          requestType={
            selectedRequestForDialog?.type || AppointmentsType.CONSULTATION
          }
          requestedSlots={(() => {
            // In the proposal case the times under review are the PROPOSED
            // ones — the stored slots still hold what is being moved away
            // from. #1163
            if (!selectedRequestForDialog) return [];
            const proposal = answerableProposal(selectedRequestForDialog);
            return proposal
              ? currentRoundSlots(proposal).map((slot) => slot.startsAt)
              : selectedRequestForDialog.requestedTimes || [];
          })()}
          requestedSlotsWithStatus={selectedRequestForDialog?.requestedSlots}
          schedulingPeriod={
            selectedRequestForDialog?.startDate &&
            selectedRequestForDialog?.endDate
              ? {
                  startDate: selectedRequestForDialog.startDate,
                  endDate: selectedRequestForDialog.endDate,
                }
              : undefined
          }
          confirming={respondInFlight || allocatingRequest}
          allocateHref={
            selectedRequestForDialog
              ? allocateHrefFor(selectedRequestForDialog)
              : `/dashboard/consultant/${consultantId}/requests`
          }
          appointmentHrefFor={(appointmentId) =>
            `/dashboard/consultant/${consultantId}/appointments/${appointmentId}`
          }
          rescheduleNeedsAllocator={
            // Only an actual reschedule-in-flight (RESCHEDULED rows) makes
            // the stored times un-approvable: they are the times being moved
            // AWAY from, and the server's requested-slots mode refuses them
            // by design. A fresh REQUEST_SUBMITTED hold is tentative too, but
            // its times ARE the request — gating on tentativeSlotCount
            // blocked every fresh "Use Requested Times" approval (E2E #1682).
            // Mirrors the row's own button gate (rescheduledSlotCount).
            !!selectedRequestForDialog &&
            (selectedRequestForDialog.rescheduledSlotCount ?? 0) > 0 &&
            !answerableProposal(selectedRequestForDialog)
          }
          onConfirm={handleRequestedAllocation}
          onCancel={closeRequestedSlotsDialog}
        />

        <AlertDialog
          open={!!declineTarget}
          onOpenChange={(open) => {
            if (!open && !declining) setDeclineTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Decline this request?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>
                    <strong>{declineTarget?.requestedBy.user.name}</strong>{" "}
                    asked for{" "}
                    <strong>&quot;{declineTarget?.title}&quot;</strong>. This
                    rejects the whole booking request.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    The consultee is notified, and if they have already paid,
                    the payment is returned in full.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={declining}>
                Keep request
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={declining}
                className="bg-red-600 text-white hover:bg-red-700 focus:ring-red-600"
                onClick={(event) => {
                  // Keep the dialog open while in flight; success closes it.
                  event.preventDefault();
                  void handleDeclineConfirm();
                }}
              >
                {declining ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Declining...
                  </>
                ) : (
                  "Decline request"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// Helper function for badge variant
function getRequestStatusBadgeVariant(
  status: AppointmentStatus,
): "outline" | "default" | "destructive" | "secondary" {
  switch (status) {
    case AppointmentStatus.PENDING:
    case AppointmentStatus.APPROVED_PENDING_PAYMENT:
      return "outline";
    case AppointmentStatus.APPROVED:
    case AppointmentStatus.SCHEDULED:
      return "default";
    case AppointmentStatus.COMPLETED:
      return "secondary";
    case AppointmentStatus.REJECTED:
    case AppointmentStatus.CANCELLED:
    case AppointmentStatus.EXPIRED:
      return "destructive";
    default:
      return "outline";
  }
}

function getRequestStatusLabel(status: AppointmentStatus): string {
  switch (status) {
    case AppointmentStatus.PENDING:
      return "Pending";
    case AppointmentStatus.APPROVED:
      return "Approved";
    case AppointmentStatus.APPROVED_PENDING_PAYMENT:
      // Same words as lib/labels/session-labels.ts (#1705).
      return "Payment required";
    case AppointmentStatus.SCHEDULED:
      return "Scheduled";
    case AppointmentStatus.COMPLETED:
      return "Completed";
    case AppointmentStatus.REJECTED:
      return "Rejected";
    case AppointmentStatus.CANCELLED:
      return "Cancelled";
    case AppointmentStatus.EXPIRED:
      return "Expired";
    default:
      return status;
  }
}
