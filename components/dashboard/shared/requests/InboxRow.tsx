"use client";

import { proposedSessionsOf } from "@/lib/booking/reschedule-proposals";
import Image from "next/image";
import Link from "next/link";
import { MoreHorizontal, Timer, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useHoldCountdown } from "@/hooks/useHoldCountdown";
import { useRerenderAfter } from "@/hooks/useRerenderAfter";
import { useIsDesktop } from "@/hooks/use-media-query";
import { subscriptionCycleHeading } from "@/lib/booking/entitlement";
import {
  deriveBookingPresentation,
  toneBadge,
  type BookingPresentation,
  type MoneyState,
} from "@/lib/dashboard/money-state";
import {
  tentativeAtomsOf,
  toStampDate,
  type InboxRowInput,
} from "@/lib/dashboard/requests-inbox-state";
import {
  formatInViewerZone,
  zoneLabel,
  type ViewerZone,
} from "@/lib/time/viewer-zone";
import { formatCurrencyAmount } from "@/utils/formatting";
import { cn } from "@/utils/tailwind";
import { useState } from "react";

import {
  CHECKOUT_HOLD_BADGE,
  CHECKOUT_HOLD_LINE,
  KIND_LABEL,
  NEXT_CYCLE_BADGE,
  REQUESTED_TIME_PASSED,
  nextCycleLine,
} from "./labels";
import { FREE_TRIAL_LABEL } from "@/lib/appointments/trial-labels";
import { requestCountLine } from "./request-count-line";

/** What one row can do; the inbox owns the handlers. */
export type RowAction =
  | { kind: "approve"; mode: "requested" | "allocate" }
  | { kind: "decline" }
  | { kind: "remind" }
  | { kind: "withdraw" }
  | { kind: "allocate-next" }
  | { kind: "propose-times" }
  | { kind: "accept-proposal" }
  | { kind: "place-new-time" }
  | { kind: "keep-original" }
  | { kind: "withdraw-proposal" };

export interface RowActions {
  primary: RowAction | null;
  secondary: RowAction[];
}

const ACTION_LABEL: Record<RowAction["kind"], string> = {
  approve: "Approve",
  decline: "Decline",
  remind: "Remind",
  withdraw: "Withdraw approval",
  "allocate-next": "Allocate",
  "propose-times": "Propose new times",
  "accept-proposal": "Accept new times",
  "place-new-time": "Pick a new time",
  "keep-original": "Keep the original time",
  "withdraw-proposal": "Withdraw my request",
};

/**
 * The consultee proposed these times, so approving is ANSWERING the
 * proposal through respond (#1163): open, consultee-initiated, naming times.
 */
export function answerableProposal(row: InboxRowInput) {
  const p = row.proposal;
  if (
    p?.status !== "PENDING_REVIEW" ||
    p.initiatorRole !== "CONSULTEE" ||
    !row.appointmentId ||
    p.proposedTimes.length === 0
  ) {
    return null;
  }
  return p;
}

/** The reschedule open on this booking, whoever asked; null when none is. */
export function openProposal(row: InboxRowInput) {
  return row.proposal?.status === "PENDING_REVIEW" ? row.proposal : null;
}

/**
 * Dialog-free approval: the consultee named times that fully cover what the
 * plan needs, nothing is mid-reschedule, and no proposal is open. Only these
 * rows may be batch-approved (#1775).
 */
export function isDialogFreeApproval(row: InboxRowInput): boolean {
  return (
    (row.kind === "consultation" || row.kind === "subscription") &&
    row.bookingSource === "REQUEST_SUBMITTED" &&
    // Only a request still awaiting the expert's answer; an approved one awaits payment.
    row.presentation.request?.status === "PENDING" &&
    !row.requestedStartPassed &&
    row.rescheduledSlotCount === 0 &&
    row.proposal === null &&
    row.requiredSlots !== null &&
    row.tentativeSlotCount > 0 &&
    tentativeAtomsOf(row.slots) >= row.requiredSlots
  );
}

const isDestructive = (action: RowAction) =>
  action.kind === "decline" || action.kind === "withdraw";

/**
 * A booking being moved is answered, never declined: the client's proposal is
 * accepted (or placed, when any time works) or turned down to keep the original
 * time; the consultant's own request, with times or without, is only withdrawn
 * (the server never lets the expert place over it); released sessions with no
 * request left need a new time.
 */
function movingActions(row: InboxRowInput): RowActions | null {
  const proposal = openProposal(row);
  if (proposal?.initiatorRole === "CONSULTANT") {
    return { primary: null, secondary: [{ kind: "withdraw-proposal" }] };
  }
  if (proposal) {
    return {
      primary:
        proposal.proposedTimes.length > 0
          ? { kind: "accept-proposal" }
          : { kind: "place-new-time" },
      secondary: [{ kind: "keep-original" }],
    };
  }
  if (row.rescheduledSlotCount > 0) {
    return { primary: { kind: "place-new-time" }, secondary: [] };
  }
  return null;
}

/** ONE primary action per row, mirroring the detail page's needs-you CTA. */
export function rowActions(
  row: InboxRowInput,
  presentation: Pick<BookingPresentation, "bookingState" | "nextAction">,
  now: Date = new Date(),
): RowActions {
  const { bookingState, nextAction } = presentation;
  // The buyer is paying right now; nothing here may race them.
  if (row.checkoutHold) return { primary: null, secondary: [] };
  if (row.kind !== "trial" && row.kind !== "next-cycle") {
    const moving = movingActions(row);
    if (moving) return moving;
  }
  if (row.kind === "next-cycle" || nextAction.kind === "ALLOCATE") {
    return { primary: { kind: "allocate-next" }, secondary: [] };
  }
  // A trial never waits on the expert; a paid one awaiting payment shows its countdown only.
  if (row.kind === "trial") return { primary: null, secondary: [] };
  if (
    nextAction.kind === "APPROVE_OR_DECLINE" &&
    row.requestedStartPassed &&
    answerableProposal(row) === null
  ) {
    return {
      primary: { kind: "propose-times" },
      secondary: [{ kind: "decline" }],
    };
  }
  if (nextAction.kind === "APPROVE_OR_DECLINE") {
    const requested =
      answerableProposal(row) !== null || isDialogFreeApproval(row);
    return {
      primary: {
        kind: "approve",
        mode:
          requested && row.requiredSlots !== null ? "requested" : "allocate",
      },
      secondary: [{ kind: "decline" }],
    };
  }
  // The awaiting-payment row derives remind / withdraw from the state too.
  const kind: string = nextAction.kind;
  if (
    kind === "REMIND_OR_WITHDRAW" ||
    bookingState.state === "AWAITING_PAYMENT"
  ) {
    return {
      primary:
        row.reminderExpiresAt && toStampDate(row.reminderExpiresAt) > now
          ? { kind: "remind" }
          : null,
      secondary: [{ kind: "withdraw" }],
    };
  }
  return { primary: null, secondary: [] };
}

/** One line, one time, always with its zone: the consultee is often in another one (#1705). */
export function formatDateTime(
  value: Date | string,
  viewer: ViewerZone,
): string {
  const date = toStampDate(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return `${formatInViewerZone(date, viewer.zone, "EEE d MMM, h:mm a")} ${zoneLabel(date, viewer.zone)}`;
}

/** "2d left" / "18h 40m left" / "5m left" / "Past due". */
function countdownText(minutesLeft: number, isExpired: boolean): string {
  if (isExpired) return "Past due";
  const h = Math.floor(minutesLeft / 60);
  const m = minutesLeft % 60;
  if (h >= 48) return `${Math.floor(h / 24)}d left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${Math.max(m, 1)}m left`;
}

/** The row's clock as a chip; "Past due" once it has passed. */
function Countdown({ deadline }: Readonly<{ deadline: Date }>) {
  const { minutesLeft, isExpired } = useHoldCountdown(deadline);
  const text = countdownText(minutesLeft, isExpired);
  return (
    // #1527 QA — the server and the hydrating browser read the clock seconds
    // apart, so the minute can differ (#418); the interval corrects it.
    <span
      suppressHydrationWarning
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium tabular-nums",
        isExpired
          ? "text-red-700 dark:text-red-400"
          : "text-amber-800 dark:text-amber-300",
      )}
    >
      <Timer className="h-3.5 w-3.5" aria-hidden />
      {text}
    </span>
  );
}

/**
 * The ONE money line, always with an amount: the derivation's plan arithmetic
 * when it has one, its own line once money moved, else the plan price in
 * front of its not-due sentence; a free trial says so (QA #1783 case 2).
 */
export function moneyLine(
  row: Pick<InboxRowInput, "kind" | "amountPaise" | "currency">,
  moneyState: Pick<MoneyState, "state" | "line" | "detail">,
): string {
  if (moneyState.detail) return moneyState.detail;
  if (moneyState.state === "FREE") {
    return row.kind === "trial" ? FREE_TRIAL_LABEL : moneyState.line;
  }
  if (moneyState.state === "NOT_DUE" && row.amountPaise !== null) {
    return `${formatCurrencyAmount(row.amountPaise, row.currency)} · ${moneyState.line}`;
  }
  if (row.kind === "trial" && row.amountPaise === null) return FREE_TRIAL_LABEL;
  return moneyState.line;
}

/** The "when" line: the requested time, the cycle heading, or the trial length. */
function whenLine(row: InboxRowInput, viewer: ViewerZone): string {
  if (row.kind === "next-cycle" && row.entitlement) {
    return subscriptionCycleHeading(reviveEntitlement(row.entitlement), {
      zone: viewer.zone,
    });
  }
  if (row.kind === "subscription" && row.entitlement) {
    return requestCountLine({ entitlement: row.entitlement });
  }
  const live = row.slots.filter((s) => s.completionStatus !== "RESCHEDULED");
  if (live.length > 0) {
    const first = formatDateTime(live[0].startsAt, viewer);
    return live.length > 1 ? `${first} +${live.length - 1} more` : first;
  }
  if (row.kind === "trial" && row.trial) {
    return `Pick a time · ${row.trial.durationMinutes} min`;
  }
  if (row.schedulingPeriod) {
    return `${formatInViewerZone(toStampDate(row.schedulingPeriod.start), viewer.zone, "d MMM")} – ${formatInViewerZone(toStampDate(row.schedulingPeriod.end), viewer.zone, "d MMM yyyy")}`;
  }
  return "No time named";
}

/** Who asked to move the booking, and to what; null when nothing is open. */
export function proposalLine(
  row: InboxRowInput,
  viewer: ViewerZone,
): string | null {
  const proposal = openProposal(row);
  if (!proposal) return null;
  const [first, ...rest] = proposedSessionsOf(proposal.proposedTimes);
  const times = first
    ? `${formatDateTime(first.startsAt, viewer)}${rest.length > 0 ? ` +${rest.length} more` : ""}`
    : null;
  if (proposal.initiatorRole === "CONSULTANT") {
    return times
      ? `You asked to move this to ${times} · waiting for ${row.requester.name}`
      : "You released this session without times · withdraw it, then propose new times";
  }
  return times
    ? `${row.requester.name} asked to move · proposed ${times}`
    : `${row.requester.name} asked to move · any time works — you pick`;
}

/** JSON turned the cycle window into strings; the heading wants Dates. */
function reviveEntitlement(e: NonNullable<InboxRowInput["entitlement"]>) {
  return {
    ...e,
    planEndsAt: toStampDate(e.planEndsAt),
    cycle: {
      ...e.cycle,
      windowStart: toStampDate(e.cycle.windowStart),
      windowEnd: toStampDate(e.cycle.windowEnd),
    },
  };
}

export interface InboxRowProps {
  row: InboxRowInput;
  viewer: ViewerZone;
  selectable: boolean;
  selected: boolean;
  busy: boolean;
  /** "Remind sent · next in N h" after a reminder went out. */
  note?: string | null;
  /** The clock the words are derived at; a pin passes a fixed one. */
  now?: Date;
  /** `?focus=<id>` — the row a breadcrumb or link pointed at. */
  focused?: boolean;
  onSelect: (checked: boolean) => void;
  onAction: (action: RowAction) => void;
}

/** 44 px targets on the phone (WCAG 2.5.5), compact from sm. */
const TOUCH = "min-h-11 sm:min-h-8";

export function InboxRow({
  row,
  viewer,
  selectable,
  selected,
  busy,
  note,
  now,
  focused = false,
  onSelect,
  onAction,
}: Readonly<InboxRowProps>) {
  const presentation = deriveBookingPresentation(
    row.presentation,
    "CONSULTANT",
    { now, viewerZone: viewer.zone },
  );
  const { bookingState, moneyState } = presentation;
  useRerenderAfter(row.reminderExpiresAt);
  const actions = rowActions(row, presentation, now);
  const badge = row.checkoutHold
    ? CHECKOUT_HOLD_BADGE
    : row.kind === "next-cycle"
      ? NEXT_CYCLE_BADGE
      : toneBadge(bookingState.tone, bookingState.label);
  const deadline = row.deadline ? toStampDate(row.deadline) : null;
  const showCountdown =
    deadline !== null && row.kind !== "next-cycle" && !row.requestedStartPassed;
  const isDesktop = useIsDesktop();
  const [sheetOpen, setSheetOpen] = useState(false);

  // #1775 C-5 — "Schedule cycle 1" / "Schedule the next N" from the derivation.
  const labelFor = (action: RowAction): string =>
    action.kind === "allocate-next" &&
    presentation.nextAction.kind === "ALLOCATE"
      ? presentation.nextAction.label
      : ACTION_LABEL[action.kind];

  const linkFor = (action: RowAction): string | null => {
    if (
      action.kind === "allocate-next" ||
      action.kind === "propose-times" ||
      action.kind === "place-new-time"
    ) {
      return row.hrefs.allocate;
    }
    if (action.kind === "approve" && action.mode === "allocate") {
      return row.hrefs.allocate;
    }
    return null;
  };

  const renderAction = (
    action: RowAction,
    variant: "default" | "outline" | "ghost",
  ) => {
    const href = linkFor(action);
    const className = cn(
      TOUCH,
      isDestructive(action) &&
        variant === "ghost" &&
        "text-destructive hover:bg-destructive/10 hover:text-destructive",
    );
    if (href) {
      return (
        <Button asChild size="sm" variant={variant} className={className}>
          <Link href={href}>{labelFor(action)}</Link>
        </Button>
      );
    }
    return (
      <Button
        size="sm"
        variant={variant}
        className={className}
        disabled={busy}
        onClick={() => {
          setSheetOpen(false);
          onAction(action);
        }}
      >
        {labelFor(action)}
      </Button>
    );
  };

  const moreButton = (onClick?: () => void) => (
    <Button
      variant="ghost"
      size="sm"
      className={TOUCH}
      aria-label={`More actions for ${row.requester.name}`}
      disabled={busy}
      onClick={onClick}
    >
      <MoreHorizontal className="h-4 w-4" aria-hidden />
    </Button>
  );
  const desktopMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{moreButton()}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.secondary.map((action) => (
          <DropdownMenuItem
            key={action.kind}
            className={cn(
              isDestructive(action) &&
                "text-destructive focus:text-destructive",
            )}
            onSelect={() => onAction(action)}
          >
            {ACTION_LABEL[action.kind]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  // Below sm the secondary actions live in a bottom sheet (#1775).
  const mobileSheet = (
    <ResponsiveModal open={sheetOpen} onOpenChange={setSheetOpen}>
      {moreButton(() => setSheetOpen(true))}
      <ResponsiveModalContent>
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>
            {row.requester.name} · {row.planTitle}
          </ResponsiveModalTitle>
        </ResponsiveModalHeader>
        <div className="flex flex-col gap-2">
          {actions.primary && renderAction(actions.primary, "default")}
          {actions.secondary.map((action) => (
            <span key={action.kind} className="contents">
              {renderAction(action, "ghost")}
            </span>
          ))}
        </div>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
  const hasSecondary = actions.secondary.length > 0;
  const menuForViewport = isDesktop ? desktopMenu : mobileSheet;
  const secondaryMenu = hasSecondary ? menuForViewport : null;

  return (
    <li
      className={cn(
        "flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-4",
        selected && "bg-muted/40",
        focused && "ring-2 ring-inset ring-primary/40",
      )}
      id={`request-${row.id}`}
      data-row-id={row.id}
      data-kind={row.kind}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {selectable ? (
          <Checkbox
            className="mt-1 h-5 w-5 sm:h-4 sm:w-4"
            checked={selected}
            disabled={busy}
            onCheckedChange={(checked) => onSelect(checked === true)}
            aria-label={`Select ${row.requester.name}'s request for batch approval`}
          />
        ) : (
          <span className="mt-1 h-4 w-4 shrink-0" aria-hidden />
        )}
        {row.requester.image ? (
          <Image
            src={row.requester.image}
            alt=""
            width={32}
            height={32}
            className="h-8 w-8 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
            <User className="h-4 w-4 text-muted-foreground" aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium text-foreground">
              {row.requester.name}
            </span>
            <span className="text-xs text-muted-foreground">
              {KIND_LABEL[row.kind]} · {row.planTitle}
            </span>
            <span className="sm:hidden">
              <StatusBadge {...badge} size="sm" />
            </span>
          </div>
          <p className="mt-0.5 truncate text-sm text-foreground">
            {row.kind === "next-cycle" && row.entitlement
              ? nextCycleLine(row.entitlement)
              : whenLine(row, viewer)}
          </p>
          <p
            className="truncate text-xs text-muted-foreground"
            data-money-line="true"
          >
            {moneyLine(row, moneyState)}
          </p>
          {row.requestNotes?.trim() ? (
            <p
              className="truncate text-xs italic text-muted-foreground"
              title={row.requestNotes.trim()}
            >
              &ldquo;{row.requestNotes.trim()}&rdquo;
            </p>
          ) : null}
          {proposalLine(row, viewer) && (
            <p className="text-xs text-muted-foreground">
              {proposalLine(row, viewer)}
            </p>
          )}
          {row.checkoutHold && (
            <p className="text-xs text-muted-foreground">
              {CHECKOUT_HOLD_LINE}
            </p>
          )}
          {row.requestedStartPassed && (
            <p className="text-xs font-medium text-red-700 dark:text-red-400">
              {REQUESTED_TIME_PASSED}
            </p>
          )}
          {note && (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {note}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 pl-7 sm:pl-0">
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline-flex">
            <StatusBadge {...badge} size="sm" />
          </span>
          {showCountdown && deadline && <Countdown deadline={deadline} />}
        </div>
        <div className="flex items-center gap-1.5">
          {actions.primary && renderAction(actions.primary, "default")}
          {secondaryMenu}
        </div>
      </div>
    </li>
  );
}
