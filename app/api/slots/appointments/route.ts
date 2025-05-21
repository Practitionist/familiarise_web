import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentsType, Prisma } from "@prisma/client";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type")?.toUpperCase();
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const userId = searchParams.get("userId");

  // Get status for each appointment type
  const consultationStatus = searchParams
    .get("consultationStatus")
    ?.toUpperCase();
  const subscriptionStatus = searchParams
    .get("subscriptionStatus")
    ?.toUpperCase();
  const webinarStatus = searchParams.get("webinarStatus")?.toUpperCase();
  const classStatus = searchParams.get("classStatus")?.toUpperCase();

  // Validate appointment type
  if (
    type &&
    !Object.values(AppointmentsType).includes(type as AppointmentsType)
  ) {
    return NextResponse.json(
      { error: "Invalid appointment type" },
      { status: 400 },
    );
  }

  // Validate statuses
  const validStatuses = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"];
  if (consultationStatus && !validStatuses.includes(consultationStatus)) {
    return NextResponse.json(
      { error: "Invalid consultation status" },
      { status: 400 },
    );
  }
  if (subscriptionStatus && !validStatuses.includes(subscriptionStatus)) {
    return NextResponse.json(
      { error: "Invalid subscription status" },
      { status: 400 },
    );
  }
  if (webinarStatus && !validStatuses.includes(webinarStatus)) {
    return NextResponse.json(
      { error: "Invalid webinar status" },
      { status: 400 },
    );
  }
  if (classStatus && !validStatuses.includes(classStatus)) {
    return NextResponse.json(
      { error: "Invalid class status" },
      { status: 400 },
    );
  }

  try {
    const appointments = await getAppointments(
      type as AppointmentsType | undefined,
      consultantProfileId,
      consulteeProfileId,
      userId,
      {
        consultation: consultationStatus as
          | "PENDING"
          | "APPROVED"
          | "REJECTED"
          | "CANCELLED"
          | undefined,
        subscription: subscriptionStatus as
          | "PENDING"
          | "APPROVED"
          | "REJECTED"
          | "CANCELLED"
          | undefined,
        webinar: webinarStatus as
          | "PENDING"
          | "APPROVED"
          | "REJECTED"
          | "CANCELLED"
          | undefined,
        class: classStatus as
          | "PENDING"
          | "APPROVED"
          | "REJECTED"
          | "CANCELLED"
          | undefined,
      },
    );

    return NextResponse.json({ data: appointments });
  } catch (error) {
    Sentry.captureException(error);
    console.error("Error fetching appointments:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching appointments" },
      { status: 500 },
    );
  }
}

async function getAppointments(
  type?: AppointmentsType,
  consultantProfileId?: string | null,
  consulteeProfileId?: string | null,
  userId?: string | null,
  statuses?: {
    consultation?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
    subscription?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
    webinar?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
    class?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  },
) {
  const whereClause: Prisma.AppointmentWhereInput = {
    OR: [
      {
        consultation: {
          requestStatus: statuses?.consultation || "APPROVED",
          consultationPlan: consultantProfileId
            ? {
                consultantProfileId,
              }
            : undefined,
          requestedBy: consulteeProfileId
            ? {
                id: consulteeProfileId,
              }
            : undefined,
        },
      },
      {
        subscription: {
          requestStatus: statuses?.subscription || "APPROVED",
          subscriptionPlan: consultantProfileId
            ? {
                consultantProfileId,
              }
            : undefined,
          requestedBy: consulteeProfileId
            ? {
                id: consulteeProfileId,
              }
            : undefined,
        },
      },
      {
        webinar: {
          status:
            statuses?.webinar === "APPROVED"
              ? "SCHEDULED"
              : statuses?.webinar === "CANCELLED"
                ? "CANCELLED"
                : statuses?.webinar === "REJECTED"
                  ? "CANCELLED"
                  : "SCHEDULED",
          webinarPlan: consultantProfileId
            ? {
                consultantProfileId,
              }
            : undefined,
        },
      },
      {
        class: {
          status:
            statuses?.class === "APPROVED"
              ? "SCHEDULED"
              : statuses?.class === "CANCELLED"
                ? "CANCELLED"
                : statuses?.class === "REJECTED"
                  ? "CANCELLED"
                  : "SCHEDULED",
          classPlan: consultantProfileId
            ? {
                consultantProfileId,
              }
            : undefined,
        },
      },
    ],
  };

  if (type) {
    whereClause.appointmentType = type;
  }

  if (userId) {
    whereClause.slotsOfAppointment = {
      some: {
        user: {
          some: {
            id: userId,
          },
        },
      },
    };
  }

  const appointments = await prisma.appointment.findMany({
    where: whereClause,
    include: {
      slotsOfAppointment: {
        include: {
          user: true,
        },
      },
      consultation: {
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: true,
            },
          },
        },
      },
      subscription: {
        select: {
          id: true,
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: true,
            },
          },
          startDate: true,
          endDate: true,
          requestStatus: true,
        },
      },
      webinar: {
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
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
                  user: true,
                },
              },
            },
          },
        },
      },
    },
  });

  // Sort appointments by slot start time
  return appointments
    .filter((appointment) => appointment.slotsOfAppointment?.length > 0)
    .sort((a, b) => {
      const aTime = a.slotsOfAppointment[0]?.slotStartTimeInUTC;
      const bTime = b.slotsOfAppointment[0]?.slotStartTimeInUTC;
      if (!aTime || !bTime) return 0;
      return new Date(aTime).getTime() - new Date(bTime).getTime();
    });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { appointmentType, slotsOfAppointment, ...appointmentData } = body;

    if (!appointmentType || !slotsOfAppointment?.createMany?.data?.length) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    const data: Prisma.AppointmentCreateInput = {
      appointmentType,
      ...appointmentData,
      slotsOfAppointment: {
        create: slotsOfAppointment.createMany.data.map(
          (slot: { slotStartTimeInUTC: string; slotEndTimeInUTC: string }) => ({
            slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
            slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC),
          }),
        ),
      },
    };

    const newAppointment = await prisma.appointment.create({
      data,
      include: {
        slotsOfAppointment: {
          include: {
            user: true,
          },
        },
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: true,
              },
            },
          },
        },
        subscription: {
          select: {
            id: true,
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: true,
              },
            },
            startDate: true,
            endDate: true,
            requestStatus: true,
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
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
                    user: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: newAppointment }, { status: 201 });
  } catch (error) {
    Sentry.captureException(error);
    console.error("Error creating appointment:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the appointment" },
      { status: 500 },
    );
  }
}
