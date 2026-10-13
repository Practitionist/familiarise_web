import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";
import { liveParticipant } from "@/lib/booking/participants";
import { PUBLIC_USER_SELECT } from "@/lib/booking/list-selects";

/** What a caller may read of an appointment: every attendee's rows, only their own, or nothing. */
type AppointmentAccess = "every-seat" | "own-seat";

/**
 * Hosts (plan consultant or accepted collaborator) and 1:1 parties see every seat;
 * a group seat holder sees only their own. Null when the caller is no party.
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
        where: liveParticipant(userId),
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
      webinar: {
        select: {
          webinarPlan: {
            select: {
              consultantProfileId: true,
              collaborators: {
                where: { status: "ACCEPTED" },
                select: { consultantProfileId: true },
              },
            },
          },
        },
      },
      class: {
        select: {
          classPlan: {
            select: {
              consultantProfileId: true,
              collaborators: {
                where: { status: "ACCEPTED" },
                select: { consultantProfileId: true },
              },
            },
          },
        },
      },
    },
  });

  if (!appointment) return null;

  const groupPlan =
    appointment.webinar?.webinarPlan ?? appointment.class?.classPlan;
  if (groupPlan) {
    const isHost =
      !!consultantProfileId &&
      (groupPlan.consultantProfileId === consultantProfileId ||
        groupPlan.collaborators.some(
          (c) => c.consultantProfileId === consultantProfileId,
        ));
    if (isHost) return "every-seat";
    return appointment.participants.length > 0 ? "own-seat" : null;
  }

  if (appointment.participants.length > 0) return "every-seat";
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
    return "every-seat";
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
      ? "every-seat"
      : await appointmentAccess(
          session.user.id,
          session.user.consultantProfileId,
          session.user.consulteeProfileId,
          appointmentId,
        );
    if (!access) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // A group seat holder reads only their own seat and Payment; the filter rides the WHERE.
    const ownSeatUserId = access === "own-seat" ? session.user.id : undefined;

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        occurrences: {
          where: { deletedAt: null },
          orderBy: { startsAt: "asc" },
        },
        // #1554 — the roster lives on the appointment, not on each occurrence.
        participants: {
          where: liveParticipant(ownSeatUserId),
          include: { user: PUBLIC_USER_SELECT },
        },
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
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
                consultantProfile: {
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
                consultantProfile: {
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
          },
        },
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: {
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
          },
        },
        payment: {
          where: ownSeatUserId ? { userId: ownSeatUserId } : undefined,
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
      },
    });

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: appointment }, { status: 200 });
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
