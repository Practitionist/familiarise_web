import { openProposalTarget } from "./consultee-affordances";
import { toDate, type AppointmentVM, type OccurrenceVM } from "./view-model";

/**
 * Whether a hold's pay window is open at `now`: false only on evidence (a
 * lapsed payment, a passed deadline), undefined when the read does not say.
 */
export function holdOpenFrom(
  facts: Pick<AppointmentVM, "payDeadline" | "payLapsed">,
  now: Date,
): boolean | undefined {
  if (facts.payLapsed) return false;
  if (facts.payDeadline) return facts.payDeadline.getTime() > now.getTime();
  return undefined;
}

/** A hold lapsed only on evidence: nothing paid, nothing payable open, and a payment that expired or failed. */
export function paymentsLapsed(
  payments: ReadonlyArray<{ paymentStatus: string }>,
): boolean {
  return (
    !payments.some(
      (p) => p.paymentStatus === "SUCCEEDED" || p.paymentStatus === "PENDING",
    ) &&
    payments.some(
      (p) => p.paymentStatus === "EXPIRED" || p.paymentStatus === "FAILED",
    )
  );
}

/** What a list row knows about payment and an open reschedule, for its status chip. */
export function listStatusFacts(
  appointment:
    | {
        id: string;
        payment?: ReadonlyArray<{
          paymentStatus: string;
          expiresAt?: Date | string | null;
          amount?: number | string | bigint;
          currency?: string;
          refunds?: ReadonlyArray<{
            amountPaise: number | string | bigint;
            updatedAt: Date | string;
          }>;
        }> | null;
      }
    | null
    | undefined,
  occurrences: OccurrenceVM[],
): Pick<
  AppointmentVM,
  "paid" | "payDeadline" | "payLapsed" | "reschedule" | "refunded"
> {
  const payments = appointment?.payment ?? [];
  const charged = payments.filter(
    (p) => p.paymentStatus === "SUCCEEDED" && Number(p.amount ?? 0) > 0,
  );
  const landed = charged.flatMap((p) => p.refunds ?? []);
  const refundedPaise = landed.reduce((t, r) => t + Number(r.amountPaise), 0);
  const refundedAt = landed
    .map((r) => toDate(r.updatedAt))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const open = payments
    .filter((p) => p.paymentStatus === "PENDING" && p.expiresAt)
    .map((p) => toDate(p.expiresAt!))
    .sort((a, b) => a.getTime() - b.getTime());
  const proposal = openProposalTarget([appointment])?.proposal;
  const original = occurrences.find(
    (o) => o.isTentative && o.completionStatus === "RESCHEDULED",
  );
  return {
    refunded:
      refundedPaise > 0
        ? {
            paise: refundedPaise,
            currency: charged[0]?.currency ?? "INR",
            at: refundedAt ?? null,
          }
        : null,
    paid: payments.some((p) => p.paymentStatus === "SUCCEEDED"),
    // A read without payments says nothing: an unknown deadline is never a lapse.
    payDeadline: open[0] ?? (appointment?.payment ? null : undefined),
    payLapsed: paymentsLapsed(payments),
    reschedule: proposal
      ? {
          by:
            proposal.initiatorRole === "CONSULTANT"
              ? "CONSULTANT"
              : "REQUESTER",
          proposedStartsAt: proposal.proposedTimes[0]?.startsAt ?? null,
          originalStartsAt: original?.startsAt ?? null,
          expiresAt: proposal.expiresAt,
        }
      : null,
  };
}
