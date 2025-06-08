import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "../auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { z } from "zod";
import {
  AppointmentsType,
  PaymentGateway,
  PaymentStatus,
  RequestStatus,
  WebinarStatus,
  ClassStatus,
  Prisma,
} from "@prisma/client";
import { createPaymentIntent } from "@/lib/payment";

// Unified checkout schema
const unifiedCheckoutSchema = z
  .object({
    appointmentType: z.enum([
      "CONSULTATION",
      "SUBSCRIPTION",
      "WEBINAR",
      "CLASS",
    ]),
    planId: z.string(),
    eventId: z.string().optional(), // For specific webinar/class instances
    slotStartTimeInUTC: z.string().datetime().optional(),
    slotEndTimeInUTC: z.string().datetime().optional(),
    slotOfAvailabilityWeeklyId: z.string().optional(),
    slotOfAvailabilityCustomId: z.string().optional(),
    discountCode: z.string().optional(),
    paymentGateway: z.enum(["STRIPE", "RAZORPAY", "LEMON_SQUEEZY", "XFLOW"]),
    notes: z.string().optional(),
  })
  .refine(
    (data) => {
      // For consultation and subscription, require slot timing
      if (["CONSULTATION", "SUBSCRIPTION"].includes(data.appointmentType)) {
        return data.slotStartTimeInUTC && data.slotEndTimeInUTC;
      }
      return true;
    },
    {
      message: "Consultation and subscription require slot timing",
    },
  )
  .refine(
    (data) => {
      // For webinar and class, require eventId
      if (["WEBINAR", "CLASS"].includes(data.appointmentType)) {
        return data.eventId;
      }
      return true;
    },
    {
      message: "Webinar and class require eventId",
    },
  );

type CheckoutInput = z.infer<typeof unifiedCheckoutSchema>;

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validate request body
    const body = await req.json();
    const validatedData = unifiedCheckoutSchema.parse(body);

    // Check if payment should be skipped (for development/testing)
    const skipPayment = process.env.SKIP_PAYMENT === "true";

    let appointmentId: string;
    let amount: number;
    let currency: string;

    // Step 1: Create appointment and related records in database transaction
    // This ensures all DB operations are atomic and can rollback together
    const dbResult = await prisma.$transaction(
      async (tx) => {
        let appointment;
        let plan;
        let calculatedAmount = 0;

        // Get user profile based on appointment type
        const user = await tx.user.findUnique({
          where: { id: session.user.id },
          include: {
            consulteeProfile: true,
          },
        });

        if (!user?.consulteeProfile) {
          throw new Error("User profile not found");
        }

        // Handle different appointment types
        switch (validatedData.appointmentType) {
          case "CONSULTATION":
            ({
              appointment,
              plan,
              amount: calculatedAmount,
            } = await handleConsultationCheckout(
              tx,
              validatedData,
              user.consulteeProfile.id,
              skipPayment,
            ));
            break;

          case "SUBSCRIPTION":
            ({
              appointment,
              plan,
              amount: calculatedAmount,
            } = await handleSubscriptionCheckout(
              tx,
              validatedData,
              user.consulteeProfile.id,
              skipPayment,
            ));
            break;

          case "WEBINAR":
            ({
              appointment,
              plan,
              amount: calculatedAmount,
            } = await handleWebinarCheckout(
              tx,
              validatedData,
              user.id,
              skipPayment,
            ));
            break;

          case "CLASS":
            ({
              appointment,
              plan,
              amount: calculatedAmount,
            } = await handleClassCheckout(
              tx,
              validatedData,
              user.id,
              skipPayment,
            ));
            break;

          default:
            throw new Error("Invalid appointment type");
        }

        // Apply discount if provided
        let discountCodeId = null;
        if (validatedData.discountCode) {
          const discount = await tx.discountCode.findUnique({
            where: { code: validatedData.discountCode },
          });

          if (discount) {
            discountCodeId = discount.id;
            calculatedAmount =
              discount.discountType === "PERCENTAGE"
                ? calculatedAmount * (1 - discount.discountValue / 100)
                : Math.max(0, calculatedAmount - discount.discountValue);
          }
        }

        // For skipped payments, handle everything in the transaction
        if (skipPayment) {
          // Create successful payment record for skipped payment
          await tx.payment.create({
            data: {
              amount: calculatedAmount,
              currency:
                validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD",
              paymentMethod: "SKIPPED",
              paymentIntent: `skip_${Date.now()}_${Math.random().toString(36).substring(7)}`,
              paymentGateway: validatedData.paymentGateway,
              paymentStatus: PaymentStatus.SUCCEEDED,
              userId: session.user.id,
              appointmentId: appointment.id,
              discountCodeId,
            },
          });

          // Immediately confirm the appointment
          await confirmAppointment(
            tx,
            appointment.id,
            validatedData.appointmentType,
          );

          return {
            skipPayment: true,
            appointmentId: appointment.id,
            amount: calculatedAmount,
            currency:
              validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD",
            discountCodeId,
          };
        }

        // For real payments, just return the data needed for external API call
        return {
          skipPayment: false,
          appointmentId: appointment.id,
          amount: calculatedAmount,
          currency: validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD",
          discountCodeId,
        };
      },
      {
        // Add transaction options for better error handling
        maxWait: 10000, // 10 seconds max wait
        timeout: 30000, // 30 seconds timeout
      },
    );

    // If payment was skipped, return success immediately
    if (dbResult.skipPayment) {
      return NextResponse.json({
        success: true,
        message: "Appointment booked successfully (payment skipped)",
        appointmentId: dbResult.appointmentId,
        skipPayment: true,
      });
    }

    // Step 2: For real payments, make external API call outside transaction
    appointmentId = dbResult.appointmentId;
    amount = dbResult.amount;
    currency = dbResult.currency;

    let paymentResponse;
    try {
      // External API call happens outside the database transaction
      paymentResponse = await createPaymentIntent({
        amount,
        currency,
        metadata: {
          appointmentId,
          userId: session.user.id,
          appointmentType: validatedData.appointmentType,
        },
        paymentGateway: validatedData.paymentGateway,
      });
    } catch (paymentError) {
      // If payment intent creation fails, rollback the appointment
      console.error("Payment intent creation failed:", paymentError);

      try {
        await rollbackAppointment(appointmentId, validatedData.appointmentType);
      } catch (rollbackError) {
        console.error("Failed to rollback appointment:", rollbackError);
      }

      throw new Error(
        "Failed to create payment intent. Appointment has been cancelled.",
      );
    }

    // Step 3: Create payment record in a separate transaction
    try {
      await prisma.payment.create({
        data: {
          amount,
          currency,
          paymentMethod: "CARD",
          paymentIntent: paymentResponse.id,
          paymentGateway: validatedData.paymentGateway,
          paymentStatus: PaymentStatus.PENDING,
          userId: session.user.id,
          appointmentId,
          discountCodeId: dbResult.discountCodeId,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes from now
        },
      });
    } catch (paymentRecordError) {
      console.error("Failed to create payment record:", paymentRecordError);

      // Try to rollback both the payment intent and the appointment
      try {
        // Note: You might want to implement payment intent cancellation here
        // depending on your payment gateway's API
        await rollbackAppointment(appointmentId, validatedData.appointmentType);
      } catch (rollbackError) {
        console.error("Failed to rollback appointment:", rollbackError);
      }

      throw new Error(
        "Failed to record payment information. Appointment has been cancelled.",
      );
    }

    return NextResponse.json({
      success: true,
      paymentIntent: paymentResponse,
      appointmentId,
      amount,
      currency,
    });
  } catch (error) {
    console.error("Checkout error:", error);

    // Provide specific error messages for different types of failures
    let errorMessage = "Checkout failed";
    let errorType = "UNKNOWN_ERROR";

    if (error instanceof Error) {
      // Payment gateway authentication errors
      if (
        error.message.includes("Authentication failed") ||
        error.message.includes("Invalid API key")
      ) {
        errorMessage =
          "Payment gateway configuration error. Please contact support.";
        errorType = "PAYMENT_CONFIG_ERROR";
      }
      // Prisma/Database errors
      else if (
        error.message.includes("Prisma") ||
        error.message.includes("database")
      ) {
        errorMessage = "Database error. Please try again or contact support.";
        errorType = "DATABASE_ERROR";
      }
      // Validation errors
      else if (error.message.includes("not found")) {
        errorMessage = error.message;
        errorType = "NOT_FOUND_ERROR";
      }
      // Slot availability errors
      else if (
        error.message.includes("slot") ||
        error.message.includes("availability")
      ) {
        errorMessage = error.message;
        errorType = "AVAILABILITY_ERROR";
      }
      // Payment intent creation errors
      else if (error.message.includes("Failed to create payment intent")) {
        errorMessage =
          "Payment processing unavailable. Please try again later or contact support.";
        errorType = "PAYMENT_PROCESSING_ERROR";
      } else {
        errorMessage = error.message;
      }
    }

    return NextResponse.json(
      {
        error: errorMessage,
        errorType,
        timestamp: new Date().toISOString(),
      },
      { status: 400 },
    );
  }
}

// Helper functions for different appointment types
async function handleConsultationCheckout(
  tx: Prisma.TransactionClient,
  data: CheckoutInput,
  consulteeProfileId: string,
  skipPayment: boolean,
) {
  const plan = await tx.consultationPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: {
        include: {
          user: true,
        },
      },
    },
  });

  if (!plan) {
    throw new Error("Consultation plan not found");
  }

  // Check slot availability
  await validateSlotAvailability(tx, data, consulteeProfileId);

  // Create consultation
  const consultation = await tx.consultation.create({
    data: {
      consultationPlanId: plan.id,
      requestStatus: skipPayment
        ? RequestStatus.APPROVED
        : RequestStatus.PENDING,
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      directlyBooked: true,
    },
  });

  // Create appointment
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: new Date(data.slotStartTimeInUTC!),
          slotEndTimeInUTC: new Date(data.slotEndTimeInUTC!),
          isTentative: !skipPayment,
        },
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

async function handleSubscriptionCheckout(
  tx: any,
  data: CheckoutInput,
  consulteeProfileId: string,
  skipPayment: boolean,
) {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: {
        include: {
          user: true,
        },
      },
    },
  });

  if (!plan) {
    throw new Error("Subscription plan not found");
  }

  // Check slot availability
  await validateSlotAvailability(tx, data, consulteeProfileId);

  // Calculate subscription end date
  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + plan.durationInMonths);

  // Create subscription
  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlanId: plan.id,
      requestStatus: skipPayment
        ? RequestStatus.APPROVED
        : RequestStatus.PENDING,
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      startDate,
      endDate,
    },
  });

  // Create appointment
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscriptionId: subscription.id,
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: new Date(data.slotStartTimeInUTC!),
          slotEndTimeInUTC: new Date(data.slotEndTimeInUTC!),
          isTentative: !skipPayment,
        },
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

async function handleWebinarCheckout(
  tx: any,
  data: CheckoutInput,
  userId: string,
  skipPayment: boolean,
) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    include: {
      webinarPlan: true,
      waitlist: true,
      appointment: {
        include: {
          slotsOfAppointment: true,
        },
      },
    },
  });

  if (!webinar) {
    throw new Error("Webinar not found");
  }

  const plan = webinar.webinarPlan;
  const currentParticipants =
    webinar.appointment?.slotsOfAppointment?.length || 0;

  // Check if max participants reached
  if (currentParticipants >= plan.maxParticipants) {
    if (skipPayment) {
      // Add to waitlist
      await tx.waitlist.create({
        data: {
          userId,
          webinarId: webinar.id,
        },
      });

      throw new Error("Webinar is full. Added to waitlist.");
    } else {
      throw new Error("Webinar is full");
    }
  }

  // Create appointment (reuse existing one or create new)
  let appointment = webinar.appointment;
  if (!appointment) {
    appointment = await tx.appointment.create({
      data: {
        appointmentType: AppointmentsType.WEBINAR,
        webinarId: webinar.id,
      },
    });
  }

  // Add user to webinar
  await tx.slotOfAppointment.create({
    data: {
      appointmentId: appointment.id,
      slotStartTimeInUTC:
        webinar.appointment?.slotsOfAppointment[0]?.slotStartTimeInUTC ||
        new Date(),
      slotEndTimeInUTC:
        webinar.appointment?.slotsOfAppointment[0]?.slotEndTimeInUTC ||
        new Date(),
      isTentative: !skipPayment,
      user: {
        connect: { id: userId },
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

async function handleClassCheckout(
  tx: any,
  data: CheckoutInput,
  userId: string,
  skipPayment: boolean,
) {
  const classInstance = await tx.class.findUnique({
    where: { id: data.eventId },
    include: {
      classPlan: true,
      waitlist: true,
      appointments: {
        include: {
          slotsOfAppointment: true,
        },
      },
    },
  });

  if (!classInstance) {
    throw new Error("Class not found");
  }

  const plan = classInstance.classPlan;
  const currentParticipants = classInstance.appointments.reduce(
    (total: number, apt: any) => total + apt.slotsOfAppointment.length,
    0,
  );

  // Check if max participants reached
  if (currentParticipants >= plan.maxParticipants) {
    if (skipPayment) {
      // Add to waitlist
      await tx.waitlist.create({
        data: {
          userId,
          classId: classInstance.id,
        },
      });

      throw new Error("Class is full. Added to waitlist.");
    } else {
      throw new Error("Class is full");
    }
  }

  // Create appointment for class
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CLASS,
      classId: classInstance.id,
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: classInstance.startDate || new Date(),
          slotEndTimeInUTC: classInstance.endDate || new Date(),
          isTentative: !skipPayment,
          user: {
            connect: { id: userId },
          },
        },
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

async function validateSlotAvailability(tx: any, data: CheckoutInput, userId?: string) {
  if (!data.slotStartTimeInUTC || !data.slotEndTimeInUTC) return;

  const slotStart = new Date(data.slotStartTimeInUTC);
  const slotEnd = new Date(data.slotEndTimeInUTC);

  // 1. Check for confirmed overlapping appointments (existing logic)
  const existingBooking = await tx.slotOfAppointment.findFirst({
    where: {
      AND: [
        {
          OR: [
            {
              AND: [
                { slotStartTimeInUTC: { lte: slotStart } },
                { slotEndTimeInUTC: { gt: slotStart } },
              ],
            },
            {
              AND: [
                { slotStartTimeInUTC: { lt: slotEnd } },
                { slotEndTimeInUTC: { gte: slotEnd } },
              ],
            },
          ],
        },
        { isTentative: false }, // Only confirmed bookings
      ],
    },
  });

  if (existingBooking) {
    throw new Error("Time slot is already booked");
  }

  // 2. Check for duplicate tentative bookings by the same user (NEW)
  if (userId) {
    const recentAttempt = await tx.slotOfAppointment.findFirst({
      where: {
        AND: [
          {
            OR: [
              {
                AND: [
                  { slotStartTimeInUTC: { lte: slotStart } },
                  { slotEndTimeInUTC: { gt: slotStart } },
                ],
              },
              {
                AND: [
                  { slotStartTimeInUTC: { lt: slotEnd } },
                  { slotEndTimeInUTC: { gte: slotEnd } },
                ],
              },
            ],
          },
          { isTentative: true },
          { 
            appointment: {
              payment: {
                some: {
                  AND: [
                    { userId: userId },
                    { paymentStatus: "PENDING" },
                    {
                      OR: [
                        { expiresAt: { gt: new Date() } }, // Not yet expired
                        { 
                          AND: [
                            { expiresAt: null }, // No expiration set
                            { createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } } // Within 5 min
                          ]
                        }
                      ]
                    }
                  ]
                }
              }
            }
          },
        ],
      },
      include: {
        appointment: {
          include: {
            payment: true
          }
        }
      }
    });

    if (recentAttempt) {
      throw new Error("You already have a pending booking for this time slot. Please complete your current payment or wait a few minutes to try again.");
    }
  }

  // 3. Check for excessive tentative bookings in general (rate limiting)
  const tentativeCount = await tx.slotOfAppointment.count({
    where: {
      AND: [
        {
          OR: [
            {
              AND: [
                { slotStartTimeInUTC: { lte: slotStart } },
                { slotEndTimeInUTC: { gt: slotStart } },
              ],
            },
            {
              AND: [
                { slotStartTimeInUTC: { lt: slotEnd } },
                { slotEndTimeInUTC: { gte: slotEnd } },
              ],
            },
          ],
        },
        { isTentative: true },
        { 
          appointment: {
            payment: {
              some: {
                AND: [
                  { paymentStatus: "PENDING" },
                  {
                    OR: [
                      { expiresAt: { gt: new Date() } }, // Not yet expired
                      { 
                        AND: [
                          { expiresAt: null }, // No expiration set
                          { createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } } // Within 30 min
                        ]
                      }
                    ]
                  }
                ]
              }
            }
          }
        },
      ],
    },
  });

  // Allow max 3 pending attempts for the same slot (prevents spam)
  if (tentativeCount >= 3) {
    throw new Error("This time slot is temporarily unavailable due to high demand. Please try again later.");
  }
}

async function confirmAppointment(
  tx: any,
  appointmentId: string,
  appointmentType: string,
) {
  // Make slot non-tentative
  await tx.slotOfAppointment.updateMany({
    where: { appointmentId },
    data: { isTentative: false },
  });

  // Update specific appointment type status
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
    },
  });

  if (appointment?.consultation) {
    await tx.consultation.update({
      where: { id: appointment.consultation.id },
      data: { requestStatus: RequestStatus.APPROVED },
    });
  }

  if (appointment?.subscription) {
    await tx.subscription.update({
      where: { id: appointment.subscription.id },
      data: { requestStatus: RequestStatus.APPROVED },
    });
  }

  if (appointment?.webinar) {
    await tx.webinar.update({
      where: { id: appointment.webinar.id },
      data: { status: WebinarStatus.SCHEDULED },
    });
  }

  if (appointment?.class) {
    await tx.class.update({
      where: { id: appointment.class.id },
      data: { status: ClassStatus.SCHEDULED },
    });
  }
}

// Function to rollback appointment when external operations fail
async function rollbackAppointment(
  appointmentId: string,
  appointmentType: string,
) {
  try {
    await prisma.$transaction(
      async (tx) => {
        // Get appointment with related data
        const appointment = await tx.appointment.findUnique({
          where: { id: appointmentId },
          include: {
            consultation: true,
            subscription: true,
            webinar: true,
            class: true,
            slotsOfAppointment: true,
          },
        });

        if (!appointment) {
          console.warn(`Appointment ${appointmentId} not found for rollback`);
          return;
        }

        // Remove user from slots for webinar/class (many-to-many relationships)
        if (appointmentType === "WEBINAR" || appointmentType === "CLASS") {
          // For webinar/class, we need to remove the user connection rather than delete the appointment
          await tx.slotOfAppointment.deleteMany({
            where: {
              appointmentId,
              isTentative: true, // Only remove tentative bookings
            },
          });
        } else {
          // For consultation/subscription, delete the entire appointment chain

          // Delete consultation if exists
          if (appointment.consultation) {
            await tx.consultation.delete({
              where: { id: appointment.consultation.id },
            });
          }

          // Delete subscription if exists
          if (appointment.subscription) {
            await tx.subscription.delete({
              where: { id: appointment.subscription.id },
            });
          }

          // Delete slots and appointment
          await tx.slotOfAppointment.deleteMany({
            where: { appointmentId },
          });

          await tx.appointment.delete({
            where: { id: appointmentId },
          });
        }

        console.log(`Successfully rolled back appointment ${appointmentId}`);
      },
      {
        timeout: 10000, // 10 second timeout for rollback
      },
    );
  } catch (rollbackError) {
    const errorMessage =
      rollbackError instanceof Error ? rollbackError.message : "Unknown error";
    console.error(
      `Failed to rollback appointment ${appointmentId}:`,
      rollbackError,
    );
    // Re-throw to let the caller know rollback failed
    throw new Error(`Rollback failed: ${errorMessage}`);
  }
}
