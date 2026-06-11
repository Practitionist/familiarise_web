import type { Tx } from "@/lib/prisma";
/**
 * Central guarded status transitions for the B2C booking lifecycles — the
 * consumer-side sibling of `lib/enterprise/transitions.ts` (#836, #837).
 *
 * Same doctrine (docs/enterprise/70-design-decisions/13-postgres-native-concurrency.md):
 * the allowed-from set is baked into the UPDATE's WHERE clause, so an illegal
 * transition — a capture webhook racing a cancel, a stale consultant tab
 * approving a cancelled request, a double-submitted decline — matches zero
 * rows instead of corrupting state. The WHERE clause is the state machine;
 * app-level pre-checks are only friendly error text.
 *
 * Maps are keyed by TARGET state: `ALLOWED_FROM[to]` lists the only states
 * the row may currently be in. Dependency-light (Prisma types only).
 */
import type {
  ClassStatus,
  Prisma,
  RequestStatus,
  SlotCompletionStatus,
  WebinarStatus,
} from "@prisma/client";

import { IllegalTransitionError } from "@/lib/enterprise/transitions";

//////////////////////////////////////////////// Consultation / Subscription ////////////////////////////////////////////////

// PENDING is the entry state; its only legal re-entry is the payment-link
// expiry/regeneration reset (#836). Reschedule also re-enters PENDING but
// from the wider RESCHEDULABLE_FROM set below — that flow owns its own edge
// because rescheduling a SCHEDULED booking back to PENDING is policy-gated
// (24h window), not a generic transition.
export const REQUEST_ALLOWED_FROM: Record<RequestStatus, RequestStatus[]> = {
  PENDING: ["APPROVED_PENDING_PAYMENT"],
  APPROVED: ["PENDING", "APPROVED_PENDING_PAYMENT"],
  APPROVED_PENDING_PAYMENT: ["PENDING", "APPROVED"],
  SCHEDULED: ["APPROVED", "APPROVED_PENDING_PAYMENT"],
  COMPLETED: ["APPROVED", "SCHEDULED"],
  REJECTED: ["PENDING", "APPROVED_PENDING_PAYMENT"],
  CANCELLED: ["PENDING", "APPROVED", "APPROVED_PENDING_PAYMENT", "SCHEDULED"],
  EXPIRED: ["PENDING", "APPROVED_PENDING_PAYMENT"],
};

// Hoisted from cancel/reschedule routes (#838) so the map is the single
// source of legality. CANCELLED's allowed-from IS the cancellable set.
export const CANCELLABLE_FROM = REQUEST_ALLOWED_FROM.CANCELLED;
export const RESCHEDULABLE_FROM: RequestStatus[] = [
  "PENDING",
  "APPROVED",
  "APPROVED_PENDING_PAYMENT",
  "SCHEDULED",
];

// Allocation re-stamps APPROVED when re-allocating an already-approved event
// (reschedule / in-progress reallocation), so the self-edge is legal THERE
// via `fromIn` — the guard's only job on that path is keeping terminal
// states dead. The PATCH approval path uses the strict map (#836).
export const ALLOCATION_APPROVABLE_FROM: RequestStatus[] = [
  "PENDING",
  "APPROVED_PENDING_PAYMENT",
  "APPROVED",
];

export async function transitionConsultationRequest(
  tx: Pick<Tx, "consultation">,
  args: {
    where: { id: string };
    to: RequestStatus;
    data?: Omit<Prisma.ConsultationUncheckedUpdateManyInput, "requestStatus">;
    /** Narrow or widen the from-set for flow-specific edges (overage-transitions idiom). */
    fromIn?: RequestStatus[];
  },
): Promise<void> {
  const res = await tx.consultation.updateMany({
    where: {
      ...args.where,
      requestStatus: { in: args.fromIn ?? REQUEST_ALLOWED_FROM[args.to] },
    },
    data: { requestStatus: args.to, ...args.data },
  });
  if (res.count === 0) throw new IllegalTransitionError("Consultation", args.to);
}

export async function transitionSubscriptionRequest(
  tx: Pick<Tx, "subscription">,
  args: {
    where: { id: string };
    to: RequestStatus;
    data?: Omit<Prisma.SubscriptionUncheckedUpdateManyInput, "requestStatus">;
    /** Narrow or widen the from-set for flow-specific edges (overage-transitions idiom). */
    fromIn?: RequestStatus[];
  },
): Promise<void> {
  const res = await tx.subscription.updateMany({
    where: {
      ...args.where,
      requestStatus: { in: args.fromIn ?? REQUEST_ALLOWED_FROM[args.to] },
    },
    data: { requestStatus: args.to, ...args.data },
  });
  if (res.count === 0) throw new IllegalTransitionError("Subscription", args.to);
}

//////////////////////////////////////////////// Webinar / Class ////////////////////////////////////////////////

// WebinarStatus and ClassStatus are enum-identical; one map serves both.
// SCHEDULED←SCHEDULED is reschedule re-entry. The sets are deliberately the
// exact complement of the old `notIn: [CANCELLED, COMPLETED]` guards —
// explicit allowed-from is robust against future enum additions (#837).
export const EVENT_ALLOWED_FROM: Record<WebinarStatus, WebinarStatus[]> = {
  SCHEDULED: ["SCHEDULED", "IN_PROGRESS"],
  IN_PROGRESS: ["SCHEDULED"],
  COMPLETED: ["SCHEDULED", "IN_PROGRESS"],
  CANCELLED: ["SCHEDULED", "IN_PROGRESS"],
};
// Type-level proof the two enums stay in lockstep.
export const CLASS_EVENT_ALLOWED_FROM: Record<ClassStatus, ClassStatus[]> =
  EVENT_ALLOWED_FROM;

//////////////////////////////////////////////// SlotOfAppointment ////////////////////////////////////////////////

// A reschedule may re-mark a SCHEDULED or already-RESCHEDULED slot tentative,
// but must never resurrect COMPLETED/CANCELLED history or touch UNVERIFIED
// past sessions (#837 — a COMPLETED past session inside a still-active
// subscription stayed COMPLETED on cancel but was resurrected on reschedule).
export const SLOT_RESCHEDULABLE_FROM: SlotCompletionStatus[] = [
  "SCHEDULED",
  "RESCHEDULED",
];
