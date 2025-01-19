import prisma from "@/lib/prisma";
import { AppointmentsType, Prisma, RequestStatus } from "@prisma/client";
import { addMonths, addWeeks, setHours, setMinutes } from "date-fns";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;
    const subscriptionData = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
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
        appointments: {
          include: {
            slotsOfAppointment: {
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
    });

    return NextResponse.json({ data: subscriptionData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription not found" },
        { status: 404 },
      );
    }
    console.error("Error fetching subscription:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the subscription" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;
    const body = await request.json();

    const subscriptionData = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        startDate: body.startDate,
        endDate: body.endDate,
        requestStatus: body.requestStatus,
        requestNotes: body.requestNotes,
        feedbackFromConsultee: body.feedbackFromConsultee,
        feedbackFromConsultant: body.feedbackFromConsultant,
        rating: body.rating,
        subscriptionPlan: body.planId
          ? {
              connect: { id: body.planId },
            }
          : undefined,
      },
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
        appointments: {
          include: {
            slotsOfAppointment: {
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
    });

    return NextResponse.json({ data: subscriptionData }, { status: 200 });
  } catch (error) {
    console.error("Error updating subscription:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the subscription" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;

    const subscriptionData = await prisma.subscription.delete({
      where: { id: subscriptionId },
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
        appointments: {
          include: {
            slotsOfAppointment: {
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
    });

    return NextResponse.json({ data: subscriptionData }, { status: 200 });
  } catch (error) {
    console.error("Error deleting subscription:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the subscription" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const body = await request.json();
    
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    const { status } = body as { status: RequestStatus };
    const { subscriptionId } = await params;

    if (!status) {
      return NextResponse.json(
        { error: "Status is required" },
        { status: 400 }
      );
    }

    if (!Object.values(RequestStatus).includes(status)) {
      return NextResponse.json(
        { error: "Invalid status" },
        { status: 400 }
      );
    }

    // First fetch the subscription to validate it exists and get all necessary data
    const existingSubscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
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
    });

    if (!existingSubscription) {
      return NextResponse.json(
        { error: "Subscription not found" },
        { status: 404 }
      );
    }

    if (!existingSubscription.subscriptionPlan?.consultantProfile?.user?.id) {
      return NextResponse.json(
        { error: "Invalid subscription: missing consultant information" },
        { status: 400 }
      );
    }

    if (!existingSubscription.requestedBy?.user?.id) {
      return NextResponse.json(
        { error: "Invalid subscription: missing requestedBy information" },
        { status: 400 }
      );
    }

    const startDate = new Date();
    const endDate = addMonths(startDate, existingSubscription.subscriptionPlan.durationInMonths);

    try {
      // Update subscription status and dates
      const subscription = await prisma.subscription.update({
        where: { id: subscriptionId },
        data: { 
          requestStatus: status,
          startDate: startDate,
          endDate: endDate
        },
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
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });

      // If approved, create appointments in batches
      if (status === RequestStatus.APPROVED) {
        const appointments = await createAppointmentsForSubscription(subscription);
        subscription.appointments = appointments;
      }

      return NextResponse.json({ data: subscription });
    } catch (error) {
      console.error("Transaction error:", error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  } catch (error) {
    console.error("Error updating subscription:", error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: "An error occurred while updating subscription" },
      { status: 500 }
    );
  }
}

async function createAppointmentsForSubscription(subscription: any) {
  const { subscriptionPlan, requestedBy } = subscription;
  
  if (!subscriptionPlan?.durationInMonths || !subscriptionPlan?.callsPerWeek) {
    console.error("Missing subscription plan details:", subscriptionPlan);
    throw new Error("Invalid subscription plan details");
  }

  if (!requestedBy?.user?.id || !subscriptionPlan?.consultantProfile?.user?.id) {
    console.error("Missing user information:", { requestedBy, consultantProfile: subscriptionPlan.consultantProfile });
    throw new Error("Missing user information");
  }

  const startDate = subscription.startDate || new Date();
  const endDate = subscription.endDate || addMonths(startDate, subscriptionPlan.durationInMonths);
  const appointments = [];

  // Create appointments for each week
  let currentDate = startDate;
  const batchSize = 10; // Process 10 appointments at a time
  let batch = [];

  while (currentDate < endDate) {
    // Create callsPerWeek appointments for this week
    for (let i = 0; i < subscriptionPlan.callsPerWeek; i++) {
      // Set a default time (e.g., 10 AM) for each appointment
      const appointmentDate = setHours(setMinutes(currentDate, 0), 10);
      
      batch.push({
        appointmentType: AppointmentsType.SUBSCRIPTION,
        subscription: {
          connect: { id: subscription.id }
        },
        slotsOfAppointment: {
          create: {
            slotStartTimeInUTC: appointmentDate,
            slotEndTimeInUTC: addHours(appointmentDate, 1),
            isTentative: false,
            user: {
              connect: [
                { id: requestedBy.user.id },
                { id: subscriptionPlan.consultantProfile.user.id }
              ]
            }
          }
        }
      });

      // When batch is full or we're at the last appointment, create them
      if (batch.length === batchSize || (currentDate >= endDate && i === subscriptionPlan.callsPerWeek - 1)) {
        try {
          const createdAppointments = await prisma.$transaction(
            batch.map(appointmentData => 
              prisma.appointment.create({
                data: appointmentData,
                include: {
                  slotsOfAppointment: {
                    include: {
                      user: true
                    }
                  }
                }
              })
            )
          );
          appointments.push(...createdAppointments);
          batch = []; // Clear the batch
        } catch (error) {
          console.error(`Error creating appointments batch:`, error instanceof Error ? error.message : 'Unknown error');
          throw error;
        }
      }
    }
    
    // Move to next week
    currentDate = addWeeks(currentDate, 1);
  }

  return appointments;
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}
