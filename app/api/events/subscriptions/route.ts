import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import { checkOverlappingAppointments } from "@/lib/appointmentUtils";

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
      whereClause.plan = {
        consultantProfile: { id: consultantId },
      };
    }

    if (status) {
      whereClause.requestStatus = status;
    }

    const subscriptions = await prisma.subscription.findMany({
      where: whereClause,
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
        appointments: {
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

    // Log the subscriptions data for debugging
    console.log('Subscriptions data:', JSON.stringify(subscriptions.map(s => ({
      id: s.id,
      status: s.requestStatus,
      requestedBy: s.requestedBy?.user?.name,
      consultant: s.plan?.consultantProfile?.user?.name,
      plan: s.plan?.title,
      startDate: s.startDate,
      endDate: s.endDate,
      requestedAt: s.requestedAt,
      appointments: s.appointments.map(a => ({
        id: a.id,
        slot: a.slotOfAppointment?.[0] ? {
          start: a.slotOfAppointment[0].slotStartTimeInUTC,
          end: a.slotOfAppointment[0].slotEndTimeInUTC,
          consultee: a.slotOfAppointment[0].consulteeProfile?.user?.name
        } : null
      }))
    })), null, 2));

    return NextResponse.json({ data: subscriptions }, { status: 200 });
  } catch (error) {
    console.error("Error fetching subscriptions:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching subscriptions" },
      { status: 500 },
    );
  }
}

interface AppointmentSchedule {
  startTime: string;
  endTime: string;
}

interface SubscriptionRequestBody {
  subscriptionPlanId: string;
  startDate: string;
  endDate: string;
  consultantProfileId: string;
  consulteeProfileId: string;
  appointmentSchedule: AppointmentSchedule[];
}

export async function POST(request: Request) {
  try {
    const body: SubscriptionRequestBody = await request.json();

    // Check for overlapping appointments for each scheduled appointment
    for (const appointment of body.appointmentSchedule) {
      const isOverlapping = await checkOverlappingAppointments(
        new Date(appointment.startTime),
        new Date(appointment.endTime),
        body.consultantProfileId,
      );

      if (isOverlapping) {
        return NextResponse.json(
          {
            error: `Time slot ${appointment.startTime} to ${appointment.endTime} is already booked`,
          },
          { status: 409 },
        );
      }
    }

    // Create the subscription and associated appointments in a transaction
    const result = await prisma.$transaction(async (prisma) => {
      const subscription = await prisma.subscription.create({
        data: {
          startDate: new Date(body.startDate),
          endDate: new Date(body.endDate),
          plan: {
            connect: {
              id: body.subscriptionPlanId,
            },
          },
          requestedBy: {
            connect: {
              id: body.consulteeProfileId,
            },
          },
          requestStatus: "PENDING",
        },
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
      });

      const appointments = await Promise.all(
        body.appointmentSchedule.map(
          async (appointment: AppointmentSchedule) => {
            return prisma.appointment.create({
              data: {
                appointmentType: "SUBSCRIPTION",
                subscription: { connect: { id: subscription.id } },
                slotOfAppointment: {
                  create: {
                    slotStartTimeInUTC: new Date(appointment.startTime),
                    slotEndTimeInUTC: new Date(appointment.endTime),
                    consulteeProfile: {
                      connect: {
                        id: body.consulteeProfileId,
                      },
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
          },
        ),
      );

      return { subscription, appointments };
    });

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    console.error("Error creating subscription:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the subscription" },
      { status: 500 },
    );
  }
}
