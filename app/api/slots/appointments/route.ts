import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentsType, Prisma } from "@prisma/client";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type")?.toUpperCase();
  const consultantProfileId = searchParams.get("consultantProfileId");
  const userId = searchParams.get("userId"); // Changed from consulteeProfileId
  const page = parseInt(searchParams.get("page") ?? "1");
  const limit = parseInt(searchParams.get("limit") ?? "10");

  if (
    type &&
    !Object.values(AppointmentsType).includes(type as AppointmentsType)
  ) {
    return NextResponse.json(
      { error: "Invalid appointment type" },
      { status: 400 },
    );
  }

  try {
    const { appointments, total } = await getAppointments(
      type as AppointmentsType | undefined,
      consultantProfileId,
      userId, // Changed from consulteeProfileId
      page,
      limit,
    );

    // Log the appointments data for debugging
    console.log(
      "Raw appointments data:",
      JSON.stringify(
        appointments.map((a) => ({
          id: a.id,
          type: a.appointmentType,
          slot: a.slotsOfAppointment?.[0]
            ? {
                startUTC: a.slotsOfAppointment[0].slotStartTimeInUTC,
                endUTC: a.slotsOfAppointment[0].slotEndTimeInUTC,
                currentUTC: new Date().toISOString(),
              }
            : null,
          users: {
            consultee: a.slotsOfAppointment?.[0]?.user?.[0]?.name ?? "Unknown",
            requestedBy:
              a.consultation?.requestedBy?.user?.name ??
              a.subscription?.requestedBy?.user?.name,
            consultant:
              a.consultation?.consultationPlan?.consultantProfile?.user?.name ??
              a.subscription?.subscriptionPlan?.consultantProfile?.user?.name ??
              a.webinar?.webinarPlan?.consultantProfile?.user?.name ??
              a.class?.classPlan?.consultantProfile?.user?.name,
          },
        })),
        null,
        2,
      ),
    );

    return NextResponse.json({
      data: appointments,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
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
  userId?: string | null, // Changed from consulteeProfileId
  page: number = 1,
  limit: number = 10,
) {
  const skip = (page - 1) * limit;
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  // Get current time in UTC
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

  const whereClause: Prisma.AppointmentWhereInput = {
    slotsOfAppointment: {
      some: {
        slotStartTimeInUTC: {
          gte: thirtyMinutesAgo,
        },
      },
    },
  };

  if (consultantProfileId) {
    whereClause.OR = [
      {
        consultation: {
          consultationPlan: {
            consultantProfileId,
          },
        },
      },
      {
        subscription: {
          subscriptionPlan: {
            consultantProfileId,
          },
        },
      },
      {
        webinar: {
          webinarPlan: {
            consultantProfileId,
          },
        },
      },
      {
        class: {
          classPlan: {
            consultantProfileId,
          },
        },
      },
    ];
  }

  if (type) {
    whereClause.appointmentType = type;
  }

  if (userId) {
    // Changed from consulteeProfileId
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

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
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
          include: {
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
      orderBy: [
        {
          createdAt: "desc",
        },
      ],
      skip,
      take: limit,
    }),
    prisma.appointment.count({ where: whereClause }),
  ]);

  // Sort appointments by slot start time
  const sortedAppointments = appointments
    .filter((appointment) => appointment.slotsOfAppointment?.length > 0)
    .sort((a, b) => {
      const aTime = a.slotsOfAppointment[0]?.slotStartTimeInUTC;
      const bTime = b.slotsOfAppointment[0]?.slotStartTimeInUTC;
      if (!aTime || !bTime) return 0;
      return new Date(aTime).getTime() - new Date(bTime).getTime();
    });

  // Log the sorted appointments for debugging
  console.log(
    "Sorted appointments:",
    JSON.stringify(
      sortedAppointments.map((a) => ({
        id: a.id,
        type: a.appointmentType,
        startTimeUTC: a.slotsOfAppointment[0]?.slotStartTimeInUTC,
        endTimeUTC: a.slotsOfAppointment[0]?.slotEndTimeInUTC,
        currentUTC: new Date().toISOString(),
        consultee: a.slotsOfAppointment[0]?.user?.[0]?.name ?? "Unknown",
        requestedBy:
          a.consultation?.requestedBy?.user?.name ??
          a.subscription?.requestedBy?.user?.name,
        consultant:
          a.consultation?.consultationPlan?.consultantProfile?.user?.name ??
          a.subscription?.subscriptionPlan?.consultantProfile?.user?.name ??
          a.webinar?.webinarPlan?.consultantProfile?.user?.name ??
          a.class?.classPlan?.consultantProfile?.user?.name,
      })),
      null,
      2,
    ),
  );

  return { appointments: sortedAppointments, total };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      appointmentType,
      userId, // Changed from consulteeProfileId
      slotStartTimeInUTC,
      slotEndTimeInUTC,
      ...appointmentData
    } = body;

    if (
      !appointmentType ||
      !userId || // Changed from consulteeProfileId
      !slotStartTimeInUTC ||
      !slotEndTimeInUTC
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    const newAppointment = await prisma.appointment.create({
      data: {
        appointmentType,
        ...appointmentData,
        slotsOfAppointment: {
          create: {
            user: { connect: [{ id: userId }] }, // Changed from consulteeProfile connect
            slotStartTimeInUTC: new Date(slotStartTimeInUTC),
            slotEndTimeInUTC: new Date(slotEndTimeInUTC),
          },
        },
      },
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
          include: {
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
