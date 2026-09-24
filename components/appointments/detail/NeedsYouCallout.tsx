"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import { format } from "date-fns";
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
import type { BookingPresentation } from "@/lib/dashboard/money-state";
import {
  allocatedElsewhere,
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
  requestAgainHref: string | null;
  decision?: RequestDecision;
  onHelp: () => void;
  /** Extra content for JOIN / RATE — the existing button or stars. */
  children?: ReactNode;
}

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
  return (
    <section
      aria-label="Needs you"
      className={
        tone === "neutral"
          ? "rounded-2xl border border-zinc-200 bg-zinc-50 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/30 sm:p-5"
          : "rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm dark:border-amber-900/40 dark:bg-amber-900/20 sm:p-5"
      }
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
          <Button variant="ghost" size="sm" onClick={onHelp}>
            <LifeBuoy className="mr-1.5 h-4 w-4" />
            Get help
          </Button>
        </div>
      </div>
    </section>
  );
}

/** "21h 40m left" against the pay link's clock; nothing once it has passed. */
function TimeLeft({ deadline }: { deadline: Date }) {
  const { minutesLeft, isExpired } = useHoldCountdown(deadline);
  if (isExpired) return null;
  const h = Math.floor(minutesLeft / 60);
  const m = minutesLeft % 60;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums text-amber-800 dark:text-amber-300">
      <Timer className="h-3.5 w-3.5" />
      {h > 0
        ? `${h}h ${m}m left`
        : m > 0
          ? `${m}m left`
          : "under a minute left"}
    </span>
  );
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
        toast(allocatedElsewhere());
        decision.onDecided();
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
      if (!result.success)
        throw new Error(result.error || "Failed to allocate slots");
      // #1775 B-9 — an unpaid request is approved, not confirmed: the pay
      // order was minted and the client has the 24 h window to pay.
      toast(
        result.awaitingPayment
          ? {
              title: "Approved — the client has 24 h to pay",
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
  const [reminding, setReminding] = useState(false);
  const [nextAllowedAt, setNextAllowedAt] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const cooling = !!nextAllowedAt && Date.parse(nextAllowedAt) > Date.now();

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
          {deadline && <TimeLeft deadline={deadline} />}
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
      {names.payer} has the payment link
      {deadline ? ` until ${format(deadline, "EEE d MMM HH:mm")}` : ""}.
      {heldLine}
    </Shell>
  );
}

/**
 * #1675 — the primary slot, one action for this role from
 * `presentation.nextAction`. Renders nothing when there is nothing to do.
 */
export function NeedsYouCallout(props: NeedsYouCalloutProps) {
  const {
    presentation,
    names,
    heldCount,
    pending,
    onPay,
    requestAgainHref,
    decision,
    awaitingPayment,
    onHelp,
    children,
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
    // #1775 C-5 — a paid plan waiting for cycle 1 (or its next cycle).
    case "ALLOCATE":
      if (!decision) return null;
      return (
        <Shell
          onHelp={onHelp}
          actions={
            <>
              {deadline && <TimeLeft deadline={deadline} />}
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
      if (!pending) return null;
      const amount = formatCurrencyAmount(
        Number(pending.amount),
        pending.currency,
      );
      return (
        <Shell
          onHelp={onHelp}
          actions={
            <>
              {deadline && <TimeLeft deadline={deadline} />}
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
          {names.consultant} approved. Pay {amount}
          {gstSplit(pending)}
          {deadline ? ` by ${format(deadline, "EEE d MMM HH:mm")}` : ""}
          {heldCount > 0
            ? ` to keep your ${heldCount === 1 ? "held slot" : `${heldCount} held slots`}.`
            : " to confirm the booking."}
        </Shell>
      );
    }
    case "REQUEST_AGAIN":
      return (
        <Shell
          onHelp={onHelp}
          actions={
            requestAgainHref ? (
              <Button size="sm" variant="outline" asChild>
                <Link href={requestAgainHref}>{nextAction.label}</Link>
              </Button>
            ) : null
          }
        >
          {bookingState.state === "PAYMENT_LAPSED"
            ? `Your payment link expired${deadline ? ` on ${format(deadline, "EEE d MMM")}` : ""}.`
            : `${names.consultant} declined this request.`}
        </Shell>
      );
    case "JOIN":
    case "RATE":
      return children ? (
        <Shell onHelp={onHelp} actions={children}>
          {nextAction.kind === "JOIN"
            ? "Your session is open."
            : "How did it go?"}
        </Shell>
      ) : null;
    case "NONE":
      // #1675 (owner decision 2026-09-20) — the consultee's own REQUESTED
      // page had nothing here; that read as the request vanishing. A plain
      // wait line, no button, replaces the silence without inviting an action.
      if (bookingState.state === "REQUESTED") {
        const consultantFirstName = names.consultant.split(" ")[0];
        return (
          <Shell tone="neutral" onHelp={onHelp} actions={null}>
            Waiting for {consultantFirstName} to respond — usually within 48
            hours.
          </Shell>
        );
      }
      return null;
    default:
      return null;
  }
}
