// Seats a registrant on the webinar's shared appointment.

import { seatHoldingParticipant } from "@/utils/scheduling-engine/occupancyPolicy";
import { liveOccurrenceWhere } from "@/lib/appointments/occurrences";
import { recordParticipants } from "@/lib/booking/participants";
import type { Tx } from "@/lib/prisma";
import type { CheckoutInput } from "@/schemas/checkout";
import { AppointmentsType } from "@prisma/client";
import { isUserRegisteredForWebinar } from "@/lib/payments/utils/participants";
import { getWebinarCapacity } from "@/lib/events/capacity";
import { alreadyHeldSeatError } from "@/lib/payments/checkout/seats";

export async function handleWebinarCheckout(
  tx: Tx,
  data: CheckoutInput,
  userId: string,
  _skipPayment: boolean,
  /** #1852 — the org whose money paid for this seat; null for a personal purchase. */
  payerOrganizationId: string | null = null,
) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    // One joined statement inside the Serializable commit, not one per relation.
    relationLoadStrategy: "join",
    include: {
      webinarPlan: {
        include: {
          consultantProfile: true,
        },
      },
      appointment: {
        include: {
          // Live sessions only, earliest first: a moved time leaves a RESCHEDULED row behind.
          occurrences: {
            where: liveOccurrenceWhere,
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

  if (!webinar) {
    throw new Error("Webinar not found");
  }

  const plan = webinar.webinarPlan;
  const consultantUserId = plan.consultantProfile?.userId;
  const capacity = getWebinarCapacity({
    webinar,
    plan,
    excludeUserIds: consultantUserId ? [consultantUserId] : [],
  });

  if (capacity.isFull) {
    // #1757 — a coded refusal (EVENT_FULL, 409), not a fault.
    throw Object.assign(new Error("Webinar is full"), {
      httpStatus: 409,
      code: "EVENT_FULL",
    });
  }

  // FIX Issue #5: Validate webinar is scheduled before allowing booking
  // Prevents slot timing from defaulting to new Date()
  if (!webinar.appointment?.occurrences?.[0]) {
    throw new Error(
      "This webinar has not been scheduled yet. Please wait for the consultant to set a date and time.",
    );
  }

  // Block booking for COMPLETED or CANCELLED webinars
  const blockedStatuses = ["COMPLETED", "CANCELLED"] as const;
  if (
    blockedStatuses.includes(webinar.status as (typeof blockedStatuses)[number])
  ) {
    const message =
      webinar.status === "COMPLETED"
        ? "This webinar has already ended."
        : "This webinar has been cancelled.";
    throw new Error(message);
  }

  // A webinar stays SCHEDULED while it runs: a late joiner may buy until its end time.
  const masterSlot = webinar.appointment.occurrences[0];
  if (masterSlot.endsAt < new Date()) {
    throw new Error(
      "This webinar has already ended. It can no longer accept registrations.",
    );
  }

  // Check if user is already registered for this webinar
  const isAlreadyRegistered = isUserRegisteredForWebinar([webinar], userId);
  if (isAlreadyRegistered) {
    throw alreadyHeldSeatError("WEBINAR");
  }

  // Create or reuse appointment
  let appointment = webinar.appointment;
  if (!appointment) {
    // Webinar appointments are SHARED across registrants — multiple
    // attendees from different orgs can join the same webinar. So we
    // tag with the WebinarPlan owner's org (the event host's org), not
    // the first registrant's booking org. This makes "events we host"
    // discoverable in the org dashboard, and avoids first-registrant-
    // wins org leakage.
    // #1499 — for the same reason no cancellationPolicyId is stamped: one row
    // cannot carry one buyer's terms when several orgs are seated on it. A null
    // FK reads as the platform ladder, which is what whole-event refunds already
    // assume. Org tiers therefore do not reach event seats — a documented
    // limitation, not an oversight.
    appointment = await tx.appointment.create({
      data: {
        appointmentType: AppointmentsType.WEBINAR,
        webinarId: webinar.id,
        organizationId: plan.organizationId ?? null,
      },
      include: {
        occurrences: true,
        participants: {
          where: seatHoldingParticipant(new Date()),
          select: { userId: true },
        },
      },
    });
  }

  // Seat the user on the webinar's appointment.
  // Webinar participants attend the entire session on the consultant's
  // occurrences; the seat is one participant row (#1554), never a new row.
  if (appointment && appointment.occurrences.length > 0) {
    // #1852 — the seat carries its OWN payer org, not the host's: one
    // webinar can seat B2C attendees and members of several orgs, and each
    // org sees, pays for and reports on only its own seats.
    await recordParticipants(
      tx,
      appointment.id,
      [{ userId, role: "CONSULTEE" }],
      {
        status: _skipPayment ? "CONFIRMED" : "HELD",
        organizationId: payerOrganizationId,
      },
    );
    // #1780 row 2 — the seat keeps the refund window it was sold under.
    await tx.appointmentParticipant.updateMany({
      where: { appointmentId: appointment.id, userId },
      data: { refundWindowHours: plan.refundWindowHours },
    });
  }

  return { appointment, plan, amount: plan.price };
}
