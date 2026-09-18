import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { AppointmentsType } from "@prisma/client";
import {
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AllocationService } from "@/lib/scheduling/allocationService";
import {
  classifyValidationFailure,
  signInHref,
  validationFailureCopy,
  type ValidationFailureKind,
} from "@/lib/scheduling/allocationMessages";
import { CalendarInterval } from "@/lib/scheduling/calendarUtils";
import { formatDateTimeLabel } from "@/lib/time/display";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { zoneLabel, type ViewerZone } from "@/lib/time/viewer-zone";
import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";
import { cn } from "@/utils/tailwind";
import {
  allocateHrefAt,
  parseSlotInstant,
  resolvePrimaryTitle,
  summarizeVerdicts,
  verdictFor,
  type SlotVerdict,
  type ValidationVerdictSource,
} from "./requested-slots-verdicts";

// Slot with tentative status. completionStatus distinguishes a fresh
// REQUEST_SUBMITTED hold (tentative + SCHEDULED — the requested times ARE the
// offer) from a reschedule release (tentative + RESCHEDULED — the stored times
// are what the consultee asked to move away from).
interface SlotWithStatus {
  startsAt: string;
  isTentative: boolean;
  completionStatus?: string | null;
}

type ValidationResult = ValidationVerdictSource;

/** What the host reports once the allocation has been written (#1703 F5). */
export interface RequestedSlotsConfirmation {
  /** The consultant's own detail page for the new appointment, when known. */
  appointmentHref: string | null;
}

interface RequestedSlotsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  requestType: AppointmentsType;
  requestedSlots: string[];
  requestedSlotsWithStatus?: SlotWithStatus[]; // New: includes tentative info
  schedulingPeriod?: { startDate?: Date; endDate?: Date };
  /** Parent's confirm is in flight — hold both exits so a double click can't
   * fire a second submit. #1163 */
  confirming?: boolean;
  /**
   * Set by the host after a successful confirm: the dialog switches to its
   * success state instead of closing, and the row leaves the list when the
   * dialog does (#1703 F5).
   */
  confirmation?: RequestedSlotsConfirmation | null;
  /**
   * A reschedule with no answerable consultee proposal cannot confirm its
   * stored times: those rows still carry the times being moved AWAY from
   * (the reschedule route never rewrites startsAt), so the server's
   * requested-slots mode refuses them by design. When set, the confirm
   * button is replaced with guidance toward the Allocate Slots surface,
   * which is where replacement times are actually placed.
   */
  rescheduleNeedsAllocator?: boolean;
  /** The allocate page for this request — every "pick another time" exit
   * in the dialog is a real link there, never a disabled button. #1705 */
  allocateHref: string;
  onConfirm: (override: boolean) => Promise<void>;
  onCancel: () => void;
}

interface ValidationFailure {
  kind: ValidationFailureKind;
  message: string;
}

/** The primary's word: "Override and Allocate" is locked copy for the out-of-hours case. */
function primaryLabel(state: {
  confirming: boolean;
  outsideHours: number;
}): string {
  if (state.confirming) return "Allocating…";
  return state.outsideHours > 0
    ? "Override and Allocate"
    : "Allocate requested times";
}

/** "Thu 24 Sep, 2:00 pm IST" in the viewer's zone. */
function slotLabel(slot: string, viewer: ViewerZone): string {
  const at = new Date(parseSlotInstant(slot));
  return `${formatDateTimeLabel(at, { zone: viewer.zone })} ${zoneLabel(at, viewer.zone)}`;
}

const CHIP: Record<
  SlotVerdict["kind"],
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  checking: {
    label: "Checking…",
    icon: Loader2,
    className: "bg-muted text-muted-foreground",
  },
  free: {
    label: "Free",
    icon: CheckCircle2,
    className:
      "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  },
  conflict: {
    label: "Conflict",
    icon: XCircle,
    className: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
  },
  outsideAvailability: {
    label: "Outside hours",
    icon: AlertTriangle,
    className:
      "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  },
  outsidePeriod: {
    label: "Outside period",
    icon: CalendarRange,
    className:
      "bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  },
};

function VerdictChip({ verdict }: Readonly<{ verdict: SlotVerdict }>) {
  const chip = CHIP[verdict.kind];
  const Icon = chip.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        chip.className,
      )}
    >
      <Icon
        className={cn(
          "h-3 w-3",
          verdict.kind === "checking" && "motion-safe:animate-spin",
        )}
        aria-hidden
      />
      {chip.label}
    </span>
  );
}

export function RequestedSlotsDialog({
  open,
  onOpenChange,
  requestId,
  requestType,
  requestedSlots,
  requestedSlotsWithStatus,
  schedulingPeriod,
  confirming = false,
  confirmation = null,
  rescheduleNeedsAllocator = false,
  allocateHref,
  onConfirm,
  onCancel,
}: RequestedSlotsDialogProps) {
  const pathname = usePathname();
  const viewer = useViewerZone();
  // Calculate reschedule info from slots with status. Only released rows
  // count (see isReleasedForReschedule): every fresh request also carries
  // tentative holds, and those times ARE the request — the server's
  // requested-slots mode approves exactly them. Gating the banner on
  // tentativeness painted "needs new times" on every fresh approval
  // (E2E on preview #1682).
  const totalCount = requestedSlotsWithStatus?.length ?? requestedSlots.length;
  const rescheduledCount =
    requestedSlotsWithStatus?.filter(isReleasedForReschedule).length ?? 0;
  const hasReschedule = rescheduledCount > 0;
  const isFullReschedule = rescheduledCount === totalCount && totalCount > 0;
  const [loading, setLoading] = useState(false);
  const [validationResult, setValidationResult] =
    useState<ValidationResult | null>(null);
  const [error, setError] = useState<ValidationFailure | null>(null);
  // The dialog stays mounted across requests, so a slow validation for one
  // request can land after the next request's; only the latest run writes.
  const validationRunRef = useRef(0);

  // Validate slots when dialog opens
  const validateSlots = useCallback(async () => {
    const run = ++validationRunRef.current;
    const isCurrent = () => run === validationRunRef.current;
    try {
      setLoading(true);
      setError(null);
      setValidationResult(null);

      const eventType =
        requestType === AppointmentsType.SUBSCRIPTION
          ? "subscription"
          : "consultation";

      // Convert requested slots to CalendarInterval objects
      const timeSlots: CalendarInterval[] = requestedSlots.map((slotString) => {
        const startTime = new Date(slotString);
        const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30 minutes later
        return {
          startTime,
          endTime,
          isAvailable: true,
          isBooked: false,
        };
      });

      // Server-side validation (conflicts, availability)
      const validationResponse = await AllocationService.validateSlots(
        eventType,
        requestId,
        timeSlots,
      );

      if (!isCurrent()) return;
      if (!validationResponse.success) {
        // Mapped, not thrown: a 401 (#1716 cold-instance read of a valid
        // cookie) or 403 is an answer, not an exception, and the copy has to
        // say what to do rather than echo "Unauthorized".
        const kind = classifyValidationFailure(validationResponse.httpStatus);
        setError({
          kind,
          message: validationFailureCopy(
            kind,
            validationResponse.error ?? "Failed to validate slots",
          ),
        });
        return;
      }

      // Client-side scheduling period validation
      const outsidePeriodSlots: Array<{ slot: string }> = [];
      const { startDate, endDate } = schedulingPeriod ?? {};
      if (startDate && endDate) {
        requestedSlots.forEach((slot) => {
          const slotDate = new Date(slot);
          const slotEndDate = new Date(slotDate.getTime() + 30 * 60 * 1000);
          if (slotDate < startDate || slotEndDate > endDate) {
            outsidePeriodSlots.push({ slot });
          }
        });
      }

      // Merge server-side and client-side validation results
      setValidationResult({
        conflicts: validationResponse.data?.conflicts || [],
        outsideAvailability: validationResponse.data?.outsideAvailability || [],
        outsidePeriod: outsidePeriodSlots,
        validSlots: validationResponse.data?.validSlots || [],
      });
    } catch (err) {
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { tags: { subsystem: "client" } },
      );
      if (!isCurrent()) return;
      setError({
        kind: "indeterminate",
        message: validationFailureCopy("indeterminate", ""),
      });
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [requestType, requestedSlots, requestId, schedulingPeriod]);

  // Validate on open — not while the success state is showing.
  useEffect(() => {
    if (open && !confirmation) {
      validateSlots();
    }
  }, [open, confirmation, requestId, requestedSlots, validateSlots]);

  const verdicts = requestedSlots.map((slot) =>
    verdictFor(slot, validationResult),
  );
  const conflicts = verdicts.filter((v) => v.kind === "conflict").length;
  const outsidePeriod = verdicts.filter(
    (v) => v.kind === "outsidePeriod",
  ).length;
  const outsideHours = verdicts.filter(
    (v) => v.kind === "outsideAvailability",
  ).length;
  // Conflicts and out-of-period slots cannot be overridden; out-of-hours can.
  const blocked = conflicts > 0 || outsidePeriod > 0;
  const firstBlockedSlot = requestedSlots.find((slot, index) => {
    const kind = verdicts[index].kind;
    return kind === "conflict" || kind === "outsidePeriod";
  });

  // Mirrors the decline dialog: while the confirm is in flight the dialog
  // cannot be dismissed, so success is the only thing that closes it.
  const guardedOpenChange = (next: boolean) => {
    if (!next && confirming) return;
    onOpenChange(next);
  };

  // Validation must have run AND passed; a failed or absent validation used
  // to leave "Allocate Requested Times" clickable (#1705, #1716).
  const canConfirm =
    validationResult !== null && !error && !loading && !confirming && !blocked;

  const renderSlotList = () => (
    <ul className="divide-y divide-border rounded-md border border-border">
      {requestedSlots.map((slot, index) => {
        const verdict = verdicts[index];
        const needsAnotherTime =
          verdict.kind === "conflict" || verdict.kind === "outsidePeriod";
        return (
          <li
            key={`${slot}-${index}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
          >
            <span className="font-medium tabular-nums">
              {slotLabel(slot, viewer)}
            </span>
            <VerdictChip verdict={verdict} />
            {verdict.kind === "conflict" && (
              <span className="text-muted-foreground">{verdict.existing}</span>
            )}
            {verdict.kind === "outsidePeriod" && (
              <span className="text-muted-foreground">
                Outside the subscription&apos;s scheduling period
              </span>
            )}
            {needsAnotherTime && (
              <Link
                href={allocateHrefAt(allocateHref, slot)}
                className="ml-auto text-xs underline underline-offset-4"
              >
                Pick another time
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );

  const renderDialogContent = () => {
    if (confirmation) {
      return (
        <div
          role="status"
          className="flex flex-col items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-6 text-center dark:border-emerald-900/50 dark:bg-emerald-900/20"
        >
          <CheckCircle2
            className="h-8 w-8 text-emerald-700 dark:text-emerald-300"
            aria-hidden
          />
          <p className="text-base font-semibold">Times confirmed</p>
          <ul className="text-sm text-muted-foreground">
            {requestedSlots.map((slot, index) => (
              <li key={`${slot}-${index}`}>{slotLabel(slot, viewer)}</li>
            ))}
          </ul>
        </div>
      );
    }

    if (error) {
      return (
        <div
          role="alert"
          className="rounded-md bg-red-50 p-4 dark:bg-red-950/40"
        >
          <p className="mb-3 text-red-700 dark:text-red-200">{error.message}</p>
          {error.kind === "session-ended" ? (
            <Button asChild variant="outline" size="sm">
              <Link href={signInHref(pathname ?? "/")}>Sign in</Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={validateSlots}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Retry Validation
            </Button>
          )}
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-3">
        {/* One sentence, not a 2×2 of counters (#1703 F5). */}
        <p className="text-sm font-medium" aria-live="polite">
          {summarizeVerdicts(verdicts)}
        </p>
        {renderSlotList()}
        {!blocked && outsideHours > 0 && (
          <p className="text-sm text-amber-800 dark:text-amber-200">
            {outsideHours === 1
              ? "This time is outside your published hours — allocating still books it."
              : "These times are outside your published hours — allocating still books them."}
          </p>
        )}
      </div>
    );
  };

  const renderPrimary = () => {
    if (confirmation) {
      return (
        <>
          {confirmation.appointmentHref && (
            <Button asChild variant="outline">
              <Link href={confirmation.appointmentHref}>View appointment</Link>
            </Button>
          )}
          <Button onClick={onCancel}>Back to requests</Button>
        </>
      );
    }
    if (rescheduleNeedsAllocator) {
      // The stored times are what the consultee asked to MOVE AWAY from —
      // confirming them here would re-book the very times the reschedule is
      // trying to leave, and the server refuses it. A real link to the
      // surface that places replacement times.
      return (
        <Button asChild>
          <Link href={allocateHref}>Pick new times in Allocate Slots</Link>
        </Button>
      );
    }
    if (validationResult && blocked) {
      // The dead-end hand-off (#1703 F5): the primary deep-links to the grid
      // pinned on the first blocked slot, so the conflicting cell is in view.
      return (
        <Button asChild title={resolvePrimaryTitle({ blocked, outsideHours })}>
          <Link
            href={
              firstBlockedSlot
                ? allocateHrefAt(allocateHref, firstBlockedSlot)
                : allocateHref
            }
          >
            Pick another time
          </Link>
        </Button>
      );
    }
    if (!validationResult || error) return null;
    return (
      <Button
        variant={outsideHours > 0 ? "warning" : "default"}
        onClick={() => onConfirm(outsideHours > 0)}
        disabled={!canConfirm}
        title={resolvePrimaryTitle({ blocked, outsideHours })}
      >
        {confirming && (
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
        )}
        {primaryLabel({ confirming, outsideHours })}
      </Button>
    );
  };

  return (
    <ResponsiveModal open={open} onOpenChange={guardedOpenChange}>
      <ResponsiveModalContent className="flex max-h-[90dvh] max-w-2xl flex-col overflow-hidden">
        <ResponsiveModalHeader className="shrink-0">
          <ResponsiveModalTitle>
            {confirmation ? "Booked" : "Confirm requested times"}
          </ResponsiveModalTitle>
          <ResponsiveModalDescription>
            {confirmation
              ? "The consultee has been told."
              : "Check the requested times before booking them."}
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Reschedule indicator */}
          {hasReschedule && !confirmation && (
            <div className="mb-4">
              {isFullReschedule ? (
                <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-200">
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  <span>
                    Full reschedule — all {totalCount} session
                    {totalCount !== 1 ? "s" : ""} need new times
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                  <AlertTriangle className="h-4 w-4" aria-hidden />
                  <span>
                    Partial reschedule — {rescheduledCount} of {totalCount}{" "}
                    session{rescheduledCount !== 1 ? "s" : ""} need new times
                  </span>
                </div>
              )}
            </div>
          )}

          {renderDialogContent()}
        </div>

        <ResponsiveModalFooter className="shrink-0 gap-2 border-t pt-4">
          {!confirmation && (
            <Button
              variant="outline"
              onClick={onCancel}
              disabled={loading || confirming}
            >
              Cancel
            </Button>
          )}
          {renderPrimary()}
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
