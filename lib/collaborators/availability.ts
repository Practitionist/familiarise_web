import prisma, { type Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

/**
 * AE-2 (#784) — collaborator double-booking guard.
 *
 * A webinar/class co-host commits real time, but co-hosts are NOT slot
 * participants (only the plan owner is denormalized onto SlotOfAppointment),
 * so neither the `slot_no_confirmed_overlap` exclusion constraint nor the
 * owner-scoped availability checks ever see them. Scheduling an event at a time
 * a co-host is already committed elsewhere therefore goes undetected. This guard
 * is called at the event's time-commit so a clash is rejected (→ 409).
 */

export class CollaboratorUnavailableError extends Error {
  constructor(public readonly names: string[]) {
    super(`Co-host(s) unavailable at the selected time: ${names.join(", ")}`);
    this.name = "CollaboratorUnavailableError";
  }
}

/**
 * A co-host's existing commitments: appointments they own, or have ACCEPTED a
 * collaboration on. Mirrors the booked-slots query behind
 * /api/collaborators/[consultantProfileId]/availability.
 */
function commitmentWhere(
  consultantProfileId: string,
): Prisma.AppointmentWhereInput {
  return {
    OR: [
      { consultation: { consultationPlan: { consultantProfileId } } },
      { subscription: { subscriptionPlan: { consultantProfileId } } },
      { webinar: { webinarPlan: { consultantProfileId } } },
      { class: { classPlan: { consultantProfileId } } },
      {
        webinar: {
          webinarPlan: {
            collaborators: { some: { consultantProfileId, status: "ACCEPTED" } },
          },
        },
      },
      {
        class: {
          classPlan: {
            collaborators: { some: { consultantProfileId, status: "ACCEPTED" } },
          },
        },
      },
    ],
  };
}

/**
 * Throws CollaboratorUnavailableError if any ACCEPTED co-host on the plan has a
 * confirmed commitment overlapping [startsAt, endsAt). No-op when the plan has
 * no accepted collaborators. Run inside the scheduling transaction so the read
 * is consistent with the slot write that follows.
 */
export async function assertCollaboratorsAvailable(
  db: Tx | typeof prisma,
  params: {
    planType: "WEBINAR" | "CLASS";
    planId: string;
    startsAt: Date;
    endsAt: Date;
    /** The event's own appointment, excluded so its slots don't self-conflict. */
    excludeAppointmentId?: string | null;
  },
): Promise<void> {
  const { planType, planId, startsAt, endsAt, excludeAppointmentId } = params;

  const collaborators = await db.collaborator.findMany({
    where: {
      status: "ACCEPTED",
      ...(planType === "WEBINAR"
        ? { webinarPlanId: planId }
        : { classPlanId: planId }),
    },
    select: {
      consultantProfileId: true,
      consultantProfile: { select: { user: { select: { name: true } } } },
    },
  });
  if (collaborators.length === 0) return;

  const clashing: string[] = [];
  for (const c of collaborators) {
    const conflict = await db.slotOfAppointment.findFirst({
      where: {
        // Half-open overlap: existing.start < new.end AND existing.end > new.start.
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        isTentative: false,
        ...(excludeAppointmentId
          ? { appointmentId: { not: excludeAppointmentId } }
          : {}),
        appointment: commitmentWhere(c.consultantProfileId),
      },
      select: { id: true },
    });
    if (conflict) {
      clashing.push(c.consultantProfile.user.name ?? c.consultantProfileId);
    }
  }

  if (clashing.length > 0) {
    throw new CollaboratorUnavailableError(clashing);
  }
}
