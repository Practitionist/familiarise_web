import prisma from "@/lib/prisma";
import {
  AppointmentsType,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  RequestStatus,
} from "@prisma/client";
import { addMonths, addWeeks, setHours, setMinutes } from "date-fns";
import { NextRequest, NextResponse } from "next/server";
import { createApprovalPaymentIntent } from "@/lib/payments/operations/approval-payment";
import { APPROVAL_PAYMENT_EXPIRATION_MS } from "@/lib/payments/constants";
import {
  lockSubscriptionApproval,
  unlockApproval,
} from "@/utils/appointmentlock";
import { sendPaymentLinkEmail } from "@/lib/email";
import {
  notifySubscriptionStarted,
  notifySubscriptionCancelled,
} from "@/lib/novu";

/**
 * Type for subscription with all related details needed for payment processing
 */
type SubscriptionWithDetails = Prisma.SubscriptionGetPayload<{
  include: {
    subscriptionPlan: {
      include: {
        consultantProfile: {
          include: {
            user: true;
          };
        };
      };
    };
    requestedBy: {
      include: {
        user: true;
      };
    };
    appointments: {
      include: {
        slotsOfAppointment: {
          include: {
            user: true;
          };
        };
      };
    };
  };
}>;

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
        schedulingPeriodStartsAt: body.schedulingPeriodStartsAt,
        schedulingPeriodEndsAt: body.schedulingPeriodEndsAt,
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

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 },
      );
    }

    const { status } = body as { status: RequestStatus };
    const { subscriptionId } = await params;

    if (!status) {
      return NextResponse.json(
        { error: "Status is required" },
        { status: 400 },
      );
    }

    if (!Object.values(RequestStatus).includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
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

    // LAYER 1: Distributed lock (only for APPROVED status changes)
    let lock;
    if (status === RequestStatus.APPROVED) {
      try {
        lock = await lockSubscriptionApproval(subscriptionId, 30000); // 30-second TTL
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error ? error.message : "Failed to acquire lock",
          },
          { status: 409 }, // Conflict - another approval in progress
        );
      }
    }

    try {
      // LAYER 2: Serializable transaction with idempotency checks
      const result = await prisma.$transaction(
        async (tx) => {
          // Fetch current state inside transaction
          const currentSubscription = await tx.subscription.findUnique({
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

          if (!currentSubscription) {
            throw new Error("Subscription not found");
          }

          // IDEMPOTENCY: Check if already in target state or processing
          if (status === RequestStatus.APPROVED) {
            if (
              currentSubscription.requestStatus ===
              RequestStatus.APPROVED_PENDING_PAYMENT
            ) {
              // Already processing, return existing state
              return {
                data: currentSubscription,
                message: "Approval already in progress",
                duplicate: true,
              };
            }

            if (currentSubscription.requestStatus === RequestStatus.APPROVED) {
              return {
                data: currentSubscription,
                message: "Already approved",
                duplicate: true,
              };
            }
          }

          // Update subscription status
          const subscription = await tx.subscription.update({
            where: { id: subscriptionId },
            data: {
              requestStatus: status,
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

          // If approved, check if payment exists
          if (status === RequestStatus.APPROVED) {
            const hasPayment = await checkSubscriptionPayment(
              tx,
              subscription.id,
            );

            if (hasPayment) {
              // Payment already exists - update scheduling dates
              await tx.subscription.update({
                where: { id: subscriptionId },
                data: {
                  schedulingPeriodStartsAt: startDate,
                  schedulingPeriodEndsAt: endDate,
                },
              });

              // Check if tentative appointments already exist
              if (
                subscription.appointments &&
                subscription.appointments.length > 0
              ) {
                // Confirm existing tentative appointments by setting slots to non-tentative
                for (const appointment of subscription.appointments) {
                  await tx.slotOfAppointment.updateMany({
                    where: { appointmentId: appointment.id },
                    data: { isTentative: false },
                  });
                }
              } else {
                // Only create new appointments if none exist (direct checkout flow)
                await createAppointmentsForSubscription(subscription, tx);
              }
              return { data: subscription, duplicate: false };
            } else {
              // No payment - generate payment link
              const paymentResult = await generatePaymentLinkForSubscription(
                subscription,
                startDate,
                endDate,
              );

              // Update status to APPROVED_PENDING_PAYMENT
              const updatedSubscription = await tx.subscription.update({
                where: { id: subscriptionId },
                data: {
                  requestStatus: RequestStatus.APPROVED_PENDING_PAYMENT,
                  schedulingPeriodStartsAt: startDate,
                  schedulingPeriodEndsAt: endDate,
                  pendingPaymentUrl: paymentResult.checkoutUrl,
                  requestNotes: subscription.requestNotes
                    ? `${subscription.requestNotes}\n\n[System] Payment link generated and sent to user.`
                    : `[System] Payment link generated and sent to user.`,
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

              // Return email data to send AFTER transaction commits
              // This prevents holding serializable locks during slow email network calls
              return {
                data: updatedSubscription,
                message: "Subscription approved. Payment link sent to user.",
                paymentUrl: paymentResult.checkoutUrl,
                requiresPayment: true,
                paymentAmount: paymentResult.amount,
                paymentCurrency: paymentResult.currency,
                duplicate: false,
                emailData: {
                  email: updatedSubscription.requestedBy.user.email || "",
                  name: updatedSubscription.requestedBy.user.name || "User",
                  consultantName:
                    updatedSubscription.subscriptionPlan.consultantProfile.user
                      .name || "Consultant",
                  appointmentType: "subscription" as const,
                  amount: paymentResult.amount,
                  currency: paymentResult.currency,
                  paymentUrl: paymentResult.checkoutUrl,
                  expiresAt: new Date(
                    Date.now() + APPROVAL_PAYMENT_EXPIRATION_MS,
                  ),
                },
              };
            }
          }

          return { data: subscription, duplicate: false };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable, // LAYER 2: Highest isolation
          maxWait: 10000, // 10 seconds
          timeout: 30000, // 30 seconds
        },
      );

      // If duplicate, return early
      if (result.duplicate) {
        return NextResponse.json({
          data: result.data,
          message: result.message,
        });
      }

      // Send email AFTER transaction commits - prevents holding locks during slow network calls
      // User can still find the payment link on their dashboard via pendingPaymentUrl if email fails
      if ("emailData" in result && result.emailData) {
        try {
          await sendPaymentLinkEmail(result.emailData);
          console.log(
            `📧 Payment link email sent for subscription ${subscriptionId}`,
          );
        } catch (emailError) {
          console.error(
            `⚠️ Failed to send payment link email for subscription ${subscriptionId}:`,
            emailError instanceof Error ? emailError.message : "Unknown error",
          );
        }
      }

      // Fire-and-forget: send Novu notifications for non-duplicate status changes
      if (!result.duplicate && "data" in result && result.data) {
        const subData = result.data;
        const consulteeUserId = subData.requestedBy?.user?.id;
        const consultantUserId =
          subData.subscriptionPlan?.consultantProfile?.user?.id;

        if (status === RequestStatus.APPROVED && consulteeUserId) {
          void notifySubscriptionStarted(consulteeUserId, {
            subscriptionId: subData.id,
            planTitle: subData.subscriptionPlan?.title || "Subscription",
            consultantName:
              subData.subscriptionPlan?.consultantProfile?.user?.name ||
              "Consultant",
            consulteeName: subData.requestedBy?.user?.name || undefined,
            dashboardUrl: "/dashboard",
          });
        }

        if (status === RequestStatus.CANCELLED) {
          const userIds = [consultantUserId, consulteeUserId].filter(
            (id): id is string => !!id,
          );
          if (userIds.length > 0) {
            void notifySubscriptionCancelled(userIds, {
              subscriptionId: subData.id,
              planTitle: subData.subscriptionPlan?.title || "Subscription",
              consultantName:
                subData.subscriptionPlan?.consultantProfile?.user?.name ||
                "Consultant",
              consulteeName: subData.requestedBy?.user?.name || undefined,
              dashboardUrl: "/dashboard",
            });
          }
        }
      }

      // Return success response (exclude emailData from response)
      const { emailData: _emailData, ...responseData } =
        result as typeof result & { emailData?: unknown };
      return NextResponse.json(responseData);
    } catch (error) {
      console.error(
        "Transaction error:",
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    } finally {
      // LAYER 1: Always release lock
      if (lock) {
        await unlockApproval(lock);
      }
    }
  } catch (error) {
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

/**
 * Check if payment exists for this subscription
 * Uses transaction client to maintain serializable isolation
 */
async function checkSubscriptionPayment(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
): Promise<boolean> {
  const subscription = await tx.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      appointments: {
        include: {
          payment: {
            where: {
              paymentStatus: {
                in: [PaymentStatus.SUCCEEDED, PaymentStatus.PENDING],
              },
            },
          },
        },
      },
    },
  });

  return (
    subscription?.appointments?.some((apt) => (apt.payment?.length ?? 0) > 0) ??
    false
  );
}

/**
 * Generate payment link for approved subscription
 */
async function generatePaymentLinkForSubscription(
  subscription: SubscriptionWithDetails,
  schedulingPeriodStartsAt: Date,
  schedulingPeriodEndsAt: Date,
) {
  const { subscriptionPlan, requestedBy } = subscription;

  return await createApprovalPaymentIntent({
    userId: requestedBy.user.id,
    appointmentType: "SUBSCRIPTION",
    subscriptionId: subscription.id,
    planId: subscriptionPlan.id,
    paymentGateway: PaymentGateway.STRIPE, // Default to Stripe, could be made configurable
    schedulingPeriodStartsAt: schedulingPeriodStartsAt.toISOString(),
    schedulingPeriodEndsAt: schedulingPeriodEndsAt.toISOString(),
    notes: subscription.requestNotes ?? undefined,
  });
}

async function createAppointmentsForSubscription(
  subscription: SubscriptionWithDetails,
  tx: Prisma.TransactionClient,
) {
  const { subscriptionPlan, requestedBy } = subscription;

  if (!subscriptionPlan?.durationInMonths || !subscriptionPlan?.callsPerWeek) {
    console.error("Missing subscription plan details:", subscriptionPlan);
    throw new Error("Invalid subscription plan details");
  }

  const sessionDuration = subscriptionPlan.sessionDurationInHours ?? 1;

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

  const startDate = subscription.schedulingPeriodStartsAt || new Date();
  const endDate =
    subscription.schedulingPeriodEndsAt ||
    addMonths(startDate, subscriptionPlan.durationInMonths);
  const appointments = [];

  // Prepare all appointment data first
  const allAppointmentData = [];
  let currentDate = startDate;

  while (currentDate < endDate) {
    // Create callsPerWeek appointments for this week
    for (let i = 0; i < subscriptionPlan.callsPerWeek; i++) {
      const appointmentDate = setHours(setMinutes(currentDate, 0), 10);

      // Check if appointment already exists for this time slot using transaction
      const existingAppointment = await tx.appointment.findFirst({
        where: {
          subscription: { id: subscription.id },
          slotsOfAppointment: {
            some: {
              startsAt: appointmentDate,
            },
          },
        },
      });

      if (!existingAppointment) {
        allAppointmentData.push({
          appointmentType: AppointmentsType.SUBSCRIPTION,
          subscription: {
            connect: { id: subscription.id },
          },
          slotsOfAppointment: {
            create: {
              startsAt: appointmentDate,
              endsAt: addHours(appointmentDate, sessionDuration),
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
      }
    }
    currentDate = addWeeks(currentDate, 1);
  }

  // Process appointments in batches
  const batchSize = 10;
  for (let i = 0; i < allAppointmentData.length; i += batchSize) {
    const batch = allAppointmentData.slice(i, i + batchSize);
    try {
      const createdAppointments = await Promise.all(
        batch.map((appointmentData) =>
          tx.appointment.create({
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
    } catch (error) {
      console.error(
        `Error creating appointments batch ${i / batchSize + 1}:`,
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    }
  }

  return appointments;
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}
