// Seats a learner on the class wrapper, priced for the sessions left.

import { seatHoldingParticipant } from "@/utils/scheduling-engine/occupancyPolicy";
import { recordParticipants } from "@/lib/booking/participants";
import type { Tx } from "@/lib/prisma";
import type { CheckoutInput } from "@/schemas/checkout";
import { isUserEnrolled } from "@/lib/payments/utils/participants";
import { getClassCapacity } from "@/lib/events/capacity";
import { classEnrolmentFrom } from "@/lib/booking/class-enrolment";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import {
  assertClassEnrolmentOpen,
  alreadyHeldSeatError,
  findPriorSeatPayment,
  seatRegistrationFor,
  stampRecordedSeat,
} from "@/lib/payments/checkout/seats";

/**
 * The sessions a seat bought: per ordinal, its live row (a RESCHEDULED row only
 * until it is replaced), kept while not yet started, as classEnrolmentFrom counts.
 */
function sessionsBought<
  T extends {
    ordinal: number | null;
    startsAt: Date;
    completionStatus: string;
  },
>(sessions: T[], remaining: number, now: Date): T[] {
  const byOrdinal = new Map<number, T>();
  for (const session of sessions) {
    const key = session.ordinal ?? session.startsAt.getTime();
    const kept = byOrdinal.get(key);
    if (!kept || kept.completionStatus === "RESCHEDULED") {
      byOrdinal.set(key, session);
    }
  }
  return [...byOrdinal.entries()]
    .filter(
      ([, session]) =>
        session.startsAt > now || session.completionStatus === "RESCHEDULED",
    )
    .sort(([a], [b]) => a - b)
    .map(([, session]) => session)
    .slice(-remaining);
}

export async function handleClassCheckout(
  tx: Tx,
  data: CheckoutInput,
  userId: string,
  _skipPayment: boolean,
  /** #1819 — the sessions the quote priced; null skips the stale-quote check. */
  quotedSessions: number | null = null,
  /** #1852 — the org whose money paid for this seat; null for a personal purchase. */
  payerOrganizationId: string | null = null,
) {
  const classInstance = await tx.class.findUnique({
    where: { id: data.eventId },
    include: {
      classPlan: {
        include: { consultantProfile: true },
      },
      appointment: {
        include: {
          // A RESCHEDULED row is a planned session awaiting its new time, so
          // it still counts toward "fully scheduled" and the engagement
          // meter; only a cancelled or deleted one is gone (#1554).
          occurrences: {
            where: {
              deletedAt: null,
              completionStatus: { not: "CANCELLED" },
            },
            orderBy: { startsAt: "asc" },
          },
          participants: {
            where: seatHoldingParticipant(new Date()),
            select: { userId: true },
          },
        },
      },
    },
  });

  if (!classInstance) {
    throw new Error("Class not found");
  }

  const plan = classInstance.classPlan;
  const consultantUserId = plan.consultantProfile?.userId;
  // #1554 — one wrapper per class; its live occurrences are the sessions.
  const wrapper = classInstance.appointment;
  const sessions = wrapper?.occurrences ?? [];

  const capacity = getClassCapacity({
    classInstance,
    plan,
    excludeUserIds: consultantUserId ? [consultantUserId] : [],
  });

  if (capacity.isFull) {
    // #1757 — a coded refusal (EVENT_FULL, 409), not a fault.
    throw Object.assign(new Error("Class is full"), {
      httpStatus: 409,
      code: "EVENT_FULL",
    });
  }

  // H5 FIX: Validate class hasn't already ended (all sessions past).
  // Similar to webinar validation — prevents booking a class whose last session is over.
  const lastSession = sessions[sessions.length - 1];
  if (lastSession && lastSession.endsAt < new Date()) {
    throw new Error(
      "This class has already ended. It can no longer accept enrollments.",
    );
  }

  // Check if user is already enrolled - OPT-2: Use extracted utility
  if (isUserEnrolled(wrapper, userId)) {
    throw alreadyHeldSeatError("CLASS");
  }

  // B11 — a partially-scheduled class (consultant hasn't allocated every
  // session yet) must not accept paid enrollments: the seat below covers
  // only EXISTING sessions, silently shorting the buyer the rest.
  const expectedSessions = classInstance.classPlan?.totalSessions;
  if (
    typeof expectedSessions === "number" &&
    expectedSessions > 0 &&
    sessions.length < expectedSessions
  ) {
    throw new Error(
      `This class is not fully scheduled yet (${sessions.length} of ${expectedSessions} sessions). Enrollment opens once all sessions are scheduled.`,
    );
  }
  if (!wrapper) {
    throw new Error("No class sessions found");
  }

  // #1819 — re-derived at commit over the quote's rows (cancelled ones too): a
  // session that started since the quote re-prices the order.
  const now = new Date();
  const enrolment = assertClassEnrolmentOpen(
    classEnrolmentFrom({
      pricePaise: plan.price,
      N: plan.totalSessions,
      lateJoinUntilSession: plan.lateJoinUntilSession,
      sessions: await tx.appointmentOccurrence.findMany({
        where: { appointmentId: wrapper.id, deletedAt: null },
        select: { ordinal: true, startsAt: true, completionStatus: true },
      }),
      now,
    }),
  );
  if (quotedSessions !== null && enrolment.remaining !== quotedSessions) {
    throw new BookingRuleError(
      "CLASS_PRICE_CHANGED",
      "A session of this batch started while you were checking out, so its price has changed. Please review the new price and try again. You have not been charged.",
    );
  }

  // Class participants attend every session on the consultant's occurrences;
  // the seat is one participant row on the wrapper (#1554), never new rows.
  // #1852 — the seat carries its own payer org (see handleWebinarCheckout).
  // Read before the revive, which would make a left seat look held again.
  const priorSeat = await findPriorSeatPayment(tx, userId, wrapper.id);
  await recordParticipants(tx, wrapper.id, [{ userId, role: "CONSULTEE" }], {
    status: _skipPayment ? "CONFIRMED" : "HELD",
    organizationId: payerOrganizationId,
    seatRegistration: seatRegistrationFor(priorSeat, userId, "CLASS"),
  });
  // #1780 row 2 — the seat keeps the refund window it was sold under; #1819 —
  // and the sessions it paid for, which fix its refund unit.
  await stampRecordedSeat(tx, {
    appointmentId: wrapper.id,
    userId,
    status: _skipPayment ? "CONFIRMED" : "HELD",
    kind: "CLASS",
    data: {
      refundWindowHours: plan.refundWindowHours,
      sessionsPurchased: enrolment.remaining,
    },
  });

  const boughtSessions = sessionsBought(sessions, enrolment.remaining, now);

  return {
    appointment: wrapper,
    plan,
    amount: enrolment.basePaise,
    sessionsPurchased: enrolment.remaining,
    slotsLinked: sessions.length,
    engagementsConsumed: boughtSessions.length,
    engagementIds: boughtSessions.map((session) => session.id),
    priorSeat,
  };
}
