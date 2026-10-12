import "server-only";

import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { materialReaderWhere } from "./material-access";

export interface BookingMaterial {
  id: string;
  name: string;
  mimeType: string;
  fileSize: number;
  description: string | null;
}

/** The plan materials of one booking that this viewer may open (host or paid learner), in display order. */
export async function readBookingMaterials(
  appointmentId: string,
  userId: string,
): Promise<BookingMaterial[] | null> {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, deletedAt: null },
    select: {
      consultation: { select: { consultationPlanId: true } },
      subscription: { select: { subscriptionPlanId: true } },
      trial: { select: { subscriptionPlanId: true } },
      webinar: { select: { webinarPlanId: true } },
      class: { select: { classPlanId: true } },
    },
  });
  if (!appointment) return null;
  const plan: Prisma.PlanMaterialWhereInput | null = appointment.consultation
    ? { consultationPlanId: appointment.consultation.consultationPlanId }
    : appointment.subscription
      ? { subscriptionPlanId: appointment.subscription.subscriptionPlanId }
      : appointment.trial
        ? { subscriptionPlanId: appointment.trial.subscriptionPlanId }
        : appointment.webinar
          ? { webinarPlanId: appointment.webinar.webinarPlanId }
          : appointment.class
            ? { classPlanId: appointment.class.classPlanId }
            : null;
  if (!plan) return [];
  const rows = await prisma.planMaterial.findMany({
    where: { AND: [plan, materialReaderWhere(userId)] },
    orderBy: [{ order: "asc" }, { uploadedAt: "asc" }],
    select: {
      id: true,
      originalName: true,
      mimeType: true,
      fileSize: true,
      description: true,
    },
  });
  return rows.map((m) => ({
    id: m.id,
    name: m.originalName,
    mimeType: m.mimeType,
    fileSize: m.fileSize,
    description: m.description,
  }));
}
