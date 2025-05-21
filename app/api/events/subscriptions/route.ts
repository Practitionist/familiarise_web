import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma, RequestStatus, AppointmentsType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { addWeeks, addMonths, setHours, setMinutes } from "date-fns";

interface UpdateSubscriptionRequest {
  id: string;
  status: RequestStatus;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const status = searchParams.get("status") as RequestStatus | null;
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "10");

  try {
    const whereClause: Prisma.SubscriptionWhereInput = {};

    if (consultantProfileId) {
      whereClause.subscriptionPlan = {
        consultantProfileId,
      };
    }

    if (consulteeProfileId) {
      whereClause.requestedById = consulteeProfileId;
    }

    if (status) {
      whereClause.requestStatus = status;
    }

    const [subscriptions, total] = await Promise.all([
      prisma.subscription.findMany({
        where: whereClause,
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                  domain: true,
                  subDomains: true,
                  tags: true,
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
                  user: true,
                },
              },
              payment: true,
            },
          },
        },
        orderBy: {
          requestedAt: "desc",
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.subscription.count({ where: whereClause }),
    ]);

    return NextResponse.json({
      data: subscriptions,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error("Error fetching subscriptions:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching subscriptions" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 },
      );
    }

    const { id, status } = body as UpdateSubscriptionRequest;

    if (!id || !status) {
      return NextResponse.json(
        { error: "ID and status are required" },
        { status: 400 },
      );
    }

    if (!Object.values(RequestStatus).includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    // First fetch the subscription to validate it exists and get all necessary data
    const existingSubscription = await prisma.subscription.findUnique({
      where: { id },
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
        { status: 404 },
      );
    }

    if (!existingSubscription.subscriptionPlan?.consultantProfile?.user?.id) {
      return NextResponse.json(
        { error: "Invalid subscription: missing consultant information" },
        { status: 400 },
      );
    }

    if (!existingSubscription.requestedBy?.user?.id) {
      return NextResponse.json(
        { error: "Invalid subscription: missing requestedBy information" },
        { status: 400 },
      );
    }

    const startDate = new Date();
    const endDate = addMonths(
      startDate,
      existingSubscription.subscriptionPlan.durationInMonths,
    );

    try {
      // Update subscription status and dates
      const subscription = await prisma.subscription.update({
        where: { id },
        data: {
          requestStatus: status,
          startDate: startDate,
          endDate: endDate,
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
              payment: true,
            },
          },
        },
      });

      // If approved, create appointments in batches
      if (status === RequestStatus.APPROVED) {
        await createAppointmentsForSubscription(subscription);
      }

      return NextResponse.json({ data: subscription });
    } catch (error) {
      Sentry.captureException(error);
      console.error(
        "Transaction error:",
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    }
  } catch (error) {
    Sentry.captureException(error);
    console.error(
      "Error updating subscription:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "An error occurred while updating subscription" },
      { status: 500 },
    );
  }
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

async function createAppointmentsForSubscription(subscription: any) {
  const { subscriptionPlan, requestedBy } = subscription;

  if (!subscriptionPlan?.durationInMonths || !subscriptionPlan?.callsPerWeek) {
    console.error("Missing subscription plan details:", subscriptionPlan);
    throw new Error("Invalid subscription plan details");
  }

  if (
    !requestedBy?.user?.id ||
    !subscriptionPlan?.consultantProfile?.user?.id
  ) {
    console.error("Missing user information:", {
      requestedBy,
      consultantProfile: subscriptionPlan.consultantProfile,
    });
    throw new Error("Missing user information");
  }

  const startDate = subscription.startDate || new Date();
  const endDate =
    subscription.endDate ||
    addMonths(startDate, subscriptionPlan.durationInMonths);
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
          connect: { id: subscription.id },
        },
        slotsOfAppointment: {
          create: {
            slotStartTimeInUTC: appointmentDate,
            slotEndTimeInUTC: addHours(appointmentDate, 1),
            isTentative: false,
            user: {
              connect: [
                { id: requestedBy.user.id },
                { id: subscriptionPlan.consultantProfile.user.id },
              ],
            },
          },
        },
      });

      // When batch is full or we're at the last appointment, create them
      if (
        batch.length === batchSize ||
        (currentDate >= endDate && i === subscriptionPlan.callsPerWeek - 1)
      ) {
        try {
          const createdAppointments = await prisma.$transaction(
            batch.map((appointmentData) =>
              prisma.appointment.create({
                data: appointmentData,
                include: {
                  slotsOfAppointment: {
                    include: {
                      user: true,
                    },
                  },
                },
              }),
            ),
          );
          appointments.push(...createdAppointments);
          batch = []; // Clear the batch
        } catch (error) {
          Sentry.captureException(error);
          console.error(`Error creating appointments batch:`, error);
          throw error;
        }
      }
    }

    // Move to next week
    currentDate = addWeeks(currentDate, 1);
  }

  return appointments;
}
