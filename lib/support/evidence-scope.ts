import type { Prisma } from "@prisma/client";

/** An organization can be the booking sponsor or the session's delivery host. */
export function evidenceAppointmentScope(
  organizationId: string,
): Prisma.AppointmentWhereInput {
  return {
    OR: [
      { organizationId },
      { payment: { some: { hostOrganizationId: organizationId } } },
    ],
  };
}
