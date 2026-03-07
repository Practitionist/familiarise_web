import prisma from "@/lib/prisma";
import {
  PaymentGateway,
  PaymentStatus,
  Prisma,
  RequestStatus,
} from "@prisma/client";
import { addMonths } from "date-fns";
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
import {
  UpdateSubscriptionSchema,
  PatchSubscriptionStatusSchema,
} from "@/schemas/subscriptions";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

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
  _request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  // Require authentication
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

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

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!subscriptionData.subscriptionPlan?.consultantProfile?.id &&
      subscriptionData.subscriptionPlan.consultantProfile.id ===
      session.user.consultantProfileId;
    const isConsultee =
      !!subscriptionData.requestedById && subscriptionData.requestedById === session.user.consulteeProfileId;
    if (!isPrivileged(session.user.role) && !isConsultant && !isConsultee) {
      return forbiddenResponse(
        "You can only view subscriptions you are a participant in",
      );
    }

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
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  // Require authentication
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { subscriptionId } = await params;
    const body = await request.json();
    const result = UpdateSubscriptionSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const validatedData = result.data;

    // Verify ownership before allowing update
    const existingSubscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        subscriptionPlan: {
          include: {
            consultantProfile: true,
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

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!existingSubscription.subscriptionPlan?.consultantProfile?.id &&
      existingSubscription.subscriptionPlan.consultantProfile.id ===
      session.user.consultantProfileId;
    const isConsultee =
      !!existingSubscription.requestedById && existingSubscription.requestedById === session.user.consulteeProfileId;
    if (!isPrivileged(session.user.role) && !isConsultant && !isConsultee) {
      return forbiddenResponse(
        "You can only modify subscriptions you are a participant in",
      );
    }

    const subscriptionData = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        schedulingPeriodStartsAt: validatedData.schedulingPeriodStartsAt,
        schedulingPeriodEndsAt: validatedData.schedulingPeriodEndsAt,
        requestStatus: validatedData.requestStatus,
        requestNotes: validatedData.requestNotes,
        feedbackFromConsultee: validatedData.feedbackFromConsultee,
        feedbackFromConsultant: validatedData.feedbackFromConsultant,
        rating: validatedData.rating,
        subscriptionPlan: validatedData.planId
          ? {
              connect: { id: validatedData.planId },
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
  _request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  // Require authentication
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  // Only ADMIN can delete subscriptions
  if (session.user.role !== "ADMIN") {
    return forbiddenResponse("Only administrators can delete subscriptions");
  }

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
  // Require authentication
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const body = await request.json();
    const patchResult = PatchSubscriptionStatusSchema.safeParse(body);
    if (!patchResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: patchResult.error.issues },
        { status: 400 },
      );
    }
    const { status } = patchResult.data;
    const { subscriptionId } = await params;

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

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!existingSubscription.subscriptionPlan?.consultantProfile?.id &&
      existingSubscription.subscriptionPlan.consultantProfile.id ===
      session.user.consultantProfileId;
    const isConsultee =
      !!existingSubscription.requestedById && existingSubscription.requestedById === session.user.consulteeProfileId;
    if (!isPrivileged(session.user.role) && !isConsultant && !isConsultee) {
      return forbiddenResponse(
        "You can only modify subscriptions you are a participant in",
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

              // Confirm existing tentative appointments by setting slots to non-tentative.
              // Appointment slots are created by SlotAllocationService during checkout/allocation,
              // not by this status handler. If no appointments exist here, that's expected for
              // approval-pending-payment flows where slots get allocated after payment succeeds.
              if (
                subscription.appointments &&
                subscription.appointments.length > 0
              ) {
                for (const appointment of subscription.appointments) {
                  await tx.slotOfAppointment.updateMany({
                    where: { appointmentId: appointment.id },
                    data: { isTentative: false },
                  });
                }
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
