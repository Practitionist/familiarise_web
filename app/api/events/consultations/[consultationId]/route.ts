import prisma from "@/lib/prisma";
import {
  AppointmentsType,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  RequestStatus,
} from "@prisma/client";
import { addHours } from "date-fns";
import { NextRequest, NextResponse } from "next/server";
import { createApprovalPaymentIntent } from "@/lib/payments/operations/approval-payment";
import { APPROVAL_PAYMENT_EXPIRATION_MS } from "@/lib/payments/constants";
import {
  lockConsultationApproval,
  unlockApproval,
} from "@/utils/appointmentlock";
import { sendPaymentLinkEmail } from "@/lib/email";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

/**
 * Type for consultation with all related details needed for payment processing
 */
type ConsultationWithDetails = Prisma.ConsultationGetPayload<{
  include: {
    consultationPlan: {
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
    appointment: {
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
  { params }: { params: Promise<{ consultationId: string }> }
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { consultationId } = await params;
    const consultationData = await prisma.consultation.findUniqueOrThrow({
      where: { id: consultationId },
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
    const consultantProfileId =
      consultationData.consultationPlan?.consultantProfile?.id;
    const consulteeProfileId = consultationData.requestedBy?.id;
    const isConsultant =
      consultantProfileId === session.user.consultantProfileId;
    const isConsultee = consulteeProfileId === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only view consultations you are a participant in"
      );
    }

    return NextResponse.json({ data: consultationData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 }
      );
    }
    console.error("Error fetching consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the consultation" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> }
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { consultationId } = await params;

    // Fetch the consultation to check ownership
    const existingConsultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: true,
          },
        },
      },
    });

    if (!existingConsultation) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 }
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      existingConsultation.consultationPlan?.consultantProfile?.id ===
      session.user.consultantProfileId;
    const isConsultee =
      existingConsultation.requestedById === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only update consultations you are a participant in"
      );
    }

    const body = await request.json();

    const consultationData = await prisma.consultation.update({
      where: { id: consultationId },
      data: {
        requestStatus: body.requestStatus,
        requestNotes: body.requestNotes,
        bookingSource: body.bookingSource,
        feedbackFromConsultee: body.feedbackFromConsultee,
        feedbackFromConsultant: body.feedbackFromConsultant,
        rating: body.rating,
        consultationPlan: body.planId
          ? {
              connect: { id: body.planId },
            }
          : undefined,
      },
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

    return NextResponse.json({ data: consultationData }, { status: 200 });
  } catch (error) {
    console.error("Error updating consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the consultation" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> }
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { consultationId } = await params;

    // Fetch the consultation to check ownership
    const existingConsultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: true,
          },
        },
      },
    });

    if (!existingConsultation) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 }
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      existingConsultation.consultationPlan?.consultantProfile?.id ===
      session.user.consultantProfileId;
    const isConsultee =
      existingConsultation.requestedById === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only delete consultations you are a participant in"
      );
    }

    const consultationData = await prisma.consultation.delete({
      where: { id: consultationId },
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

    return NextResponse.json({ data: consultationData }, { status: 200 });
  } catch (error) {
    console.error("Error deleting consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the consultation" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ consultationId: string }> }
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const body = await request.json();

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    const { status } = body as { status: RequestStatus };
    const { consultationId } = await params;

    if (!status) {
      return NextResponse.json(
        { error: "Status is required" },
        { status: 400 }
      );
    }

    if (!Object.values(RequestStatus).includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    // First fetch the consultation to validate it exists and get all necessary data
    const existingConsultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
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

    if (!existingConsultation) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 },
      );
    }

    if (!existingConsultation.consultationPlan?.consultantProfile?.user?.id) {
      return NextResponse.json(
        { error: "Invalid consultation: missing consultant information" },
        { status: 400 },
      );
    }

    if (!existingConsultation.requestedBy?.user?.id) {
      return NextResponse.json(
        { error: "Invalid consultation: missing requestedBy information" },
        { status: 400 }
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      existingConsultation.consultationPlan?.consultantProfile?.id ===
      session.user.consultantProfileId;
    const isConsultee =
      existingConsultation.requestedById === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only update consultations you are a participant in"
      );
    }

    // LAYER 1: Distributed lock (only for APPROVED status changes)
    let lock;
    if (status === RequestStatus.APPROVED) {
      try {
        lock = await lockConsultationApproval(consultationId, 30000); // 30-second TTL
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
          const currentConsultation = await tx.consultation.findUnique({
            where: { id: consultationId },
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
              appointment: {
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

          if (!currentConsultation) {
            throw new Error("Consultation not found");
          }

          // IDEMPOTENCY: Check if already in target state or processing
          if (status === RequestStatus.APPROVED) {
            if (
              currentConsultation.requestStatus ===
              RequestStatus.APPROVED_PENDING_PAYMENT
            ) {
              // Already processing, return existing state
              return {
                data: currentConsultation,
                message: "Approval already in progress",
                duplicate: true,
              };
            }

            if (currentConsultation.requestStatus === RequestStatus.APPROVED) {
              return {
                data: currentConsultation,
                message: "Already approved",
                duplicate: true,
              };
            }
          }

          // Update consultation status
          const consultation = await tx.consultation.update({
            where: { id: consultationId },
            data: {
              requestStatus: status,
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
              appointment: {
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
            const hasPayment = await checkConsultationPayment(
              tx,
              consultation.id,
            );

            if (hasPayment) {
              // Payment already exists - check if tentative appointment exists
              if (consultation.appointment) {
                // Confirm existing tentative appointment by setting slots to non-tentative
                await tx.slotOfAppointment.updateMany({
                  where: { appointmentId: consultation.appointment.id },
                  data: { isTentative: false },
                });
              } else {
                // Only create new appointment if none exists (direct checkout flow)
                await createAppointmentForConsultation(consultation);
              }
              return { data: consultation, duplicate: false };
            } else {
              // No payment - generate payment link
              const paymentResult = await generatePaymentLink(consultation);

              // Update status to APPROVED_PENDING_PAYMENT
              const updatedConsultation = await tx.consultation.update({
                where: { id: consultationId },
                data: {
                  requestStatus: RequestStatus.APPROVED_PENDING_PAYMENT,
                  pendingPaymentUrl: paymentResult.checkoutUrl,
                  requestNotes: consultation.requestNotes
                    ? `${consultation.requestNotes}\n\n[System] Payment link generated and sent to user.`
                    : `[System] Payment link generated and sent to user.`,
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
                  appointment: {
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
                data: updatedConsultation,
                message: "Consultation approved. Payment link sent to user.",
                paymentUrl: paymentResult.checkoutUrl,
                requiresPayment: true,
                paymentAmount: paymentResult.amount,
                paymentCurrency: paymentResult.currency,
                duplicate: false,
                emailData: {
                  email: updatedConsultation.requestedBy.user.email || "",
                  name: updatedConsultation.requestedBy.user.name || "User",
                  consultantName:
                    updatedConsultation.consultationPlan.consultantProfile.user
                      .name || "Consultant",
                  appointmentType: "consultation" as const,
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

          return { data: consultation, duplicate: false };
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
            `📧 Payment link email sent for consultation ${consultationId}`,
          );
        } catch (emailError) {
          console.error(
            `⚠️ Failed to send payment link email for consultation ${consultationId}:`,
            emailError instanceof Error ? emailError.message : "Unknown error",
          );
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
      "Error updating consultation:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "An error occurred while updating consultation" },
      { status: 500 },
    );
  }
}

/**
 * Check if payment exists for this consultation
 * Uses transaction client to maintain serializable isolation
 */
async function checkConsultationPayment(
  tx: Prisma.TransactionClient,
  consultationId: string,
): Promise<boolean> {
  const consultation = await tx.consultation.findUnique({
    where: { id: consultationId },
    include: {
      appointment: {
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

  return (consultation?.appointment?.payment?.length ?? 0) > 0;
}

/**
 * Generate payment link for approved consultation
 */
async function generatePaymentLink(consultation: ConsultationWithDetails) {
  const { consultationPlan, requestedBy, appointment } = consultation;

  // Extract slot times if appointment/slots exist
  const slot = appointment?.slotsOfAppointment?.[0];
  const slotStartTimeInUTC = slot?.startsAt?.toISOString();
  const slotEndTimeInUTC = slot?.endsAt?.toISOString();

  return await createApprovalPaymentIntent({
    userId: requestedBy.user.id,
    appointmentType: "CONSULTATION",
    consultationId: consultation.id,
    planId: consultationPlan.id,
    paymentGateway: PaymentGateway.STRIPE, // Default to Stripe, could be made configurable
    slotStartTimeInUTC,
    slotEndTimeInUTC,
    notes: consultation.requestNotes ?? undefined,
  });
}

async function createAppointmentForConsultation(
  consultation: ConsultationWithDetails,
) {
  const { consultationPlan, requestedBy } = consultation;

  if (!consultationPlan?.durationInHours) {
    console.error("Missing consultation plan details:", consultationPlan);
    throw new Error("Invalid consultation plan details");
  }

  if (
    !requestedBy?.user?.id ||
    !consultationPlan?.consultantProfile?.user?.id
  ) {
    console.error("Missing user information:", {
      requestedBy,
      consultantProfile: consultationPlan.consultantProfile,
    });
    throw new Error("Missing user information");
  }

  // Set default appointment time to now + 1 hour
  const startDate = new Date();
  startDate.setMinutes(0); // Reset minutes to start of hour
  startDate.setHours(startDate.getHours() + 1); // Start next hour

  try {
    const appointment = await prisma.appointment.create({
      data: {
        appointmentType: AppointmentsType.CONSULTATION,
        consultation: {
          connect: { id: consultation.id },
        },
        slotsOfAppointment: {
          create: {
            startsAt: startDate,
            endsAt: addHours(startDate, consultationPlan.durationInHours),
            isTentative: false,
            user: {
              connect: [
                { id: requestedBy.user.id },
                { id: consultationPlan.consultantProfile.user.id },
              ],
            },
          },
        },
      },
      include: {
        slotsOfAppointment: {
          include: {
            user: true,
          },
        },
      },
    });

    return appointment;
  } catch (error) {
    console.error(`Error creating appointment:`, error);
    throw error;
  }
}
