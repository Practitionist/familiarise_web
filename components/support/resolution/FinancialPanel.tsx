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
import { formatDateTimeLabel } from "@/lib/time/display";
import { humanizeEnum } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";
import { ReasonAction } from "./ReasonAction";
import {
  rupeesToPaise,
  type CaseResolution,
  type RunCaseAction,
} from "./resolution-data";

type Recommendation = CaseResolution["recommendations"][number];

/** Mirrors the server's send grace: an approval this recent may still be sending its refund. */
const REFUND_SEND_GRACE_MS = 15 * 60 * 1000;

const Preview = z.object({
  data: z.object({
    refundablePaise: z.number(),
    amountPaise: z.number(),
    rail: z.string(),
    blockedReason: z.string().nullable(),
    committedPaise: z.number(),
  }),
});
type RefundPreview = z.infer<typeof Preview>["data"] & {
  recommendationId: string;
};

const when = (iso: string) => formatDateTimeLabel(new Date(iso));
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

function heldEarningsLabel(count: number) {
  if (count === 0) return "No unpaid earnings to hold";
  return count === 1
    ? "1 unpaid earning held"
    : `${count} unpaid earnings held`;
}

function recommendationStatus(rec: Recommendation) {
  if (rec.voidedAt) return `Voided ${when(rec.voidedAt)}`;
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
              `${inr(rec.amountPaise)} will not be retried. No money moves; the approval is withdrawn and recorded on the case.`}
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
                ? "Restore the booking's credits in full. No cash refund is sent."
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
  limitPaise,
  busy,
  run,
}: Readonly<{
  paymentId: string;
  limitPaise: number | null;
  busy: boolean;
  run: RunCaseAction;
}>) {
  const seatId = useId();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [releaseSeat, setReleaseSeat] = useState(false);
  const amountPaise = rupeesToPaise(amount);
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
          },
          () => {
            setAmount("");
            setReason("");
            setReleaseSeat(false);
          },
        );
      }}
    >
      <p className="text-xs text-muted-foreground">
        For a booking paid entirely with credits, enter 0 to request full credit
        restoration.
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
            Also cancel the service (release seat)
          </label>
          <p id={`${seatId}-hint`} className="text-xs text-muted-foreground">
            Leave unchecked to refund money only: the customer keeps their
            booking. When checked, the remaining sessions are cancelled once the
            refund is sent.
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
                {rec.releaseSeat ? " · Cancels the service" : ""}
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
              {hold.releasedAt
                ? `Released ${when(hold.releasedAt)}`
                : `Payout held since ${when(hold.createdAt)}`}
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
