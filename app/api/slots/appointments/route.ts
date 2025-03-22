import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentsType, Prisma } from "@prisma/client";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type")?.toUpperCase();
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const userId = searchParams.get("userId");
  const webinarId = searchParams.get("webinarId");
  const classId = searchParams.get("classId");

  console.log("GET /api/slots/appointments - Query params:", {
    type,
    consultantProfileId,
    consulteeProfileId,
    userId,
    webinarId,
    classId
  });

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
      webinarId,
      classId
    );
    
    // If no appointments found but webinarId is provided, do a direct query
    // as a sanity check without any filters
    if (appointments.length === 0 && webinarId) {
      console.log("No appointments found with filters, doing direct webinarId query");
      
      const directQuery = await prisma.appointment.findMany({
        where: { webinarId },
        include: { slotsOfAppointment: true },
      });
      
      console.log(`Direct query found ${directQuery.length} appointments for webinarId ${webinarId}`);
      
      if (directQuery.length > 0) {
        directQuery.forEach((app, i) => {
          console.log(`Direct Query Appointment ${i+1}:`, {
            id: app.id,
            type: app.appointmentType,
            webinarId: app.webinarId,
            slots: app.slotsOfAppointment.length,
          });
        });
        
        // If we found appointments with the direct query, return these instead
        return NextResponse.json({ data: directQuery });
      }
    }

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
  webinarId?: string | null,
  classId?: string | null
) {
  console.log("getAppointments called with params:", {
    type,
    consultantProfileId,
    consulteeProfileId,
    userId,
    statuses,
    webinarId,
    classId
  });

  // Create a base where clause
  let whereClause: Prisma.AppointmentWhereInput = {};

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

  // Direct filtering by webinarId or classId if provided
  if (webinarId) {
    whereClause.webinarId = webinarId;
    console.log("Added direct webinarId filter:", webinarId);
  }

  if (classId) {
    whereClause.classId = classId;
    console.log("Added direct classId filter:", classId);
  }

  // If no direct ID filters are applied, use the traditional filtering approach
  if (!webinarId && !classId) {
    const whereConditions: Prisma.AppointmentWhereInput[] = [];

    // Add consultation condition if applicable
    whereConditions.push({
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
    });

    // Add subscription condition if applicable
    whereConditions.push({
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
    });

    // Add webinar condition
    const webinarCondition: Prisma.AppointmentWhereInput = {
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
    };
    whereConditions.push(webinarCondition);

    // Add class condition
    const classCondition: Prisma.AppointmentWhereInput = {
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
    };
    whereConditions.push(classCondition);

    whereClause.OR = whereConditions;
  }

  console.log("Final whereClause:", JSON.stringify(whereClause, null, 2));

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

  console.log(`Found ${appointments.length} appointments`);
  if (appointments.length > 0) {
    appointments.forEach((app, index) => {
      console.log(`Appointment ${index + 1}:`, {
        id: app.id,
        type: app.appointmentType,
        webinarId: app.webinarId,
        classId: app.classId,
        slots: app.slotsOfAppointment.length,
        webinar: app.webinar ? { id: app.webinar.id, status: app.webinar.status } : null,
        class: app.class ? { id: app.class.id, status: app.class.status } : null,
      });
    });
  } else if (webinarId || classId) {
    console.log(`No appointments found for ${webinarId ? 'webinarId: ' + webinarId : 'classId: ' + classId}`);
    
    // Do a direct database check to see if the webinar/class exists
    if (webinarId) {
      const webinar = await prisma.webinar.findUnique({
        where: { id: webinarId },
        select: { id: true, status: true }
      });
      console.log("Direct webinar lookup result:", webinar);
    }
    if (classId) {
      const classEntity = await prisma.class.findUnique({
        where: { id: classId },
        select: { id: true, status: true }
      });
      console.log("Direct class lookup result:", classEntity);
    }
  }

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
    console.log("POST request body:", JSON.stringify(body, null, 2));
    
    const { appointmentType, slotsOfAppointment, ...appointmentData } = body;

    // Check for both formats of slot data
    const hasCreateManyData = !!slotsOfAppointment?.createMany?.data?.length;
    const hasCreateData = Array.isArray(slotsOfAppointment?.create) && slotsOfAppointment.create.length > 0;
    
    if (!appointmentType || (!hasCreateManyData && !hasCreateData)) {
      console.error("Missing required fields:", {
        hasAppointmentType: !!appointmentType,
        hasCreateManyData,
        hasCreateData
      });
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    let slotData;
    if (hasCreateManyData) {
      slotData = slotsOfAppointment.createMany.data.map(
        (slot: { slotStartTimeInUTC: string; slotEndTimeInUTC: string }) => ({
          slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
          slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC),
        })
      );
    } else if (hasCreateData) {
      slotData = slotsOfAppointment.create.map(
        (slot: { slotStartTimeInUTC: any; slotEndTimeInUTC: any }) => ({
          slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
          slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC),
        })
      );
    }

    const data: Prisma.AppointmentCreateInput = {
      appointmentType,
      ...appointmentData,
      slotsOfAppointment: {
        create: slotData,
      },
    };

    console.log("Creating appointment with data:", JSON.stringify(data, null, 2));

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
    console.error("Error creating appointment:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the appointment" },
      { status: 500 },
    );
  }
}
