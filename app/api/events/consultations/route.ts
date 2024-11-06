import prisma from "@/lib/prisma";
import { checkOverlappingAppointments } from "@/lib/appointmentUtils";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const consulteeId = searchParams.get("consulteeId");
    const consultantId = searchParams.get("consultantId");
    const status = searchParams.get("status");

    let whereClause: any = {};

    if (consulteeId) {
      whereClause.requestedBy = { id: consulteeId };
    }

    if (consultantId) {
      whereClause.consultationPlan = {
        consultantProfile: { id: consultantId },
      };
    }

    if (status) {
      whereClause.requestStatus = status;
    }

    const consultations = await prisma.consultation.findMany({
      where: whereClause,
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
        appointment: {
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
          },
        },
      },
      orderBy: {
        requestedAt: 'desc',
      },
    });

    // Log the consultations data for debugging
    console.log('Consultations data:', JSON.stringify(consultations.map(c => ({
      id: c.id,
      status: c.requestStatus,
      requestedBy: c.requestedBy?.user?.name,
      consultant: c.consultationPlan?.consultantProfile?.user?.name,
      consultee: c.appointment?.slotOfAppointment?.[0]?.consulteeProfile?.user?.name,
      plan: c.consultationPlan?.title,
      requestedAt: c.requestedAt,
      appointment: c.appointment ? {
        id: c.appointment.id,
        slot: c.appointment.slotOfAppointment?.[0] ? {
          start: c.appointment.slotOfAppointment[0].slotStartTimeInUTC,
          end: c.appointment.slotOfAppointment[0].slotEndTimeInUTC,
        } : null
      } : null
    })), null, 2));

    return NextResponse.json({ data: consultations }, { status: 200 });
  } catch (error) {
    console.error("Error fetching consultations:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching consultations" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Check for overlapping appointments
    const isOverlapping = await checkOverlappingAppointments(
      new Date(body.startTime),
      new Date(body.endTime),
      body.consultantProfileId,
    );

    if (isOverlapping) {
      return NextResponse.json(
        { error: "This time slot is already booked" },
        { status: 409 },
      );
    }

    // Create the consultation and associated appointment in a transaction
    const result = await prisma.$transaction(async (prisma) => {
      const consultation = await prisma.consultation.create({
        data: {
          consultationPlan: {
            connect: { id: body.consultationPlanId },
          },
          requestedBy: {
            connect: { id: body.consulteeProfileId },
          },
          requestStatus: "PENDING",
          directlyBooked: true,
        },
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
      });

      const appointment = await prisma.appointment.create({
        data: {
          appointmentType: "CONSULTATION",
          consultation: {
            connect: { id: consultation.id },
          },
          slotOfAppointment: {
            create: {
              slotStartTimeInUTC: new Date(body.startTime),
              slotEndTimeInUTC: new Date(body.endTime),
              consulteeProfile: {
                connect: { id: body.consulteeProfileId },
              },
            },
          },
        },
        include: {
          slotOfAppointment: {
            include: {
              consulteeProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });

      return { consultation, appointment };
    });

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    console.error("Error creating consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the consultation" },
      { status: 500 },
    );
  }
}
