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
  AppointmentStatus,
  RescheduleRequestStatus,
  SlotCompletionStatus,
  TrialSessionStatus,
  WebinarStatus,
} from "@prisma/client";

import { IllegalTransitionError } from "@/lib/enterprise/transitions";

//////////////////////////////////////////////// Consultation / Subscription ////////////////////////////////////////////////

// PENDING is the entry state; its only legal re-entry is the payment-link
// expiry/regeneration reset (#836). Reschedule also re-enters PENDING but
// from the wider RESCHEDULABLE_FROM set below — that flow owns its own edge
// because rescheduling a SCHEDULED booking back to PENDING is policy-gated
// (24h window), not a generic transition.
export const REQUEST_ALLOWED_FROM: Record<
  AppointmentStatus,
  AppointmentStatus[]
> = {
  PENDING: ["APPROVED_PENDING_PAYMENT"],
  APPROVED: ["PENDING", "APPROVED_PENDING_PAYMENT"],
  APPROVED_PENDING_PAYMENT: ["PENDING", "APPROVED"],
  SCHEDULED: ["APPROVED", "APPROVED_PENDING_PAYMENT"],
  COMPLETED: ["APPROVED", "SCHEDULED"],
  REJECTED: ["PENDING", "APPROVED_PENDING_PAYMENT"],
  CANCELLED: ["PENDING", "APPROVED", "APPROVED_PENDING_PAYMENT", "SCHEDULED"],
  // PR 2c (allocation-resilience money fix) — APPROVED joins EXPIRED's
  // allowed-from: a PAID subscription whose consultant never allocated any
  // session was previously immortal (no sweep cohort could touch it), leaving
  // a buyer paid with nothing scheduled forever. The sweep's cohort is
  // narrowed to APPROVED-with-zero-live-slots, so a legitimately approved
  // booking mid-allocation is untouched; only the abandoned shape expires.
  EXPIRED: ["PENDING", "APPROVED_PENDING_PAYMENT", "APPROVED"],
};

// Hoisted from cancel/reschedule routes (#838) so the map is the single
// source of legality. CANCELLED's allowed-from IS the cancellable set.
export const CANCELLABLE_FROM = REQUEST_ALLOWED_FROM.CANCELLED;
export const RESCHEDULABLE_FROM: AppointmentStatus[] = [
  "PENDING",
  "APPROVED",
  "APPROVED_PENDING_PAYMENT",
  "SCHEDULED",
];

// Allocation re-stamps APPROVED when re-allocating an already-approved event
// (reschedule / in-progress reallocation), so the self-edge is legal THERE
// via `fromIn` — the guard's only job on that path is keeping terminal
// states dead. The PATCH approval path uses the strict map (#836).
export const ALLOCATION_APPROVABLE_FROM: AppointmentStatus[] = [
  "PENDING",
  "APPROVED_PENDING_PAYMENT",
  "APPROVED",
];

export async function transitionConsultationRequest(
  tx: Pick<Tx, "consultation">,
  args: {
    /**
     * Always one row, by id. Extra predicates are the doctrine's own idiom: a
     * condition that must still hold at write time belongs in this WHERE, not
     * in a read-then-write ahead of it (the stale-consultation sweep excludes
     * a request whose payment succeeded after the cohort read this way).
     */
    where: Prisma.ConsultationWhereInput & { id: string };
    to: AppointmentStatus;
    data?: Omit<Prisma.ConsultationUncheckedUpdateManyInput, "status">;
    /** Narrow or widen the from-set for flow-specific edges (overage-transitions idiom). */
    fromIn?: AppointmentStatus[];
  },
): Promise<void> {
  const res = await tx.consultation.updateMany({
    where: {
      ...args.where,
      status: { in: args.fromIn ?? REQUEST_ALLOWED_FROM[args.to] },
    },
    data: { status: args.to, ...args.data },
  });
  if (res.count === 0)
    throw new IllegalTransitionError("Consultation", args.to);
}

export async function transitionSubscriptionRequest(
  tx: Pick<Tx, "subscription">,
  args: {
    /** Same idiom as the consultation helper: extra predicates that must still
     * hold at write time belong in this WHERE, not in a read ahead of it. */
    where: Prisma.SubscriptionWhereInput & { id: string };
    to: AppointmentStatus;
    data?: Omit<Prisma.SubscriptionUncheckedUpdateManyInput, "status">;
    /** Narrow or widen the from-set for flow-specific edges (overage-transitions idiom). */
    fromIn?: AppointmentStatus[];
  },
): Promise<void> {
  const res = await tx.subscription.updateMany({
    where: {
      ...args.where,
      status: { in: args.fromIn ?? REQUEST_ALLOWED_FROM[args.to] },
    },
    data: { status: args.to, ...args.data },
  });
  if (res.count === 0)
    throw new IllegalTransitionError("Subscription", args.to);
}

//////////////////////////////////////////////// Webinar / Class ////////////////////////////////////////////////

// WebinarStatus and ClassStatus are enum-identical; one map serves both.
// SCHEDULED←SCHEDULED is reschedule re-entry. The sets are deliberately the
// exact complement of the old `notIn: [CANCELLED, COMPLETED]` guards —
// explicit allowed-from is robust against future enum additions (#837).
export const EVENT_ALLOWED_FROM: Record<WebinarStatus, WebinarStatus[]> = {
  // Nothing returns to DRAFT: publishing is one-way. Unpublishing is what
  // archivedAt is for, so an offering that has ever been buyable keeps a stable
  // public identity.
  DRAFT: [],
  // Deliberately NOT reachable from DRAFT. This set is what reschedule
  // re-stamps, and a reschedule must never be able to publish an unpublished
  // offering as a side effect. Publishing has its own edge below.
  SCHEDULED: ["SCHEDULED", "IN_PROGRESS"],
  IN_PROGRESS: ["SCHEDULED"],
  COMPLETED: ["SCHEDULED", "IN_PROGRESS"],
  CANCELLED: ["SCHEDULED", "IN_PROGRESS"],
};
// Type-level proof the two enums stay in lockstep.
export const CLASS_EVENT_ALLOWED_FROM: Record<ClassStatus, ClassStatus[]> =
  EVENT_ALLOWED_FROM;

// Publishing is the only way out of DRAFT, and it is one-way: withdrawing a
// published offering is `archivedAt`, not a trip back to DRAFT, so anything
// that was ever buyable keeps a stable public identity.
export const EVENT_PUBLISHABLE_FROM: WebinarStatus[] = ["DRAFT"];

export async function transitionWebinarEvent(
  tx: Pick<Tx, "webinar">,
  args: {
    where: { id: string };
    to: WebinarStatus;
    data?: Omit<Prisma.WebinarUncheckedUpdateManyInput, "status">;
    fromIn?: WebinarStatus[];
  },
): Promise<void> {
  const res = await tx.webinar.updateMany({
    where: {
      ...args.where,
      status: { in: args.fromIn ?? EVENT_ALLOWED_FROM[args.to] },
    },
    data: { status: args.to, ...args.data },
  });
  if (res.count === 0) throw new IllegalTransitionError("Webinar", args.to);
}

export async function transitionClassEvent(
  tx: Pick<Tx, "class">,
  args: {
    where: { id: string };
    to: ClassStatus;
    data?: Omit<Prisma.ClassUncheckedUpdateManyInput, "status">;
    fromIn?: ClassStatus[];
  },
): Promise<void> {
  const res = await tx.class.updateMany({
    where: {
      ...args.where,
      status: { in: args.fromIn ?? CLASS_EVENT_ALLOWED_FROM[args.to] },
    },
    data: { status: args.to, ...args.data },
  });
  if (res.count === 0) throw new IllegalTransitionError("Class", args.to);
}

//////////////////////////////////////////////// SlotOfAppointment ////////////////////////////////////////////////

// A reschedule may re-mark a SCHEDULED or already-RESCHEDULED slot tentative,
// but must never resurrect COMPLETED/CANCELLED history or touch UNVERIFIED
// past sessions (#837 — a COMPLETED past session inside a still-active
// subscription stayed COMPLETED on cancel but was resurrected on reschedule).
export const SLOT_RESCHEDULABLE_FROM: SlotCompletionStatus[] = [
  "SCHEDULED",
  "RESCHEDULED",
];

// #1319 — the completion lifecycle had no CAS at all: Stream webhooks, the
// orphan reconciler and the maintenance drain wrote it with a bare
// `where: { id }`, so a webhook landing after a cancel resurrected a CANCELLED
// slot as COMPLETED (the #837 shape, on the column that gates earnings).
// Keyed by TARGET like REQUEST_ALLOWED_FROM.
export const SLOT_COMPLETION_ALLOWED_FROM: Record<
  SlotCompletionStatus,
  SlotCompletionStatus[]
> = {
  SCHEDULED: ["RESCHEDULED"],
  COMPLETED: ["SCHEDULED", "UNVERIFIED"],
  // COMPLETED → UNVERIFIED is the maintenance drain pulling a session it cut
  // short back for human review when the call-ended webhook landed first.
  // Automated completion (Stream webhooks) passes fromIn: ["SCHEDULED"] so it
  // never lifts a held-for-review slot; only a human does that.
  UNVERIFIED: ["SCHEDULED", "COMPLETED"],
  CANCELLED: ["SCHEDULED", "UNVERIFIED", "RESCHEDULED"],
  RESCHEDULED: ["SCHEDULED", "RESCHEDULED"],
};

/**
 * Two deliberate departures from the five request/event helpers above, both
 * load-bearing: `where` is a full WhereInput because every caller sweeps by
 * appointmentId or a user relation rather than by slot id, and `allowZero`
 * exists because cancel/reschedule sweeps legitimately match zero live rows
 * and must not 409. Returns the matched count so sweeps can report honestly.
 */
export async function transitionSlotCompletion(
  tx: Pick<Tx, "slotOfAppointment">,
  args: {
    where: Prisma.SlotOfAppointmentWhereInput;
    to: SlotCompletionStatus;
    data?: Omit<
      Prisma.SlotOfAppointmentUncheckedUpdateManyInput,
      "completionStatus"
    >;
    fromIn?: SlotCompletionStatus[];
    allowZero?: boolean;
  },
): Promise<number> {
  const res = await tx.slotOfAppointment.updateMany({
    where: {
      ...args.where,
      completionStatus: {
        in: args.fromIn ?? SLOT_COMPLETION_ALLOWED_FROM[args.to],
      },
    },
    data: { completionStatus: args.to, ...args.data },
  });
  if (res.count === 0 && !args.allowZero) {
    throw new IllegalTransitionError("SlotOfAppointment", args.to);
  }
  return res.count;
}

//////////////////////////////////////////////// TrialSession ////////////////////////////////////////////////

// #1319 — trials were the one lifecycle with no helper: accept, reject, cancel,
// auto-complete and convert all wrote `status` bare. The capture webhook and
// the unpaid-expiry sweep already narrowed their updateMany by status; this
// makes the rest match. PENDING is entry-only. Keyed by TARGET.
export const TRIAL_ALLOWED_FROM: Record<
  TrialSessionStatus,
  TrialSessionStatus[]
> = {
  PENDING: [],
  AWAITING_PAYMENT: ["PENDING"],
  SCHEDULED: ["PENDING", "AWAITING_PAYMENT"],
  COMPLETED: ["SCHEDULED"],
  CONVERTED: ["COMPLETED"],
  CANCELLED: ["PENDING", "AWAITING_PAYMENT", "SCHEDULED"],
  REJECTED: ["PENDING"],
};

export async function transitionTrialSession(
  tx: Pick<Tx, "trialSession">,
  args: {
    where: { id: string };
    to: TrialSessionStatus;
    data?: Omit<Prisma.TrialSessionUncheckedUpdateManyInput, "status">;
    fromIn?: TrialSessionStatus[];
  },
): Promise<void> {
  const res = await tx.trialSession.updateMany({
    where: {
      ...args.where,
      status: { in: args.fromIn ?? TRIAL_ALLOWED_FROM[args.to] },
    },
    data: { status: args.to, ...args.data },
  });
  if (res.count === 0)
    throw new IllegalTransitionError("TrialSession", args.to);
}

//////////////////////////////////////////////// Reschedule proposals ////////////////////////////////////////////////

// A proposal is a two-party negotiation with exactly one counter-round, so the
// legal graph is small and every edge is terminal-or-countered. AUTO_ACCEPTED
// has no allowed-from: it is only ever written at creation, when a consultee's
// times land in the consultant's published availability and both calendars are
// free, so there is no state to move out of.
export const RESCHEDULE_ALLOWED_FROM: Record<
  RescheduleRequestStatus,
  RescheduleRequestStatus[]
> = {
  AUTO_ACCEPTED: [],
  PENDING_REVIEW: ["COUNTERED"],
  COUNTERED: ["PENDING_REVIEW"],
  ACCEPTED: ["PENDING_REVIEW", "COUNTERED"],
  DECLINED: ["PENDING_REVIEW", "COUNTERED"],
  WITHDRAWN: ["PENDING_REVIEW", "COUNTERED"],
  EXPIRED: ["PENDING_REVIEW", "COUNTERED"],
};

/** The states in which a proposal is still awaiting an answer. */
export const RESCHEDULE_OPEN_STATUSES: RescheduleRequestStatus[] = [
  "PENDING_REVIEW",
  "COUNTERED",
];

/** Terminal states — the request is answered and holds no claim on its slots. */
export const RESCHEDULE_TERMINAL_STATUSES: RescheduleRequestStatus[] = [
  "AUTO_ACCEPTED",
  "ACCEPTED",
  "DECLINED",
  "WITHDRAWN",
  "EXPIRED",
];

export async function transitionRescheduleRequest(
  tx: Pick<Tx, "rescheduleRequest">,
  args: {
    where: { id: string };
    to: RescheduleRequestStatus;
    data?: Omit<Prisma.RescheduleRequestUncheckedUpdateManyInput, "status">;
    /** Narrow or widen the from-set for flow-specific edges. */
    fromIn?: RescheduleRequestStatus[];
  },
): Promise<void> {
  // Reaching a terminal state also releases openForAppointmentId, so the
  // nullable-unique stops reserving the appointment and a fresh reschedule can
  // open. Callers must not have to remember this.
  const releasesLock = RESCHEDULE_TERMINAL_STATUSES.includes(args.to);
  const res = await tx.rescheduleRequest.updateMany({
    where: {
      ...args.where,
      status: { in: args.fromIn ?? RESCHEDULE_ALLOWED_FROM[args.to] },
    },
    data: {
      status: args.to,
      ...(releasesLock
        ? { openForAppointmentId: null, resolvedAt: new Date() }
        : {}),
      ...args.data,
    },
  });
  if (res.count === 0) {
    throw new IllegalTransitionError("RescheduleRequest", args.to);
  }
}
