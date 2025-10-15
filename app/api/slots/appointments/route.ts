import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentsType, Prisma } from "@prisma/client";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type")?.toUpperCase();
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const userId = searchParams.get("userId");

  // Get specific event IDs for filtering
  const webinarId = searchParams.get("webinarId");
  const classId = searchParams.get("classId");
  const consultationId = searchParams.get("consultationId");
  const subscriptionId = searchParams.get("subscriptionId");

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
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

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
      startDate,
      endDate,
      {
        webinarId,
        classId,
        consultationId,
        subscriptionId,
      },
    );

    return NextResponse.json({ data: appointments });
  } catch (error) {
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
  startDate?: string | null,
  endDate?: string | null,
  eventIds?: {
    webinarId?: string | null;
    classId?: string | null;
    consultationId?: string | null;
    subscriptionId?: string | null;
  },
) {
  const whereClause: Prisma.AppointmentWhereInput = {};

  // Date range filtering for appointments. This is the primary filter.
  // It looks for appointments where any of its slots overlap with the given date range.
  if (startDate && endDate) {
    whereClause.slotsOfAppointment = {
      some: {
        AND: [
          { startsAt: { lt: new Date(endDate) } },
          { endsAt: { gt: new Date(startDate) } },
        ],
      },
    };
  }

  const userFilterClauses: Prisma.AppointmentWhereInput[] = [];
  if (consultantProfileId) {
    userFilterClauses.push({
      OR: [
        {
          consultation: {
            consultationPlan: { consultantProfileId },
          },
        },
        {
          subscription: {
            subscriptionPlan: { consultantProfileId },
          },
        },
        {
          webinar: {
            webinarPlan: { consultantProfileId },
          },
        },
        {
          class: {
            classPlan: { consultantProfileId },
          },
        },
      ],
    });
  }

  if (consulteeProfileId) {
    userFilterClauses.push({
      OR: [
        {
          consultation: {
            requestedBy: { id: consulteeProfileId },
          },
        },
        {
          subscription: {
            requestedBy: { id: consulteeProfileId },
          },
        },
        {
          slotsOfAppointment: {
            some: {
              user: { some: { consulteeProfileId: consulteeProfileId } },
            },
          },
        },
      ],
    });
  }

  if (userId) {
    userFilterClauses.push({
      slotsOfAppointment: {
        some: {
          user: {
            some: {
              id: userId,
            },
          },
        },
      },
    });
  }

  if (userFilterClauses.length > 0) {
    whereClause.AND = userFilterClauses;
  }

  if (type) {
    whereClause.appointmentType = type;
  }

  // Filter by specific event IDs
  if (eventIds?.webinarId) {
    whereClause.webinar = { id: eventIds.webinarId };
  }
  if (eventIds?.classId) {
    whereClause.class = { id: eventIds.classId };
  }
  if (eventIds?.consultationId) {
    whereClause.consultation = { id: eventIds.consultationId };
  }
  if (eventIds?.subscriptionId) {
    whereClause.subscription = { id: eventIds.subscriptionId };
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
          schedulingPeriodStartsAt: true,
          schedulingPeriodEndsAt: true,
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
      const aTime = a.slotsOfAppointment[0]?.startsAt;
      const bTime = b.slotsOfAppointment[0]?.startsAt;
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
          (slot: {
            startsAt: string;
            endsAt: string;
            type?: "WEEKLY" | "CUSTOM";
          }) => ({
            startsAt: new Date(slot.startsAt),
            endsAt: new Date(slot.endsAt),
            type: slot.type || "WEEKLY", // Default to WEEKLY if not specified
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
            schedulingPeriodStartsAt: true,
            schedulingPeriodEndsAt: true,
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
    console.error("Error creating appointment:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the appointment" },
      { status: 500 },
    );
  }
}
