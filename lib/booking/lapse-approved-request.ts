import prisma, { type Tx } from "@/lib/prisma";
import {
  AppointmentStatus,
  OccurrenceCompletionStatus,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { Refusal } from "@/lib/errors/refusal";
import { SLOT_TRANSITION_TX_OPTIONS } from "@/lib/booking/slot-release";
import { notifyConsulteeRequestExpired } from "@/lib/booking/expiry-notices";
import {
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

/**
 * #1775 — one approved-but-unpaid request lapsing, whoever asks for it: the
 * 7-day sweep (`PAYMENT_LAPSED`) or the consultant's Withdraw
 * (`WITHDRAWN_BY_CONSULTANT`). The request CAS carries the money predicate in
 * its WHERE, so a capture that already flipped the row through the single
 * writer matches zero rows and nothing below runs. The open pay order is
 * tombstoned by status — Razorpay orders cannot be voided, and a capture that
 * lands on an EXPIRED Payment takes the handler's `captured_after_release`
 * refund arm — and the tentative holds are released by status, never deleted.
 */
export type LapseReason = "PAYMENT_LAPSED" | "WITHDRAWN_BY_CONSULTANT";

export interface LapseApprovedRequestArgs {
  kind: "consultation" | "subscription";
  id: string;
  reason: LapseReason;
  actorUserId: string | null;
}

export type LapseOutcome =
  | { moved: 0; appointmentId: null }
  | { moved: 1; appointmentId: string | null };

// The predicates the sweeps repeat in the CAS WHERE: no succeeded payment on
// the wrapper (#1554 — a subscription may have no wrapper yet).
const UNPAID_CONSULTATION = {
  appointment: {
    payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
  },
} as const;
const UNPAID_SUBSCRIPTION: { OR: Prisma.SubscriptionWhereInput[] } = {
  OR: [
    { appointment: null },
    {
      appointment: {
        payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
      },
    },
  ],
};

type LapseTx = Pick<
  Tx,
  | "consultation"
  | "subscription"
  | "appointment"
  | "appointmentOccurrence"
  | "payment"
  | "bookingStatusHistory"
>;

/** Never throws on a lost CAS: `{ moved: 0 }` and no further write. */
export async function lapseApprovedRequest(
  tx: LapseTx,
  args: LapseApprovedRequestArgs,
): Promise<LapseOutcome> {
  const meta = {
    actorUserId: args.actorUserId,
    reason: args.reason,
    to: AppointmentStatus.EXPIRED,
    fromIn: [AppointmentStatus.APPROVED_PENDING_PAYMENT],
    data: { pendingPaymentUrl: null },
  };
  try {
    if (args.kind === "consultation") {
      await transitionConsultationRequest(tx, {
        ...meta,
        where: { id: args.id, ...UNPAID_CONSULTATION },
      });
    } else {
      await transitionSubscriptionRequest(tx, {
        ...meta,
        where: { id: args.id, ...UNPAID_SUBSCRIPTION },
      });
    }
  } catch (error) {
    if (error instanceof IllegalTransitionError)
      return { moved: 0, appointmentId: null };
    throw error;
  }

  const rel =
    args.kind === "consultation" ? "consultationId" : "subscriptionId";
  const appointment = await tx.appointment.findFirst({
    where: { [rel]: args.id, deletedAt: null },
    select: { id: true },
  });
  if (!appointment) return { moved: 1, appointmentId: null };

  await transitionOccurrenceCompletion(tx, {
    actorUserId: args.actorUserId,
    reason: args.reason,
    where: {
      appointmentId: appointment.id,
      isTentative: true,
      deletedAt: null,
    },
    to: OccurrenceCompletionStatus.CANCELLED,
    data: { deletedAt: new Date() },
    allowZero: true,
  });
  // Only a still-PENDING order expires; a capture that raced this write keeps
  // its SUCCEEDED row (the request CAS above already lost to it).
  await tx.payment.updateMany({
    where: {
      appointmentId: appointment.id,
      paymentStatus: PaymentStatus.PENDING,
    },
    data: { paymentStatus: PaymentStatus.EXPIRED },
  });
  return { moved: 1, appointmentId: appointment.id };
}

// ---------------------------------------------------------------------------
// #1775 — the consultant's Withdraw: the lapse core on ONE row, on command.
// ---------------------------------------------------------------------------

export const WITHDRAWN_BY_CONSULTANT_REASON =
  "The expert withdrew the approval before it was paid, so the held times were released. No payment was taken.";

/** What the routes read: ownership, the wrapper for the lock, the notice's names. */
const WITHDRAW_SELECT = {
  id: true,
  requestedBy: { select: { user: { select: { id: true, name: true } } } },
  appointment: {
    select: {
      id: true,
      organizationId: true,
      occurrences: {
        where: { deletedAt: null },
        orderBy: { startsAt: "asc" as const },
        take: 1,
        select: { startsAt: true },
      },
    },
  },
} as const;
const WITHDRAW_PLAN_SELECT = {
  select: {
    title: true,
    consultantProfileId: true,
    consultantProfile: { select: { user: { select: { name: true } } } },
  },
} as const;

/** Who is asking: the routes build it from the session (auth stays theirs). */
export interface WithdrawActor {
  userId: string;
  consultantProfileId: string | null | undefined;
  privileged: boolean;
}

/** `withAppointmentLock`'s shape, injected: the Redis client behind it does
 *  not load under jsdom, and the sweeps import this module. */
export type AppointmentLock = <T>(
  appointmentId: string,
  fn: () => Promise<T>,
) => Promise<T>;

/** The repo's typed-error convention (lock 423 / 503, IllegalTransition 409). */
function isTypedHttpError(
  error: unknown,
): error is Error & { httpStatus: number; code: string } {
  return (
    error instanceof Error &&
    typeof (error as { httpStatus?: unknown }).httpStatus === "number" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

/**
 * Serialises on the appointment atom, runs the lapse core in one Serializable
 * transaction, and tells the consultee after the commit. Every refusal is a
 * typed `Refusal` the route hands to `apiError`: 404, 403, and 409
 * `REQUEST_CHANGED_ELSEWHERE` for a lost CAS (a capture that flipped the
 * request first through the single writer) — nothing was written then. Lock
 * outcomes keep their 423 / 503 codes. `next/server` and the Redis lock stay
 * out of this module so the sweeps that share the core still load under jsdom.
 */
/** #1775 — the ownership read: the row and its plan, or a 404 / 403 refusal. */
async function readOwnedRequest(
  kind: "consultation" | "subscription",
  id: string,
  actor: WithdrawActor,
) {
  const row =
    kind === "consultation"
      ? await prisma.consultation.findUnique({
          where: { id },
          select: {
            ...WITHDRAW_SELECT,
            consultationPlan: WITHDRAW_PLAN_SELECT,
          },
        })
      : await prisma.subscription.findUnique({
          where: { id },
          select: {
            ...WITHDRAW_SELECT,
            subscriptionPlan: WITHDRAW_PLAN_SELECT,
          },
        });
  if (!row)
    throw new Refusal({
      code: "NOT_FOUND",
      httpStatus: 404,
      userMessage: "This request no longer exists.",
    });
  const plan =
    "consultationPlan" in row ? row.consultationPlan : row.subscriptionPlan;
  const owns =
    !!actor.consultantProfileId &&
    plan?.consultantProfileId === actor.consultantProfileId;
  if (!owns && !actor.privileged)
    throw new Refusal({
      code: "FORBIDDEN",
      httpStatus: 403,
      userMessage:
        "Only the consultant who approved this request can withdraw it.",
    });
  return { row, plan };
}

export async function withdrawApproval(args: {
  kind: "consultation" | "subscription";
  id: string;
  actor: WithdrawActor;
  lock: AppointmentLock;
}): Promise<{ status: "EXPIRED" }> {
  const { row, plan } = await readOwnedRequest(args.kind, args.id, args.actor);

  const run = () =>
    withSerializableRetry(() =>
      prisma.$transaction(
        (tx) =>
          lapseApprovedRequest(tx, {
            kind: args.kind,
            id: args.id,
            reason: "WITHDRAWN_BY_CONSULTANT",
            actorUserId: args.actor.userId,
          }),
        {
          ...SLOT_TRANSITION_TX_OPTIONS,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      ),
    );
  // A subscription may have no wrapper yet (#1554); then there is no atom to
  // contend for and nothing held.
  let moved: 0 | 1;
  try {
    ({ moved } = row.appointment
      ? await args.lock(row.appointment.id, run)
      : await run());
  } catch (error) {
    if (isTypedHttpError(error)) {
      throw new Refusal({
        code: error.code,
        httpStatus: error.httpStatus,
        userMessage: error.message,
      });
    }
    throw error;
  }
  if (moved === 0)
    throw new Refusal({
      code: "REQUEST_CHANGED_ELSEWHERE",
      userMessage: "This request changed elsewhere — it may already be paid.",
      devMessage: `${args.kind} ${args.id} was not APPROVED_PENDING_PAYMENT at write time`,
    });

  // After the commit, like the sweeps: the bell and email ride their outboxes,
  // so a replay of this route cannot ring twice.
  const consultee = row.requestedBy?.user;
  if (row.appointment && consultee) {
    await notifyConsulteeRequestExpired({
      appointmentId: row.appointment.id,
      organizationId: row.appointment.organizationId,
      consulteeUserId: consultee.id,
      consulteeName: consultee.name ?? "Consultee",
      consultantName: plan?.consultantProfile?.user?.name ?? "Consultant",
      planTitle:
        plan?.title ??
        (args.kind === "consultation" ? "Consultation" : "Subscription"),
      appointmentType:
        args.kind === "consultation" ? "CONSULTATION" : "SUBSCRIPTION",
      startsAt: row.appointment.occurrences[0]?.startsAt ?? null,
      reason: WITHDRAWN_BY_CONSULTANT_REASON,
    });
  }
  return { status: "EXPIRED" };
}
