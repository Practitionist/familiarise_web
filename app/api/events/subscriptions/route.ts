import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import { checkOverlappingAppointments } from "@/lib/appointmentUtils";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const consulteeId = searchParams.get('consulteeId');
    const consultantId = searchParams.get('consultantId');

    let subscriptions;

    if (consulteeId) {
      subscriptions = await prisma.subscription.findMany({
        where: {
          requestedById: consulteeId
        }
      });
    } else if (consultantId) {
      subscriptions = await prisma.subscription.findMany({
        where: {
          plan: {
            consultantProfileId: consultantId
          }
        }
      });
    } else {
      subscriptions = await prisma.subscription.findMany({});
    }

    return NextResponse.json({ data: subscriptions }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
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
        body.consultantProfileId
      );

      if (isOverlapping) {
        return NextResponse.json(
          { error: `Time slot ${appointment.startTime} to ${appointment.endTime} is already booked` },
          { status: 409 }
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
          appointmentRequestStatus: "PENDING",
        },
      });

      const appointments = await Promise.all(
        body.appointmentSchedule.map(async (appointment: AppointmentSchedule) => {
          return prisma.appointment.create({
            data: {
              appointmentType: "SUBSCRIPTION",
              subscriptionId: subscription.id,
              slotOfAppointment: {
                create: {
                  appointmentStartTimeInUTC: new Date(appointment.startTime),
                  appointmentEndTimeInUTC: new Date(appointment.endTime),
                  appointmentsType: "SUBSCRIPTION",
                  consulteeProfile: {
                    connect: {
                      id: body.consulteeProfileId,
                    },
                  },
                  slotOfAvailabilityCustom: {
                    create: {
                      slotStartTimeInUTC: new Date(appointment.startTime),
                      slotEndTimeInUTC: new Date(appointment.endTime),
                      consultantProfile: {
                        connect: {
                          id: body.consultantProfileId,
                        },
                      },
                    },
                  },
                },
              },
            },
            include: {
              slotOfAppointment: true,
            },
          });
        })
      );

      return { subscription, appointments };
    });

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
