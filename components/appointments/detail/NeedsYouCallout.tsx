"use client";

import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import { useZonedFormat } from "@/lib/time/zoned-format";
import { BellRing, CreditCard, LifeBuoy, Loader2, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { toast } from "@/components/ui/use-toast";
import type { AllocationAttemptKey } from "@/hooks/scheduling/useScheduling";
import { useHoldCountdown } from "@/hooks/useHoldCountdown";
import { useRerenderAfter } from "@/hooks/useRerenderAfter";
import type { BookingPresentation } from "@/lib/dashboard/money-state";
import {
  allocatedElsewhere,
  alreadyScheduled,
  allocationFailed,
  allocationFailedWithCode,
  requestChangedElsewhere,
  timesConfirmed,
} from "@/lib/scheduling/allocationMessages";
import {
  approveRequestedTimes,
  classifyRequestedConflict,
  declineRequest,
  type DecidableRequest,
} from "@/components/dashboard/shared/requests/request-decision";
import { ApiResponseError } from "@/lib/fetch-helpers";
import { formatCurrencyAmount } from "@/utils/formatting";
import { cn } from "@/utils/tailwind";
import type { RescheduleAnswer } from "@/lib/appointments/reschedule-answer";
import type { RescheduleAnswerControl } from "./RescheduleProposalCard";

/** The consultant's answer to a request, wired to the Requests page's mutations. */
export interface RequestDecision {
  request: DecidableRequest;
  /** Requested times exist to confirm; else Approve sends them to the allocator. */
  canApproveRequestedTimes: boolean;
  allocateHref: string;
  /** Where the Requests page's override path lives, for a refusal. */
  requestsHref: string;
  onDecided: () => void;
}

/**
 * #1775 — the consultant's two actions on an unpaid approval, wired to the
 * remind / withdraw-approval routes by the detail page's mutations. Each
 * resolves on 2xx and throws an `ApiResponseError` otherwise.
 */
export interface AwaitingPaymentActions {
  /** The open pay order's expiry while the remind route would accept; null hides Remind. */
  reminderExpiresAt: string | null;
  remind: () => Promise<{ nextAllowedAt: string }>;
  withdraw: () => Promise<unknown>;
  /** Refetch: the row moved (withdrawn here, or changed elsewhere). */
  onChanged: () => void;
}

export interface NeedsYouCalloutProps {
  presentation: BookingPresentation;
  names: { payer: string; consultant: string };
  heldCount: number;
  awaitingPayment?: AwaitingPaymentActions;
  /** The live pay link's row, for the amount and its GST split. */
  pending: {
    amount: number | string;
    taxAmount: number | string | null;
    currency: string;
  } | null;
  onPay?: () => void;
  /** #1780 E-5 — leave the class with a full refund of the remaining sessions. */
  onExitSeries?: () => Promise<void>;
  decision?: RequestDecision;
  onHelp: () => void;
  /** Extra content for JOIN / RATE — the existing button or stars. */
  children?: ReactNode;
  /** The detail page offers Get help in its own rail, so the banner omits it. */
  embedded?: boolean;
  /** The answers the routes accept from this viewer on an open reschedule. */
  moveAnswers?: {
    answers: RescheduleAnswer[];
    control: RescheduleAnswerControl;
  };
  /** A trial or a pay-first checkout: the learner's own hold, never an approval. */
  payFirst?: "trial" | "checkout" | null;
}

const EmbeddedContext = createContext(false);

function Shell({
  children,
  actions,
  onHelp,
  tone = "warning",
}: {
  children: ReactNode;
  actions: ReactNode;
  onHelp: () => void;
  /** #1675 — REQUESTED asks nothing of this viewer, so it draws neutral, not amber. */
  tone?: "warning" | "neutral";
}) {
  const embedded = useContext(EmbeddedContext);
  const surface =
    tone === "neutral"
      ? "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/30"
      : "border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20";
  return (
    <section
      id="needs-you"
      aria-label="Needs you"
      className={cn(
        "border",
        surface,
        embedded
          ? "scroll-mt-24 rounded-2xl p-4 sm:p-5"
          : "rounded-2xl p-4 shadow-sm sm:p-5",
      )}
    >
      <p
        className={
          tone === "neutral"
            ? "mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400"
            : "mb-2 text-[10px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300"
        }
      >
        Needs you
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-foreground">{children}</div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
          {!embedded && (
            <Button variant="ghost" size="sm" onClick={onHelp}>
              <LifeBuoy className="mr-1.5 h-4 w-4" />
              Get help
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

/** What a countdown's deadline is for: a held slot, a payment, placing sessions, or answering a move. */
type CountdownPurpose = "held" | "pay" | "schedule" | "answer";

/** The time left, worded for its deadline ("Slot held 21h 40m", "21h 40m to schedule"); nothing once it has passed. */
function TimeLeft({
  deadline,
  purpose,
}: {
  deadline: Date;
  purpose: CountdownPurpose;
}) {
  const { minutesLeft, isExpired } = useHoldCountdown(deadline);
  if (isExpired) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums text-amber-800 dark:text-amber-300">
      <Timer className="h-3.5 w-3.5" />
      {countdownLabel(purpose, minutesLeft)}
    </span>
  );
}

function countdownLabel(purpose: CountdownPurpose, minutesLeft: number) {
  const h = Math.floor(minutesLeft / 60);
  const m = minutesLeft % 60;
  let left = "under a minute";
  if (h > 0) left = `${h}h ${m}m`;
  else if (m > 0) left = `${m}m`;
  if (purpose === "held") return `Slot held ${left}`;
  const text = `${left} to ${purpose}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "₹6,000 + 18% GST" from the row's own split; the base alone when there is no tax. */
function gstSplit(
  pending: NonNullable<NeedsYouCalloutProps["pending"]>,
): string {
  const tax = Number(pending.taxAmount ?? 0);
  const base = Number(pending.amount) - tax;
  if (tax <= 0 || base <= 0) return "";
  const pct = Math.round((tax / base) * 100);
  return ` (${formatCurrencyAmount(base, pending.currency)} + ${pct}% GST)`;
}

const APPROVE_FAILED_TITLE = "Couldn't approve this request";

function ApproveOrDecline({
  decision,
  names,
  heldCount,
  deadline,
  onHelp,
}: {
  decision: RequestDecision;
  names: NeedsYouCalloutProps["names"];
  heldCount: number;
  deadline: Date | undefined;
  onHelp: () => void;
}) {
  const format = useZonedFormat();
  const [approving, setApproving] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declining, setDeclining] = useState(false);
  const attemptKeyRef = useRef<AllocationAttemptKey | null>(null);

  const approve = async () => {
    setApproving(true);
    try {
      // No override from here: the Requests page's dialog shows the
      // out-of-hours verdicts and owns "Override and Allocate".
      const result = await approveRequestedTimes(
        decision.request,
        attemptKeyRef,
        false,
      );
      const conflict = classifyRequestedConflict(result);
      if (conflict === "stale") {
        toast(requestChangedElsewhere());
        decision.onDecided();
        return;
      }
      if (conflict === "genuine-conflict") {
        toast(
          decision.request.type === "CONSULTATION"
            ? alreadyScheduled()
            : allocatedElsewhere(),
        );
        decision.onDecided();
        return;
      }
      if (conflict === "stay-open") {
        toast(
          allocationFailedWithCode(
            result.error ?? "Failed to allocate slots",
            result.errorCode,
            APPROVE_FAILED_TITLE,
          ),
        );
        return;
      }
      if (!result.success)
        throw new Error(result.error || "Failed to allocate slots");
      // An unpaid request is approved, not confirmed: the pay order was
      // minted and the client has until the window's end to pay.
      toast(
        result.awaitingPayment
          ? {
              title: result.payExpiresAt
                ? `Awaiting payment — the client has until ${format(result.payExpiresAt, "EEE d MMM HH:mm")} to pay`
                : "Awaiting payment — the client was sent the pay link",
              description: `${names.payer} was sent the payment link; the times are held until it is paid.`,
            }
          : timesConfirmed(),
      );
      decision.onDecided();
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        {
          tags: { subsystem: "client", feature: "scheduling" },
        },
      );
      toast(
        allocationFailed(
          error instanceof Error ? error.message : "Failed to allocate slots",
          APPROVE_FAILED_TITLE,
        ),
      );
    } finally {
      setApproving(false);
    }
  };

  const decline = async () => {
    setDeclining(true);
    try {
      await declineRequest(decision.request);
      toast({
        title: "Request declined",
        description: "The request has been declined.",
      });
      setDeclineOpen(false);
      decision.onDecided();
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        {
          tags: { subsystem: "client" },
        },
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

  const held =
    heldCount > 0 && deadline
      ? ` ${heldCount === 1 ? "The slot is" : `${heldCount} slots are`} held for you until ${format(deadline, "EEE d MMM")}; after that ${heldCount === 1 ? "it is" : "they are"} released.`
      : "";

  return (
    <Shell
      onHelp={onHelp}
      actions={
        <>
          {decision.canApproveRequestedTimes ? (
            <Button
              size="sm"
              disabled={approving || declining}
              onClick={() => void approve()}
            >
              {approving ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : null}
              Approve
            </Button>
          ) : (
            <Button size="sm" asChild>
              <Link href={decision.allocateHref}>Approve and set times</Link>
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={approving || declining}
            onClick={() => setDeclineOpen(true)}
          >
            Decline…
          </Button>
          <AlertDialog
            open={declineOpen}
            onOpenChange={(open) => !declining && setDeclineOpen(open)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Decline this request?</AlertDialogTitle>
                <AlertDialogDescription>
                  {names.payer} will be told you declined, and the held slots
                  are released. This rejects the whole booking request.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={declining}>
                  Keep request
                </AlertDialogCancel>
                <AlertDialogAction
                  className="bg-red-600 text-white hover:bg-red-700"
                  disabled={declining}
                  onClick={(e) => {
                    e.preventDefault();
                    void decline();
                  }}
                >
                  {declining ? "Declining…" : "Decline request"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      }
    >
      {names.payer} is waiting for your answer.{held}
      {!decision.canApproveRequestedTimes && (
        <span className="text-muted-foreground">
          {" "}
          No times were requested — approving sets them.
        </span>
      )}
      <span className="block text-xs text-muted-foreground">
        Times outside your hours?{" "}
        <Link
          href={decision.requestsHref}
          className="underline underline-offset-4"
        >
          Review on the Requests page
        </Link>
        .
      </span>
    </Shell>
  );
}

/** "next in 5 h" against the limiter's own clock; empty once it has passed. */
function nextReminderIn(nextAllowedAt: string, now = Date.now()): string {
  const hours = Math.ceil((Date.parse(nextAllowedAt) - now) / 3_600_000);
  if (!Number.isFinite(hours) || hours <= 0) return "";
  return `next in ${hours} h`;
}

function RemindOrWithdraw({
  actions,
  names,
  heldCount,
  deadline,
  onHelp,
}: Readonly<{
  actions: AwaitingPaymentActions;
  names: NeedsYouCalloutProps["names"];
  heldCount: number;
  deadline: Date | undefined;
  onHelp: () => void;
}>) {
  const format = useZonedFormat();
  const [reminding, setReminding] = useState(false);
  const [nextAllowedAt, setNextAllowedAt] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const cooling = !!nextAllowedAt && Date.parse(nextAllowedAt) > Date.now();
  useRerenderAfter(actions.reminderExpiresAt);
  useRerenderAfter(deadline ?? null);
  const canRemind =
    !!actions.reminderExpiresAt &&
    Date.parse(actions.reminderExpiresAt) > Date.now();
  // The live order Remind reuses names the link's deadline; else the hold's.
  const linkDeadline = actions.reminderExpiresAt
    ? new Date(actions.reminderExpiresAt)
    : deadline;
  const linkExpired =
    !canRemind && !!linkDeadline && linkDeadline.getTime() <= Date.now();

  const remind = async () => {
    setReminding(true);
    try {
      const { nextAllowedAt: next } = await actions.remind();
      setNextAllowedAt(next);
      toast({
        title: "Reminder sent",
        description: `${names.payer} was sent the payment link again.`,
      });
    } catch (error) {
      // 429 carries the limiter's clock: the button cools down on it too.
      const next =
        error instanceof ApiResponseError &&
        error.code === "REMIND_RATE_LIMITED"
          ? (error.body as { nextAllowedAt?: string } | undefined)
              ?.nextAllowedAt
          : undefined;
      if (next) setNextAllowedAt(next);
      toast({
        title: next ? "A reminder was already sent today" : "Couldn't remind",
        description:
          error instanceof Error ? error.message : "Failed to send a reminder",
        variant: next ? "default" : "destructive",
      });
    } finally {
      setReminding(false);
    }
  };

  const withdraw = async () => {
    setWithdrawing(true);
    try {
      await actions.withdraw();
      toast({
        title: "Approval withdrawn",
        description: `The held times are released and ${names.payer} was told.`,
      });
      setWithdrawOpen(false);
      actions.onChanged();
    } catch (error) {
      if (error instanceof ApiResponseError && error.status === 409) {
        toast(requestChangedElsewhere());
        setWithdrawOpen(false);
        actions.onChanged();
        return;
      }
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Couldn't withdraw the approval",
        description:
          error instanceof Error ? error.message : "Failed to withdraw",
        variant: "destructive",
      });
    } finally {
      setWithdrawing(false);
    }
  };

  const busy = reminding || withdrawing;
  let heldLine = "";
  if (heldCount === 1) heldLine = " The slot stays held until then.";
  else if (heldCount > 1)
    heldLine = ` ${heldCount} slots stay held until then.`;
  return (
    <Shell
      onHelp={onHelp}
      actions={
        <>
          {deadline && (
            <TimeLeft
              deadline={deadline}
              purpose={heldCount > 0 ? "held" : "pay"}
            />
          )}
          {canRemind && (
            <Button
              size="sm"
              disabled={busy || cooling}
              onClick={() => void remind()}
            >
              {reminding ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <BellRing className="mr-1.5 h-4 w-4" />
              )}
              {cooling && nextAllowedAt
                ? `Reminder sent · ${nextReminderIn(nextAllowedAt)}`
                : "Remind"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={busy}
            onClick={() => setWithdrawOpen(true)}
          >
            Withdraw approval…
          </Button>
          <AlertDialog
            open={withdrawOpen}
            onOpenChange={(open) => !withdrawing && setWithdrawOpen(open)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Withdraw this approval?</AlertDialogTitle>
                <AlertDialogDescription>
                  The held times are released and the client is told the
                  approval was withdrawn.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={withdrawing}>
                  Keep approval
                </AlertDialogCancel>
                <AlertDialogAction
                  className="bg-red-600 text-white hover:bg-red-700"
                  disabled={withdrawing}
                  onClick={(e) => {
                    e.preventDefault();
                    void withdraw();
                  }}
                >
                  {withdrawing ? "Withdrawing…" : "Withdraw approval"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      }
    >
      {linkExpired ? (
        <>The payment link sent to {names.payer} has expired.</>
      ) : (
        <>
          {names.payer} has the payment link
          {linkDeadline
            ? ` until ${format(linkDeadline, "EEE d MMM HH:mm")}`
            : ""}
          .{heldLine}
        </>
      )}
    </Shell>
  );
}

/** #1780 E-5 — the exit right's confirm; a 409 reads as a refusal toast. */
function ExitSeriesButton({
  label,
  onExit,
}: Readonly<{ label: string; onExit: () => Promise<void> }>) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const exit = async () => {
    setBusy(true);
    try {
      await onExit();
      toast({ title: "You left the series — the refund is on its way" });
      setOpen(false);
    } catch (error) {
      toast({
        title: "Could not leave",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Leave with a full refund
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this class?</AlertDialogTitle>
            <AlertDialogDescription>{label}.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Stay enrolled</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void exit();
              }}
            >
              {busy ? "Leaving…" : "Leave and refund"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * #1675 — the primary slot, one action for this role from
 * `presentation.nextAction`. Renders nothing when there is nothing to do.
 */
export function NeedsYouCallout({
  embedded = false,
  ...props
}: NeedsYouCalloutProps) {
  return (
    <EmbeddedContext.Provider value={embedded}>
      <CalloutBody {...props} />
    </EmbeddedContext.Provider>
  );
}

function CalloutBody(props: Omit<NeedsYouCalloutProps, "embedded">) {
  const format = useZonedFormat();
  const {
    presentation,
    names,
    heldCount,
    pending,
    onPay,
    decision,
    awaitingPayment,
    onHelp,
    children,
    payFirst = null,
  } = props;
  const { nextAction, bookingState } = presentation;
  const deadline = nextAction.deadline;

  switch (nextAction.kind) {
    case "APPROVE_OR_DECLINE":
      if (!decision) return null;
      return (
        <ApproveOrDecline
          decision={decision}
          names={names}
          heldCount={heldCount}
          deadline={deadline}
          onHelp={onHelp}
        />
      );
    case "REMIND_OR_WITHDRAW":
      if (!awaitingPayment) return null;
      return (
        <RemindOrWithdraw
          actions={awaitingPayment}
          names={names}
          heldCount={heldCount}
          deadline={deadline}
          onHelp={onHelp}
        />
      );
    case "EXIT_SERIES":
      if (!props.onExitSeries) return null;
      return (
        <Shell
          onHelp={onHelp}
          actions={
            <ExitSeriesButton
              label={nextAction.label}
              onExit={props.onExitSeries}
            />
          }
        >
          The host has cancelled several sessions of this class, so you may
          leave the series and get the remaining sessions refunded in full.
        </Shell>
      );
    // A void's verdict is still being confirmed, so the sentence stands in for the exit.
    case "EXIT_SERIES_WAITS":
      return (
        <Shell onHelp={onHelp} actions={null} tone="neutral">
          {nextAction.label}
        </Shell>
      );
    // #1775 C-5 — a paid plan waiting for cycle 1 (or its next cycle).
    case "ALLOCATE":
      if (!decision) return null;
      return (
        <Shell
          onHelp={onHelp}
          actions={
            <>
              {deadline && <TimeLeft deadline={deadline} purpose="schedule" />}
              <Button size="sm" asChild>
                <Link href={decision.allocateHref}>{nextAction.label}</Link>
              </Button>
            </>
          }
        >
          {bookingState.why}
        </Shell>
      );
    case "PAY": {
      const amount = pending
        ? `${formatCurrencyAmount(Number(pending.amount), pending.currency)}${gstSplit(pending)}`
        : "";
      const by = deadline ? format(deadline, "EEE d MMM HH:mm") : null;
      let line: string;
      if (payFirst) {
        const what = payFirst === "trial" ? "trial time" : "time";
        line = `Your ${what} is held${by ? ` until ${by}` : ""}. Pay${amount ? ` ${amount}` : ""} to confirm it.`;
      } else {
        const keep =
          heldCount > 0
            ? `to keep your ${heldCount === 1 ? "held slot" : `${heldCount} held slots`}.`
            : "to confirm the booking.";
        line = `Pay${amount ? ` ${amount}` : ""}${by ? ` by ${by}` : ""} ${keep}`;
      }
      return (
        <Shell
          onHelp={onHelp}
          actions={
            <>
              {deadline && (
                <TimeLeft
                  deadline={deadline}
                  purpose={payFirst || heldCount > 0 ? "held" : "pay"}
                />
              )}
              <Button
                size="sm"
                className="bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-600 dark:hover:bg-amber-500"
                onClick={onPay}
                disabled={!onPay}
              >
                <CreditCard className="mr-1.5 h-4 w-4" />
                {nextAction.label}
              </Button>
            </>
          }
        >
          {line}
        </Shell>
      );
    }
    case "RESPOND_TO_MOVE": {
      const move = props.moveAnswers;
      if (!move) return null;
      const { answers, control } = move;
      return (
        <Shell
          onHelp={onHelp}
          actions={
            <>
              {deadline && <TimeLeft deadline={deadline} purpose="answer" />}
              {answers.includes("accept") && (
                <Button
                  size="sm"
                  disabled={control.busy}
                  onClick={() => control.answer("accept")}
                >
                  {control.busy && (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  )}
                  {nextAction.label}
                </Button>
              )}
              {answers.includes("decline") && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={control.busy}
                  onClick={() => control.answer("decline")}
                >
                  Decline…
                </Button>
              )}
            </>
          }
        >
          {bookingState.why}
        </Shell>
      );
    }
    // Nothing to do: the badge's reason line explains, and "Book again" sits in the header.
    case "REQUEST_AGAIN":
      return null;
    case "JOIN":
    case "RATE":
      return children ? (
        <Shell onHelp={onHelp} actions={children}>
          {nextAction.kind === "JOIN"
            ? "Your session is open."
            : "How did it go?"}
        </Shell>
      ) : null;
    // The banner shows only when the viewer must act; a wait is the reason line's job.
    case "NONE":
      return null;
    default:
      return null;
  }
}
