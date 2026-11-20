import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";
import {
  liveParticipant,
  NOT_COLLABORATOR_ROW,
} from "@/lib/booking/participants";
import type { PlanRef } from "@/lib/collaborators/team";
import {
  resolveCollaborationViewer,
  seesAttendeePayments,
  seesAttendees,
} from "@/lib/collaborators/viewer";
import {
  HOST_PROFILE_SELECT,
  PARTY_PROFILE_SELECT,
  PUBLIC_USER_SELECT,
  isStaffNonParty,
  publicRequester,
} from "@/lib/booking/list-selects";

/** How far a caller's read of a booking's seats or payments reaches. */
type Reach = "all" | "own" | "none";
type AppointmentAccess = { seats: Reach; payments: Reach };

const EVERY_ROW: AppointmentAccess = { seats: "all", payments: "all" };

/**
 * A 1:1 party reads the whole booking. On a webinar or class the plan's
 * manager reads every seat and payment, a presenter the seats alone, crew
 * neither, and a seat holder their own. Null when the caller is no party.
 */
async function appointmentAccess(
  userId: string,
  consultantProfileId: string | null | undefined,
  consulteeProfileId: string | null | undefined,
  appointmentId: string,
): Promise<AppointmentAccess | null> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      participants: {
        select: { id: true },
        take: 1,
        where: { ...liveParticipant(userId), ...NOT_COLLABORATOR_ROW },
      },
      consultation: {
        select: {
          requestedById: true,
          consultationPlan: { select: { consultantProfileId: true } },
        },
      },
      subscription: {
        select: {
          requestedById: true,
          subscriptionPlan: { select: { consultantProfileId: true } },
        },
      },
      webinar: { select: { webinarPlanId: true } },
      class: { select: { classPlanId: true } },
    },
  });

  if (!appointment) return null;

  const planRef: PlanRef | null = appointment.webinar
    ? { planType: "webinar", planId: appointment.webinar.webinarPlanId }
    : appointment.class
      ? { planType: "class", planId: appointment.class.classPlanId }
      : null;
  if (planRef) {
    const { viewer } = await resolveCollaborationViewer(
      prisma,
      planRef,
      userId,
    );
    if (seesAttendeePayments(viewer)) return EVERY_ROW;
    if (seesAttendees(viewer)) return { seats: "all", payments: "none" };
    if (viewer.kind === "crew") return { seats: "none", payments: "none" };
    return appointment.participants.length > 0
      ? { seats: "own", payments: "own" }
      : null;
  }

  if (appointment.participants.length > 0) return EVERY_ROW;
  const request = appointment.consultation ?? appointment.subscription;
  const requestPlanConsultantId =
    appointment.consultation?.consultationPlan.consultantProfileId ??
    appointment.subscription?.subscriptionPlan.consultantProfileId;
  if (
    request &&
    ((!!consultantProfileId &&
      requestPlanConsultantId === consultantProfileId) ||
      (!!consulteeProfileId && request.requestedById === consulteeProfileId))
  )
    return EVERY_ROW;
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { appointmentId } = await params;

    const access = isPrivileged(session.user.role)
      ? EVERY_ROW
      : await appointmentAccess(
          session.user.id,
          session.user.consultantProfileId,
          session.user.consulteeProfileId,
          appointmentId,
        );
    if (!access) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // Rows the caller may not read are never selected; an own-row read carries the caller in its WHERE.
    const ownId = session.user.id;

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        occurrences: {
          where: { deletedAt: null },
          orderBy: { startsAt: "asc" },
        },
        // The roster lives on the appointment, not on each occurrence.
        ...(access.seats !== "none" && {
          participants: {
            where: {
              ...liveParticipant(access.seats === "own" ? ownId : undefined),
              ...NOT_COLLABORATOR_ROW,
            },
            include: { user: PUBLIC_USER_SELECT },
          },
        }),
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: PARTY_PROFILE_SELECT,
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: PARTY_PROFILE_SELECT,
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: HOST_PROFILE_SELECT,
              },
            },
          },
        },
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: HOST_PROFILE_SELECT,
              },
            },
          },
        },
        ...(access.payments !== "none" && {
          payment: {
            where: access.payments === "own" ? { userId: ownId } : undefined,
            select: {
              id: true,
              amount: true,
              taxAmount: true,
              currency: true,
              paymentStatus: true,
              paymentMethod: true,
              createdAt: true,
              userId: true,
              user: PUBLIC_USER_SELECT,
            },
          },
        }),
      },
    });

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    const request = appointment.consultation ?? appointment.subscription;
    const hostProfileId =
      appointment.consultation?.consultationPlan.consultantProfileId ??
      appointment.subscription?.subscriptionPlan.consultantProfileId;
    const isParty =
      (!!request &&
        request.requestedById === session.user.consulteeProfileId) ||
      (!!hostProfileId && hostProfileId === session.user.consultantProfileId);
    const data = isStaffNonParty(session.user.role, isParty)
      ? {
          ...appointment,
          consultation: appointment.consultation && {
            ...appointment.consultation,
            requestedBy: publicRequester(appointment.consultation.requestedBy),
          },
          subscription: appointment.subscription && {
            ...appointment.subscription,
            requestedBy: publicRequester(appointment.subscription.requestedBy),
          },
        }
      : appointment;
    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    console.error("Error fetching appointment:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "scheduling" } },
    );
    return NextResponse.json(
      { error: "An error occurred while fetching the appointment" },
      { status: 500 },
    );
  }
}
