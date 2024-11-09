import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentsType } from "@prisma/client";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type")?.toUpperCase();
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "10");

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
      consulteeProfileId,
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
          slot: a.slotOfAppointment?.[0]
            ? {
                startUTC: a.slotOfAppointment[0].slotStartTimeInUTC,
                endUTC: a.slotOfAppointment[0].slotEndTimeInUTC,
                currentUTC: new Date().toISOString(),
              }
            : null,
          users: {
            consultee: a.slotOfAppointment?.[0]?.consulteeProfile?.user?.name,
            requestedBy:
              a.consultation?.requestedBy?.user?.name ||
              a.subscription?.requestedBy?.user?.name,
            consultant:
              a.consultation?.consultationPlan?.consultantProfile?.user?.name ||
              a.subscription?.plan?.consultantProfile?.user?.name ||
              a.webinar?.webinarPlan?.consultantProfile?.user?.name ||
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
  consulteeProfileId?: string | null,
  page: number = 1,
  limit: number = 10,
) {
  const skip = (page - 1) * limit;
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  // Get current time in UTC
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

  const whereClause: any = {
    slotOfAppointment: {
      some: {
        slotStartTimeInUTC: {
          gte: thirtyMinutesAgo, // Include appointments from 30 minutes ago
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
          plan: {
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

  if (consulteeProfileId) {
    whereClause.slotOfAppointment = {
      ...whereClause.slotOfAppointment,
      some: {
        ...whereClause.slotOfAppointment.some,
        consulteeProfileId,
      },
    };
  }

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where: whereClause,
      include: {
        slotOfAppointment: {
          include: {
            consulteeProfile: {
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
            plan: {
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
      },
      orderBy: [
        {
          slotOfAppointment: {
            _count: "desc",
          },
        },
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
    .filter((appointment) => appointment.slotOfAppointment?.length > 0)
    .sort((a, b) => {
      const aTime = a.slotOfAppointment[0]?.slotStartTimeInUTC;
      const bTime = b.slotOfAppointment[0]?.slotStartTimeInUTC;
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
        startTimeUTC: a.slotOfAppointment[0]?.slotStartTimeInUTC,
        endTimeUTC: a.slotOfAppointment[0]?.slotEndTimeInUTC,
        currentUTC: new Date().toISOString(),
        consultee: a.slotOfAppointment[0]?.consulteeProfile?.user?.name,
        requestedBy:
          a.consultation?.requestedBy?.user?.name ||
          a.subscription?.requestedBy?.user?.name,
        consultant:
          a.consultation?.consultationPlan?.consultantProfile?.user?.name ||
          a.subscription?.plan?.consultantProfile?.user?.name ||
          a.webinar?.webinarPlan?.consultantProfile?.user?.name ||
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
      consulteeProfileId,
      slotStartTimeInUTC,
      slotEndTimeInUTC,
      ...appointmentData
    } = body;

    if (
      !appointmentType ||
      !consulteeProfileId ||
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
        slotOfAppointment: {
          create: {
            consulteeProfile: { connect: { id: consulteeProfileId } },
            slotStartTimeInUTC: new Date(slotStartTimeInUTC),
            slotEndTimeInUTC: new Date(slotEndTimeInUTC),
          },
        },
      },
      include: {
        slotOfAppointment: {
          include: {
            consulteeProfile: {
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
            plan: {
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
