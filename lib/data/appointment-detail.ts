/**
 * Shared read for the single-appointment detail hub (consultant + consultee
 * /appointments/[appointmentId] pages). Both the API route
 * (GET /api/appointments/[appointmentId]) and the RSC prefetch call this so
 * SSR hydration and the client useQuery resolve identical payloads.
 *
 * Includes everything the detail page renders: the polymorphic event with
 * plan + people, ordered slots with meeting sessions AND their recordings,
 * payment, sponsoring org — plus sibling appointments of the same
 * subscription/class so the timeline shows the whole program. userId fields
 * on the profile selects exist for the API route's ownership check.
 */

import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";

const userSelect = {
  select: { id: true, name: true, image: true },
} as const;

const recordingsSelect = {
  select: {
    id: true,
    title: true,
    recordingUrl: true,
    supabaseUrl: true,
    thumbnailUrl: true,
    status: true,
    durationInMinutes: true,
    recordedAt: true,
  },
} as const;

const slotsInclude = {
  orderBy: { startsAt: "asc" },
  include: {
    user: userSelect,
    meetingSession: {
      select: { id: true, endedAt: true, recordings: recordingsSelect },
    },
  },
} as const;

const consultantProfileSelect = {
  select: { id: true, userId: true, user: userSelect },
} as const;

const consulteeProfileSelect = {
  select: { id: true, userId: true, user: userSelect },
} as const;

const collaboratorsInclude = {
  where: { status: "ACCEPTED" as const },
  select: {
    role: true,
    consultantProfile: consultantProfileSelect,
  },
} as const;

export async function readAppointmentDetail(appointmentId: string) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: {
        include: {
          consultationPlan: {
            include: { consultantProfile: consultantProfileSelect },
          },
          requestedBy: consulteeProfileSelect,
        },
      },
      subscription: {
        include: {
          subscriptionPlan: {
            include: { consultantProfile: consultantProfileSelect },
          },
          requestedBy: consulteeProfileSelect,
        },
      },
      webinar: {
        include: {
          webinarPlan: {
            include: {
              consultantProfile: consultantProfileSelect,
              collaborators: collaboratorsInclude,
            },
          },
        },
      },
      class: {
        include: {
          classPlan: {
            include: {
              consultantProfile: consultantProfileSelect,
              collaborators: collaboratorsInclude,
            },
          },
        },
      },
      trialSession: {
        include: {
          consulteeProfile: consulteeProfileSelect,
          subscriptionPlan: {
            include: { consultantProfile: consultantProfileSelect },
          },
        },
      },
      // Display-fields allowlist (#946 pattern) — the counterpart to the
      // booking must not receive gateway ids / tax internals.
      payment: {
        select: {
          id: true,
          amount: true,
          currency: true,
          paymentStatus: true,
          createdAt: true,
        },
      },
      organization: { select: { id: true, name: true } },
      slotsOfAppointment: slotsInclude,
    },
  });

  if (!appointment) return null;

  // Whole-program timeline: sibling sessions of the same subscription/class.
  const siblingWhere = appointment.subscriptionId
    ? { subscriptionId: appointment.subscriptionId }
    : appointment.classId
      ? { classId: appointment.classId }
      : null;
  const siblings = siblingWhere
    ? await prisma.appointment.findMany({
        where: { ...siblingWhere, id: { not: appointment.id } },
        include: { slotsOfAppointment: slotsInclude },
      })
    : [];

  return toPlain({ appointment, siblings });
}

export type TAppointmentDetail = NonNullable<
  Awaited<ReturnType<typeof readAppointmentDetail>>
>;
export type TDetailAppointment = TAppointmentDetail["appointment"];
export type TDetailRecording =
  TDetailAppointment["slotsOfAppointment"][number] extends {
    meetingSession: infer M;
  }
    ? M extends { recordings: Array<infer R> } | null
      ? R
      : never
    : never;
