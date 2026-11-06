import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";

type DeliveringDb = Pick<Tx, "appointment" | "consultantProfile">;

/** A payment that makes its payer and host organization parties to a booking. */
export const CAPTURED_PAYMENT_WHERE = {
  paymentStatus: "SUCCEEDED",
  deletedAt: null,
} as const;

export interface BookingParties {
  /** Consultant seats, plan consultants and accepted PRESENTER collaborators; crew never. */
  deliveringIds: Set<string>;
  /** Accepted PRESENTER collaborators only; crew and the host consultant stay out. */
  presenterIds: Set<string>;
  /** Organizations hosting delivery through the booking's captured payments. */
  hostOrganizationIds: Set<string>;
}

/**
 * The people who deliver each booking, read in two queries for the whole
 * batch. Pure reads: pass `prisma` outside a transaction, `tx` inside one.
 */
export async function deliveringPartiesByAppointment(
  db: DeliveringDb,
  appointmentIds: readonly string[],
): Promise<Map<string, BookingParties>> {
  const result = new Map<string, BookingParties>();
  if (appointmentIds.length === 0) return result;
  const plan = { consultantProfileId: true } as const;
  const groupPlan = {
    ...plan,
    collaborators: {
      where: { status: "ACCEPTED" as const, tier: "PRESENTER" as const },
      select: { consultantProfileId: true },
    },
  };
  const bookings = await db.appointment.findMany({
    where: { id: { in: [...new Set(appointmentIds)] } },
    select: {
      id: true,
      participants: {
        where: {
          role: "CONSULTANT",
          status: { in: ["CONFIRMED", "ATTENDED"] },
        },
        select: { userId: true },
      },
      consultation: { select: { consultationPlan: { select: plan } } },
      subscription: { select: { subscriptionPlan: { select: plan } } },
      webinar: { select: { webinarPlan: { select: groupPlan } } },
      class: { select: { classPlan: { select: groupPlan } } },
      payment: {
        where: CAPTURED_PAYMENT_WHERE,
        select: { hostOrganizationId: true },
      },
    },
  });
  const profileIdsOf = (booking: (typeof bookings)[number]) =>
    [
      booking.consultation?.consultationPlan.consultantProfileId,
      booking.subscription?.subscriptionPlan.consultantProfileId,
      booking.webinar?.webinarPlan.consultantProfileId,
      booking.class?.classPlan.consultantProfileId,
      ...(booking.webinar?.webinarPlan.collaborators ?? []).map(
        (c) => c.consultantProfileId,
      ),
      ...(booking.class?.classPlan.collaborators ?? []).map(
        (c) => c.consultantProfileId,
      ),
    ].filter((profileId): profileId is string => Boolean(profileId));
  const presenterProfileIdsOf = (booking: (typeof bookings)[number]) =>
    [
      ...(booking.webinar?.webinarPlan.collaborators ?? []).map(
        (c) => c.consultantProfileId,
      ),
      ...(booking.class?.classPlan.collaborators ?? []).map(
        (c) => c.consultantProfileId,
      ),
    ].filter((profileId): profileId is string => Boolean(profileId));
  const allProfileIds = [...new Set(bookings.flatMap(profileIdsOf))];
  const profiles = allProfileIds.length
    ? await db.consultantProfile.findMany({
        where: { id: { in: allProfileIds }, deletedAt: null },
        select: { id: true, user: { select: { id: true } } },
      })
    : [];
  const profileUser = new Map(
    profiles.flatMap((p) => (p.user ? [[p.id, p.user.id] as const] : [])),
  );
  for (const booking of bookings) {
    const deliveringIds = new Set(booking.participants.map((p) => p.userId));
    for (const profileId of profileIdsOf(booking)) {
      const userId = profileUser.get(profileId);
      if (userId) deliveringIds.add(userId);
    }
    const presenterIds = new Set<string>();
    for (const profileId of presenterProfileIdsOf(booking)) {
      const userId = profileUser.get(profileId);
      if (userId) presenterIds.add(userId);
    }
    result.set(booking.id, {
      deliveringIds,
      presenterIds,
      hostOrganizationIds: new Set(
        booking.payment.flatMap((p) =>
          p.hostOrganizationId ? [p.hostOrganizationId] : [],
        ),
      ),
    });
  }
  return result;
}

/** Accepted PRESENTER collaborator seats for a consultant profile. */
export function presenterCollaboratorWhere(
  userId: string,
): Prisma.CollaboratorWhereInput {
  return {
    status: "ACCEPTED",
    tier: "PRESENTER",
    consultantProfile: { userId, deletedAt: null },
  };
}

/** Appointments the user presents: accepted PRESENTER on the webinar/class plan. */
export function presenterAppointmentWhere(
  userId: string,
): Prisma.AppointmentWhereInput {
  const collaborators = { some: presenterCollaboratorWhere(userId) };
  return {
    OR: [
      { webinar: { webinarPlan: { collaborators } } },
      { class: { classPlan: { collaborators } } },
    ],
  };
}

/**
 * The subset of the given appointments the user presents. Callers pass the page
 * they are about to render, so the lookup never grows with a recurring series.
 */
export async function presenterAppointmentIdsIn(
  db: Pick<Tx, "appointment">,
  userId: string,
  appointmentIds: readonly (string | null | undefined)[],
): Promise<Set<string>> {
  const ids = [...new Set(appointmentIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Set();
  const rows = await db.appointment.findMany({
    where: { AND: [{ id: { in: ids } }, presenterAppointmentWhere(userId)] },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}
