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

  // Validate statuses — consultations/subscriptions use RequestStatus,
  // webinars/classes use their own event status enums
  const validRequestStatuses = [
    "PENDING", "APPROVED", "APPROVED_PENDING_PAYMENT", "SCHEDULED",
    "COMPLETED", "REJECTED", "CANCELLED", "EXPIRED",
  ];
  const validEventStatuses = [
    "SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED",
  ];
  if (consultationStatus && !validRequestStatuses.includes(consultationStatus)) {
    return NextResponse.json(
      { error: "Invalid consultation status" },
      { status: 400 },
    );
  }
  if (subscriptionStatus && !validRequestStatuses.includes(subscriptionStatus)) {
    return NextResponse.json(
      { error: "Invalid subscription status" },
      { status: 400 },
    );
  }
  if (webinarStatus && !validEventStatuses.includes(webinarStatus)) {
    return NextResponse.json(
      { error: "Invalid webinar status" },
      { status: 400 },
    );
  }
  if (classStatus && !validEventStatuses.includes(classStatus)) {
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
        consultation: consultationStatus,
        subscription: subscriptionStatus,
        webinar: webinarStatus,
        class: classStatus,
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
    consultation?: string;
    subscription?: string;
    webinar?: string;
    class?: string;
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
  // Also includes appointments with no slots (they'll be shown but sorted to the end)
  if (startDate && endDate) {
    whereClause.OR = [
      // Appointments with slots overlapping the date range
      {
        slotsOfAppointment: {
          some: {
            AND: [
              { startsAt: { lt: new Date(endDate) } },
              { endsAt: { gt: new Date(startDate) } },
            ],
          },
        },
      },
      // OR appointments with no slots at all
      {
        slotsOfAppointment: {
          none: {},
        },
      },
    ];
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
          // Collaborated webinars (co-host, moderator, etc.)
          webinar: {
            webinarPlan: {
              collaborators: {
                some: {
                  consultantProfileId,
                  status: "ACCEPTED",
                },
              },
            },
          },
        },
        {
          class: {
            classPlan: { consultantProfileId },
          },
        },
        {
          // Collaborated classes (co-instructor, TA, etc.)
          class: {
            classPlan: {
              collaborators: {
                some: {
                  consultantProfileId,
                  status: "ACCEPTED",
                },
              },
            },
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

  // Apply status filters
  if (statuses?.consultation) {
    whereClause.consultation = {
      ...(whereClause.consultation as Prisma.ConsultationWhereInput),
      requestStatus: statuses.consultation as any,
    };
  }
  if (statuses?.subscription) {
    whereClause.subscription = {
      ...(whereClause.subscription as Prisma.SubscriptionWhereInput),
      requestStatus: statuses.subscription as any,
    };
  }
  if (statuses?.webinar) {
    whereClause.webinar = {
      ...(whereClause.webinar as Prisma.WebinarWhereInput),
      status: statuses.webinar as any,
    };
  }
  if (statuses?.class) {
    whereClause.class = {
      ...(whereClause.class as Prisma.ClassWhereInput),
      status: statuses.class as any,
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
              collaborators: {
                where: { status: "ACCEPTED" },
                include: {
                  consultantProfile: {
                    include: {
                      user: {
                        select: {
                          id: true,
                          name: true,
                          image: true,
                        },
                      },
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
                  user: true,
                },
              },
              collaborators: {
                where: { status: "ACCEPTED" },
                include: {
                  consultantProfile: {
                    include: {
                      user: {
                        select: {
                          id: true,
                          name: true,
                          image: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  // Sort appointments by slot start time
  // Include appointments with 0 slots (push them to the end)
  return appointments.sort((a, b) => {
    const aTime = a.slotsOfAppointment?.[0]?.startsAt;
    const bTime = b.slotsOfAppointment?.[0]?.startsAt;

    // Appointments without slots go to the end
    if (!aTime && !bTime) return 0;
    if (!aTime) return 1;
    if (!bTime) return -1;

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
