"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import { OperatorTime } from "@/lib/time/operator-time";
import { humanizeEnum } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";
import { sessionShareOf } from "@/lib/booking/entitlement";
import { ReasonAction } from "./ReasonAction";
import {
  rupeesToPaise,
  type CaseResolution,
  type RunCaseAction,
} from "./resolution-data";

type Recommendation = CaseResolution["recommendations"][number];
type PlanRefund = NonNullable<CaseResolution["planRefund"]>;

/** Whole sessions typed into the box, within what the plan can still give back. */
function parseSessions(text: string, plan: PlanRefund): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const sessions = Number(text.trim());
  return sessions >= 1 && sessions <= plan.removable ? sessions : null;
}

/** The plain per-session sum staff see before recommending. */
function sessionRefundCopy(
  plan: PlanRefund,
  sessions: number,
  amountPaise: number,
) {
  const each = inr(Math.floor(plan.amountPaise / plan.sessionsTotal));
  const capped =
    amountPaise < sessionShareOf(plan.amountPaise, sessions, plan.sessionsTotal)
      ? ` (capped at the ${inr(plan.refundablePaise)} still refundable)`
      : "";
  const left = plan.sessionsTotal - plan.sessionsRefunded - sessions;
  return `${sessions} of ${plan.sessionsTotal} sessions × about ${each} each = ${inr(amountPaise)}${capped}. These sessions come off the plan when the refund is approved; ${left} stay on it.`;
}

/** Mirrors the server's send grace: an approval this recent may still be sending its refund. */
const REFUND_SEND_GRACE_MS = 15 * 60 * 1000;

const Preview = z.object({
  data: z.object({
    refundablePaise: z.number(),
    amountPaise: z.number(),
    rail: z.string(),
    blockedReason: z.string().nullable(),
    /** Plain copy for a remedy that moves no money, e.g. a 100% discount booking. */
    note: z.string().nullable(),
    committedPaise: z.number(),
  }),
});
type RefundPreview = z.infer<typeof Preview>["data"] & {
  recommendationId: string;
};

const when = (iso: string) => <OperatorTime value={iso} />;
const inr = (paise: number) => formatCurrencyAmount(paise, "INR");

/** An approved remedy with no live refund: it failed, was cancelled, or never started. */
export function unsentRefund(rec: Recommendation, now: number): boolean {
  if (!rec.approved || rec.voidedAt) return false;
  if (rec.refund) return ["FAILED", "CANCELLED"].includes(rec.refund.status);
  return (
    rec.decidedAt !== null &&
    now - new Date(rec.decidedAt).getTime() >= REFUND_SEND_GRACE_MS
  );
}

/** The line under the sessions box: the sum, the allowed range, or what it is for. */
function sessionsHint(
  plan: PlanRefund,
  sessions: number | null,
  amountPaise: number | null,
  bySessions: boolean,
): string {
  if (plan.removable === 0)
    return "Nothing is left to refund by session count on this plan.";
  if (sessions !== null && amountPaise !== null)
    return sessionRefundCopy(plan, sessions, amountPaise);
  if (bySessions)
    return `Enter 1 to ${plan.removable}: only sessions not yet booked or delivered can be refunded.`;
  return "Refund missed sessions by count, or leave this empty and enter an amount for a money-only refund.";
}

function removesLabel(sessionsRemoved: number | null): string {
  if (!sessionsRemoved) return "";
  const noun = sessionsRemoved === 1 ? "session" : "sessions";
  return ` · Removes ${sessionsRemoved} ${noun} from the plan`;
}

/** A void gives back the plan sessions a session-count remedy removed. */
function voidSessionsNote(sessionsRemoved: number | null): string {
  if (!sessionsRemoved) return "";
  return sessionsRemoved === 1
    ? " 1 session goes back to the plan."
    : ` ${sessionsRemoved} sessions go back to the plan.`;
}

function heldEarningsLabel(count: number) {
  if (count === 0) return "No unpaid earnings to hold";
  return count === 1
    ? "1 unpaid earning held"
    : `${count} unpaid earnings held`;
}

function recommendationStatus(rec: Recommendation): React.ReactNode {
  if (rec.voidedAt) return <>Voided {when(rec.voidedAt)}</>;
  if (!rec.decidedAt) return "Awaiting review";
  if (!rec.approved) return "Declined";
  return rec.refund
    ? `Approved · Refund ${humanizeEnum(rec.refund.status).toLowerCase()}`
    : "Approved · Refund not sent yet";
}

function VoidDialog({
  rec,
  busy,
  onClose,
  run,
}: Readonly<{
  rec: Recommendation | null;
  busy: boolean;
  onClose: () => void;
  run: RunCaseAction;
}>) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  return (
    <AlertDialog
      open={rec !== null}
      onOpenChange={(open) => {
        if (!open) {
          setReason("");
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Void this approved refund?</AlertDialogTitle>
          <AlertDialogDescription>
            {rec &&
              `${inr(rec.amountPaise)} will not be retried. No money moves; the approval is withdrawn and recorded on the case.${voidSessionsNote(rec.sessionsRemoved)}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label htmlFor={reasonId} className="text-sm font-medium">
          Reason for voiding
        </label>
        <Textarea
          id={reasonId}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why this refund should not be sent"
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={busy || !reason.trim()}
            onClick={() => {
              if (rec)
                run(
                  {
                    action: "VOID_RECOMMENDATION",
                    recommendationId: rec.id,
                    reason: reason.trim(),
                  },
                  () => {
                    setReason("");
                    onClose();
                  },
                );
            }}
          >
            Void refund
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ReviewDialog({
  preview,
  limitPaise,
  busy,
  onClose,
  run,
}: Readonly<{
  preview: RefundPreview | null;
  limitPaise: number | null;
  busy: boolean;
  onClose: () => void;
  run: RunCaseAction;
}>) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const overLimit =
    preview !== null &&
    limitPaise !== null &&
    preview.committedPaise + preview.amountPaise > limitPaise;
  return (
    <AlertDialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open) {
          setReason("");
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Review refund</AlertDialogTitle>
          <AlertDialogDescription>
            {preview &&
              (preview.rail === "CREDITS"
                ? (preview.note ??
                  "Restore the booking's credits in full. No cash refund is sent.")
                : `${inr(preview.amountPaise)} through ${preview.rail}. Current refundable balance: ${inr(preview.refundablePaise)}.`)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {preview !== null && preview.committedPaise > 0 && (
          <p className="text-xs text-muted-foreground">
            Already refunded or committed on this payment:{" "}
            {inr(preview.committedPaise)}.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          If another admin’s approval is required, this creates an approval
          request and the refund waits for their decision.
        </p>
        {preview?.blockedReason && (
          <p role="alert" className="text-sm text-destructive">
            This refund can’t be sent. {preview.blockedReason}.
          </p>
        )}
        {overLimit && limitPaise !== null && (
          <p role="alert" className="text-sm text-destructive">
            This takes the payment past your {inr(limitPaise)} limit. Ask an
            admin to send it.
          </p>
        )}
        <label htmlFor={reasonId} className="text-sm font-medium">
          Refund review reason
        </label>
        <Textarea
          id={reasonId}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="At least 5 characters"
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            disabled={
              busy ||
              overLimit ||
              Boolean(preview?.blockedReason) ||
              reason.trim().length < 5
            }
            onClick={() => {
              if (preview)
                run(
                  {
                    action: "REVIEW_REFUND",
                    recommendationId: preview.recommendationId,
                    approve: true,
                    reason: reason.trim(),
                    expectedRefundablePaise: preview.refundablePaise,
                  },
                  () => {
                    setReason("");
                    onClose();
                  },
                );
            }}
          >
            Confirm refund review
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RecommendForm({
  paymentId,
  plan,
  limitPaise,
  busy,
  run,
}: Readonly<{
  paymentId: string;
  /** Set for a 1:1 plan payment: the refund may be priced in sessions. */
  plan: PlanRefund | null;
  limitPaise: number | null;
  busy: boolean;
  run: RunCaseAction;
}>) {
  const seatId = useId();
  const [amount, setAmount] = useState("");
  const [sessionsText, setSessionsText] = useState("");
  const [reason, setReason] = useState("");
  const [releaseSeat, setReleaseSeat] = useState(false);
  const sessions = plan ? parseSessions(sessionsText, plan) : null;
  const sessionAmount =
    plan && sessions !== null
      ? Math.min(
          sessionShareOf(plan.amountPaise, sessions, plan.sessionsTotal),
          plan.refundablePaise,
        )
      : null;
  const bySessions = plan !== null && sessionsText.trim() !== "";
  const amountPaise = bySessions ? sessionAmount : rupeesToPaise(amount);
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (amountPaise === null) return;
        run(
          {
            action: "RECOMMEND_REFUND",
            paymentId,
            amountPaise,
            reason: reason.trim(),
            releaseSeat,
            ...(bySessions && sessions !== null ? { sessions } : {}),
          },
          () => {
            setAmount("");
            setSessionsText("");
            setReason("");
            setReleaseSeat(false);
          },
        );
      }}
    >
      {plan && (
        <div className="space-y-1">
          <Input
            aria-label="Plan sessions to refund"
            type="number"
            min="1"
            max={plan.removable}
            step="1"
            disabled={plan.removable === 0}
            value={sessionsText}
            onChange={(event) => setSessionsText(event.target.value)}
            placeholder={`Sessions to refund (up to ${plan.removable})`}
          />
          <p className="text-xs text-muted-foreground">
            {sessionsHint(plan, sessions, sessionAmount, bySessions)}
          </p>
        </div>
      )}
      {!bySessions && (
        <>
          <p className="text-xs text-muted-foreground">
            For a booking paid entirely with credits, enter 0 to request full
            credit restoration.
          </p>
          <Input
            aria-label="Recommended refund in rupees"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="Refund amount (₹)"
          />
        </>
      )}
      <Textarea
        aria-label="Reason for the refund recommendation"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why this refund is recommended"
      />
      <div className="flex items-start gap-2">
        <input
          id={seatId}
          type="checkbox"
          className="mt-0.5"
          checked={releaseSeat}
          aria-describedby={`${seatId}-hint`}
          onChange={(event) => setReleaseSeat(event.target.checked)}
        />
        <div>
          <label htmlFor={seatId} className="font-medium">
            Also release the customer&apos;s seat
          </label>
          <p id={`${seatId}-hint`} className="text-xs text-muted-foreground">
            Leave unchecked to refund money only: the customer keeps their seat.
            When checked, the seat is marked refunded once the refund is sent:
            the customer loses access to the sessions and recordings, and a
            class or webinar seat can be booked by someone else. This does not
            cancel the booking or its sessions; use Cancel booking in the
            booking&apos;s Ops panel for that. A booking paid entirely with
            credits always releases the seat when its credits are restored.
          </p>
        </div>
      </div>
      {limitPaise !== null && (
        <p className="text-xs text-muted-foreground">
          You can send up to {inr(limitPaise)} per payment, counted across all
          support refunds on it. Larger amounts must be sent by an admin.
        </p>
      )}
      <Button
        size="sm"
        disabled={busy || !reason.trim() || amountPaise === null}
      >
        Recommend refund
      </Button>
    </form>
  );
}

/** Refund recommendations, their review, retry and void, and payout holds. */
export function FinancialPanel({
  caseId,
  paymentId,
  basePath,
  data,
  busy,
  run,
}: Readonly<{
  caseId: string;
  paymentId?: string;
  basePath: string;
  data: CaseResolution;
  busy: boolean;
  run: RunCaseAction;
}>) {
  const { toast } = useToast();
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [voiding, setVoiding] = useState<Recommendation | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const canMoney = data.canExecuteMoney;
  const now = Date.now();
  const loadPreview = async (recommendationId: string) => {
    setPreviewLoading(true);
    try {
      const response = await fetch(
        `/api/support/cases/${caseId}/recommendations/${recommendationId}/preview`,
      );
      if (!response.ok) await throwSupportError(response, "refund preview");
      setPreview({
        ...Preview.parse(await response.json()).data,
        recommendationId,
      });
    } catch (error) {
      toast({
        title: "Refund preview unavailable",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setPreviewLoading(false);
    }
  };
  return (
    <details>
      <summary className="cursor-pointer font-medium">Financial review</summary>
      <div className="mt-2 space-y-3">
        {data.recommendations.map((rec) => {
          const awaiting = rec.decidedAt ? null : rec.pendingApprovalExpiresAt;
          const unsent = unsentRefund(rec, now);
          return (
            <div
              key={rec.id}
              className="space-y-1 rounded border border-border p-2 text-xs"
            >
              <p>
                {inr(rec.amountPaise)} · {rec.reason}
              </p>
              <p>
                {recommendationStatus(rec)}
                {rec.releaseSeat ? " · Releases the seat" : ""}
                {removesLabel(rec.sessionsRemoved)}
              </p>
              {awaiting && (
                <output className="block space-y-1 rounded border border-border p-2">
                  <span className="block font-medium">
                    Waiting for another admin’s approval
                  </span>
                  <span className="block text-muted-foreground">
                    The refund has not been sent. This request expires{" "}
                    {when(awaiting)}.
                  </span>
                  {data.canVoidRecommendations && (
                    <Link
                      className="underline"
                      href={`${basePath}/money/approvals`}
                    >
                      View money approvals
                    </Link>
                  )}
                </output>
              )}
              <div className="flex flex-wrap gap-2">
                {canMoney && !rec.decidedAt && !awaiting && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || previewLoading}
                    onClick={() => void loadPreview(rec.id)}
                  >
                    Review refund
                  </Button>
                )}
                {canMoney && unsent && rec.refund?.status !== "CANCELLED" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || previewLoading}
                    onClick={() => void loadPreview(rec.id)}
                  >
                    Retry refund
                  </Button>
                )}
                {data.canVoidRecommendations && unsent && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setVoiding(rec)}
                  >
                    Void
                  </Button>
                )}
                {canMoney && !rec.decidedAt && !awaiting && (
                  <ReasonAction
                    label="Decline"
                    confirmLabel="Decline recommendation"
                    minLength={5}
                    busy={busy}
                    onConfirm={(reason, done) =>
                      run(
                        {
                          action: "REVIEW_REFUND",
                          recommendationId: rec.id,
                          approve: false,
                          reason,
                        },
                        done,
                      )
                    }
                  />
                )}
              </div>
            </div>
          );
        })}
        {paymentId && (
          <RecommendForm
            paymentId={paymentId}
            plan={
              data.planRefund?.paymentId === paymentId ? data.planRefund : null
            }
            limitPaise={data.refundLimitPaise}
            busy={busy}
            run={run}
          />
        )}
        {data.holds.map((hold) => (
          <div
            key={hold.id}
            className="space-y-1 rounded border border-border p-2 text-xs"
          >
            <p>
              {hold.reason} ·{" "}
              {hold.releasedAt ? (
                <>Released {when(hold.releasedAt)}</>
              ) : (
                <>Payout held since {when(hold.createdAt)}</>
              )}
            </p>
            {!hold.releasedAt && (
              <p className="text-muted-foreground">
                {heldEarningsLabel(hold.earningsHeld)}
              </p>
            )}
            {data.canManageHolds && !hold.releasedAt && (
              <ReasonAction
                label="Release hold"
                confirmLabel="Release this hold"
                busy={busy}
                onConfirm={(reason, done) =>
                  run({ action: "RELEASE_HOLD", holdId: hold.id, reason }, done)
                }
              />
            )}
          </div>
        ))}
        {data.canManageHolds && paymentId && (
          <ReasonAction
            label="Hold payout"
            confirmLabel="Hold this payout"
            busy={busy}
            onConfirm={(reason, done) =>
              run({ action: "APPLY_HOLD", paymentId, reason }, done)
            }
          />
        )}
        {canMoney && (
          <p className="text-xs text-muted-foreground">
            Reviewing a refund needs a reason of at least 5 characters.
            {data.refundLimitPaise === null
              ? " Refunds over ₹25,000 need another admin’s approval when at least two admins are active."
              : ` You can approve up to ${inr(data.refundLimitPaise)} per payment; an admin sends anything larger.`}
          </p>
        )}
      </div>
      <ReviewDialog
        preview={preview}
        limitPaise={data.refundLimitPaise}
        busy={busy}
        onClose={() => setPreview(null)}
        run={run}
      />
      <VoidDialog
        rec={voiding}
        busy={busy}
        onClose={() => setVoiding(null)}
        run={run}
      />
    </details>
  );
}
