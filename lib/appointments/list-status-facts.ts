import type { Prisma } from "@prisma/client";

import type { BucketInput } from "./bucket";
import { openProposalTarget } from "./consultee-affordances";
import { isUnpaidSeat } from "./status";
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

/** An unpaid pay link was minted at some point: the booking page and the lists read a history-less EXPIRED row by it. */
export function unpaidLinkSeen(
  payments: ReadonlyArray<{
    paymentStatus: string;
    expiresAt?: Date | string | null;
  }>,
): boolean {
  return payments.some((p) => p.paymentStatus !== "SUCCEEDED" && !!p.expiresAt);
}

/** The EXPIRED edge a list read selects, so its row ends for the reason its booking page gives. */
export const expiredEdgeInclude = {
  where: {
    entity: { in: ["CONSULTATION", "SUBSCRIPTION"] },
    toStatus: "EXPIRED",
  },
  orderBy: { createdAt: "desc" },
  take: 1,
  select: { fromStatus: true, toStatus: true, reason: true, createdAt: true },
} satisfies Prisma.Appointment$statusHistoryArgs;

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

const proposalSide = (p: { initiatorRole: string }) =>
  p.initiatorRole === "CONSULTANT"
    ? ("CONSULTANT" as const)
    : ("REQUESTER" as const);

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
        statusHistory?: ReadonlyArray<{
          fromStatus: string;
          toStatus: string;
          reason?: string | null;
          createdAt?: Date | string | null;
        }> | null;
        /** Stamped by the reader from `appointmentsAwaitingDecision`. */
        awaitingDecision?: boolean;
      }
    | null
    | undefined,
  occurrences: OccurrenceVM[],
  /** The list's side and the signed-in user, so an open move knows whose it is. */
  viewer?: { side: "CONSULTANT" | "REQUESTER"; userId?: string | null },
): Pick<
  AppointmentVM,
  | "paid"
  | "payDeadline"
  | "payLapsed"
  | "reschedule"
  | "refunded"
  | "unpaidLinkSeen"
  | "history"
  | "awaitingDecision"
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
  // By the proposer's id once the session is known, else the list's own side.
  let mine: boolean | undefined;
  if (proposal && viewer) {
    mine = viewer.userId
      ? proposal.initiatedById === viewer.userId
      : proposalSide(proposal) === viewer.side;
  }
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
    unpaidLinkSeen: unpaidLinkSeen(payments),
    awaitingDecision: appointment?.awaitingDecision,
    history: appointment?.statusHistory
      ? appointment.statusHistory.map((e) => ({ ...e }))
      : undefined,
    reschedule: proposal
      ? {
          by: proposalSide(proposal),
          mine,
          proposedStartsAt: proposal.proposedTimes[0]?.startsAt ?? null,
          originalStartsAt: original?.startsAt ?? null,
          expiresAt: proposal.expiresAt,
        }
      : null,
  };
}

/** A trial's hold: its own due time, else its order's expiry, and whether it lapsed. */
export function trialHoldFacts(trial: {
  paymentDueAt?: Date | string | null;
  appointment?: Parameters<typeof listStatusFacts>[0];
}): Pick<
  AppointmentVM,
  "paid" | "payDeadline" | "payLapsed" | "awaitingDecision"
> {
  const facts = listStatusFacts(trial.appointment, []);
  return {
    paid: facts.paid,
    awaitingDecision: facts.awaitingDecision,
    payDeadline: trial.paymentDueAt
      ? toDate(trial.paymentDueAt)
      : facts.payDeadline,
    payLapsed: facts.payLapsed,
  };
}

/**
 * Everything `deriveBucket` reads beyond status and sessions, from one booking's
 * facts. Every list and the detail page pass this, so a booking files in one tab
 * everywhere. A trial's hold is its window alone.
 */
export function bucketFactsOf(
  booking: {
    kind: string;
    source?: string | null;
    /** The viewer's own webinar or class seat, when they hold one. */
    seatStatus?: string | null;
  },
  facts: Pick<AppointmentVM, "paid" | "payDeadline" | "payLapsed"> &
    Partial<Pick<AppointmentVM, "reschedule">>,
  now: Date,
): Omit<BucketInput, "status" | "occurrences" | "isUnscheduled"> {
  const holdOpen = holdOpenFrom(facts, now);
  if (booking.kind === "TRIAL") return { kind: booking.kind, now, holdOpen };
  return {
    kind: booking.kind,
    now,
    source: booking.source ?? null,
    holdOpen,
    paid: facts.paid,
    moving: !!facts.reschedule,
    moveMine: facts.reschedule?.mine,
    unpaidSeat: isUnpaidSeat({
      seatStatus: booking.seatStatus,
      paid: facts.paid,
    }),
  };
}
