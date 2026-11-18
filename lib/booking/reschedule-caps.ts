/**
 * Per-side reschedule caps, counted from the reschedule requests: every party
 * release opens one and records the sessions it released. A request that
 * moved nothing (withdrawn, or declined or expired with its sessions restored)
 * costs nothing.
 */
import type { RescheduleInitiatorRole } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { countedReleases } from "@/lib/booking/released-sessions";
import { EXPERT_CANCEL_RELIABILITY_LINE } from "@/lib/booking/expert-reliability-rules";

/** Consultee reschedules per session (occurrence ordinal). */
export const MAX_CONSULTEE_RESCHEDULES = 2;
/** Expert-initiated reschedules one booking allows; the next answers 409. */
export const MAX_EXPERT_RESCHEDULES = 2;

/** The 409 EXPERT_RESCHEDULE_CAP sentence: cancel is the way out, and it is recorded. */
export function expertRescheduleCapMessage(kind: "trial" | "booking"): string {
  const used =
    kind === "trial"
      ? "You've already moved this trial once."
      : `You've already rescheduled this booking ${MAX_EXPERT_RESCHEDULES} times.`;
  const refund =
    kind === "trial"
      ? "the learner gets a full refund"
      : "the client is refunded for every session not yet held";
  return `${used} If the time no longer works, cancel it: ${refund}. ${EXPERT_CANCEL_RELIABILITY_LINE}`;
}

/** The 409 for an expert's proposal a rule refused before the client was asked: the rule's reason, then what stands. */
export function expertProposalRefusedMessage(reason: string): string {
  return `${reason} Nothing was sent to your client, and the booking keeps its original time. Pick another time.`;
}

type CapTx = Pick<Tx, "rescheduleRequest">;

export type PriorReschedules = {
  /** Requests on this side that moved sessions. */
  total: number;
  /** How many of them moved each session, by ordinal. */
  byOrdinal: ReadonlyMap<number, number>;
};

export async function priorReschedules(
  tx: CapTx,
  args: { appointmentId: string; role: RescheduleInitiatorRole },
): Promise<PriorReschedules> {
  const releases = await countedReleases(tx, {
    appointmentId: args.appointmentId,
    initiatorRole: args.role,
  });
  const byOrdinal = new Map<number, number>();
  for (const release of releases) {
    for (const ordinal of new Set(release.sessions.map((s) => s.ordinal))) {
      byOrdinal.set(ordinal, (byOrdinal.get(ordinal) ?? 0) + 1);
    }
  }
  return { total: releases.length, byOrdinal };
}

/** Whether the consultee side has already moved any of these sessions to the cap. */
export function consulteeCapReached(
  prior: PriorReschedules,
  ordinals: readonly number[],
): boolean {
  return ordinals.some(
    (ordinal) =>
      (prior.byOrdinal.get(ordinal) ?? 0) >= MAX_CONSULTEE_RESCHEDULES,
  );
}

/** A trial is one session: each side may move it once. */
export const MAX_TRIAL_RESCHEDULES_PER_SIDE = 1;

/** Whether this side has already moved the trial as often as it may. */
export function trialCapReached(prior: PriorReschedules): boolean {
  return prior.total >= MAX_TRIAL_RESCHEDULES_PER_SIDE;
}
