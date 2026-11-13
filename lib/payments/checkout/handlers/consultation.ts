// Creates the consultation request, its one occurrence and both seats, in
// the checkout transaction.

import { recordParticipants } from "@/lib/booking/participants";
import { appendCreationHistory } from "@/lib/booking/transitions";
import { assertExpertTakesDirectCheckout } from "@/lib/booking/booking-rule-error";
import type { Tx } from "@/lib/prisma";
import type { CheckoutInput } from "@/schemas/checkout";
import { AppointmentsType, AppointmentStatus } from "@prisma/client";
import { buildOccurrenceForWindow } from "@/lib/appointments/occurrences";
import { validateSlotAvailability } from "@/lib/payments/checkout/occupancy-validate";

export async function handleConsultationCheckout(
  tx: Tx,
  data: CheckoutInput,
  consulteeProfileId: string,
  userId: string,
  skipPayment: boolean,
  /**
   * Resolved org context for this checkout (already validated by caller).
   * Passed through to `Appointment.organizationId` so the org dashboard's
   * `/api/organizations/[orgId]/appointments` query (which filters by
   * `Appointment.organizationId`) actually surfaces fresh org-funded
   * bookings. Without this stamp, only the `Payment` row carried the org
   * tag — leaving the appointment invisible to org admins until backfill.
   *
   * Issue: #674 (personal vs org scope split). The runtime-stamping gap
   * was flagged in the May 2026 production-readiness audit.
   */
  organizationId: string | null,
  /**
   * #1499 — the CancellationPolicy version this sale is governed by, resolved once
   * by the caller so every appointment of one checkout cites the same row.
   */
  cancellationPolicyId: string,
  paymentOrganizationId: string | null = organizationId,
) {
  const plan = await tx.consultationPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: {
        include: { user: true },
      },
    },
  });

  if (!plan) {
    throw new Error("Consultation plan not found");
  }
  // A switch flipped while the order was minted refuses here; the abort tombstones that order.
  assertExpertTakesDirectCheckout("CONSULTATION", plan.consultantProfile);

  // userId is the consultee's user ID (passed by caller — no extra DB lookup needed)
  const consultantUserId = plan.consultantProfile.user.id;
  const consulteeUserId = userId;

  // Validate slot availability
  // FIX: Pass consultant user ID to filter by consultant
  // #1463 — the buyer's User id, which is what `Payment.userId` holds.
  await validateSlotAvailability(
    tx,
    data,
    consulteeUserId,
    consultantUserId,
    paymentOrganizationId,
    plan.consultantProfile.id,
  );

  // Create consultation
  const initialStatus = skipPayment
    ? AppointmentStatus.APPROVED
    : AppointmentStatus.PENDING;
  const consultation = await tx.consultation.create({
    data: {
      consultationPlanId: plan.id,
      status: initialStatus,
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
      agreedPricePaise: plan.price,
    },
  });

  // One occurrence with the real end (#1554); both parties are seated on the
  // appointment's participant rows below, which the user-scoped filter in
  // validateNoConflicts reads. #1319 — shared with the webhook capture
  // fallback so the two creators cannot drift.
  const occurrence = buildOccurrenceForWindow({
    startsAt: new Date(data.startsAt!),
    endsAt: new Date(data.endsAt!),
    // #440 — denormalized for the DB-level overlap guard.
    consultantProfileId: plan.consultantProfileId,
    isTentative: !skipPayment,
  });

  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      organizationId,
      // B1/#1499 — freeze the refund terms at booking by pointing at the immutable
      // policy version; the cancel flow reads it back through this FK.
      cancellationPolicyId,
      occurrences: { create: occurrence },
    },
  });
  // #1319 A9 / #1554 — the roster, same tx as the occurrence create.
  await recordParticipants(
    tx,
    appointment.id,
    [
      { userId: consultantUserId, role: "CONSULTANT" },
      { userId: consulteeUserId, role: "CONSULTEE" },
    ],
    { organizationId, status: skipPayment ? "CONFIRMED" : "HELD" },
  );
  // #1333 — the opening timeline row, written here rather than left to the
  // first CAS so a booking that has not moved yet still has a story. Same tx as
  // the create: a consultation that exists always has one.
  await appendCreationHistory(
    tx,
    "CONSULTATION",
    consultation.id,
    initialStatus,
    { appointmentId: appointment.id, actorUserId: userId, organizationId },
  );

  return { appointment, plan, amount: plan.price };
}
