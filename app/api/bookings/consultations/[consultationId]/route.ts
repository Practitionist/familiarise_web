import prisma, { type Tx } from "@/lib/prisma";
import {
  AppointmentsType,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  AppointmentStatus,
} from "@prisma/client";
import { z } from "zod";
import { addHours } from "date-fns";
import { NextRequest, NextResponse } from "next/server";
import { createApprovalPaymentIntent } from "@/lib/payments/operations/approval-payment";
import { APPROVAL_PAYMENT_EXPIRATION_MS } from "@/lib/payments/constants";
import {
  lockConsultationApproval,
  unlockApproval,
} from "@/utils/appointmentlock";
import { transitionConsultationRequest } from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { MAX_TEXT_LENGTH } from "@/lib/validation/limits";
import { sendPaymentLinkEmail } from "@/lib/email";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { addUserToEventChannel } from "@/actions/stream/chat/event-channel.action";
import { createDirectMessageChannel } from "@/actions/stream/chat/channel.action";
import { streamLogger } from "@/lib/stream-logger";

/**
 * Type for consultation with all related details needed for payment processing.
 * Derived via the extended client — raw GetPayload would re-introduce bigint
 * money fields (#780).
 */
type ConsultationWithDetails = Prisma.Result<
  typeof prisma.consultation,
  {
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
  },
  "findFirstOrThrow"
>;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
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
      !!consultantProfileId &&
      consultantProfileId === session.user.consultantProfileId;
    const isConsultee =
      !!consulteeProfileId &&
      consulteeProfileId === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only view consultations you are a participant in",
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
        { status: 404 },
      );
    }
    console.error("Error fetching consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the consultation" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
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
        { status: 404 },
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!existingConsultation.consultationPlan?.consultantProfile?.id &&
      existingConsultation.consultationPlan.consultantProfile.id ===
        session.user.consultantProfileId;
    const isConsultee =
      !!existingConsultation.requestedById &&
      existingConsultation.requestedById === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only update consultations you are a participant in",
      );
    }

    const body = await request.json();

    // Validate body to prevent arbitrary field injection
    // #836 — status is NOT writable here: status changes flow only
    // through PATCH, where the allowed-from guard rides the WHERE clause.
    // #831 — user-typed strings carry a .max()
    const consultationPutSchema = z
      .object({
        requestNotes: z.string().max(MAX_TEXT_LENGTH).nullish(),
        bookingSource: z
          .enum(["DIRECT_CHECKOUT", "REQUEST_SUBMITTED"])
          .optional(),
        feedbackFromConsultee: z.string().max(MAX_TEXT_LENGTH).nullish(),
        feedbackFromConsultant: z.string().max(MAX_TEXT_LENGTH).nullish(),
        rating: z.number().min(1).max(5).nullish(),
        planId: z.string().optional(),
      })
      .strict();

    const parseResult = consultationPutSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: "Invalid request body",
          details: parseResult.error.flatten().fieldErrors,
        },
        { status: 400 },
      );
    }
    const validatedBody = parseResult.data;

    const consultationData = await prisma.consultation.update({
      where: { id: consultationId },
      data: {
        requestNotes: validatedBody.requestNotes,
        bookingSource: validatedBody.bookingSource,
        feedbackFromConsultee: validatedBody.feedbackFromConsultee,
        feedbackFromConsultant: validatedBody.feedbackFromConsultant,
        rating: validatedBody.rating,
        consultationPlan: validatedBody.planId
          ? {
              connect: { id: validatedBody.planId },
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
  { params }: { params: Promise<{ consultationId: string }> },
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
        { status: 404 },
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!existingConsultation.consultationPlan?.consultantProfile?.id &&
      existingConsultation.consultationPlan.consultantProfile.id ===
        session.user.consultantProfileId;
    const isConsultee =
      !!existingConsultation.requestedById &&
      existingConsultation.requestedById === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only delete consultations you are a participant in",
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
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const body = await request.json();
    const { consultationId } = await params;

    const consultationPatchSchema = z.object({
      status: z.nativeEnum(AppointmentStatus),
    });

    const parseResult = consultationPatchSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parseResult.error.format() },
        { status: 400 },
      );
    }

    const { status } = parseResult.data;

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
        { status: 400 },
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!existingConsultation.consultationPlan?.consultantProfile?.id &&
      existingConsultation.consultationPlan.consultantProfile.id ===
        session.user.consultantProfileId;
    const isConsultee =
      !!existingConsultation.requestedById &&
      existingConsultation.requestedById === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only update consultations you are a participant in",
      );
    }

    // LAYER 1: Distributed lock (only for APPROVED status changes)
    let lock;
    if (status === AppointmentStatus.APPROVED) {
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
          if (status === AppointmentStatus.APPROVED) {
            if (
              currentConsultation.status ===
              AppointmentStatus.APPROVED_PENDING_PAYMENT
            ) {
              // Already processing, return existing state
              return {
                data: currentConsultation,
                message: "Approval already in progress",
                duplicate: true,
              };
            }

            if (currentConsultation.status === AppointmentStatus.APPROVED) {
              return {
                data: currentConsultation,
                message: "Already approved",
                duplicate: true,
              };
            }
          }

          // #836 — allowed-from guard rides the WHERE; the idempotency
          // pre-checks above are only friendly error text. updateMany
          // returns no row, so re-read for the heavy include.
          await transitionConsultationRequest(tx, {
            where: { id: consultationId },
            to: status,
          });
          const consultation = await tx.consultation.findUniqueOrThrow({
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

          // If approved, check if payment exists
          if (status === AppointmentStatus.APPROVED) {
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

              // Update status to APPROVED_PENDING_PAYMENT — guarded (#836)
              await transitionConsultationRequest(tx, {
                where: { id: consultationId },
                to: AppointmentStatus.APPROVED_PENDING_PAYMENT,
                data: {
                  pendingPaymentUrl: paymentResult.checkoutUrl,
                  requestNotes: consultation.requestNotes
                    ? `${consultation.requestNotes}\n\n[System] Payment link generated and sent to user.`
                    : `[System] Payment link generated and sent to user.`,
                },
              });
              const updatedConsultation = await tx.consultation.findUniqueOrThrow({
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

      // --- Stream channel creation (fire-and-forget, only on approval) ---
      if (!result.duplicate && status === AppointmentStatus.APPROVED)
        try {
          const consultationData = result.data;
          const consultantUserId =
            consultationData.consultationPlan?.consultantProfile?.userId;
          const consulteeUserId = consultationData.requestedBy?.userId;

          if (consultantUserId && consulteeUserId) {
            await addUserToEventChannel(
              "consultation",
              consultationId,
              consulteeUserId,
            );
            await createDirectMessageChannel(consultantUserId, consulteeUserId);
            streamLogger.info(
              "Stream channel created on consultation approval",
              {
                consultationId,
              },
            );
          }
        } catch (channelError) {
          streamLogger.error(
            "Auto-channel creation failed on consultation approval",
            channelError,
            { consultationId },
          );
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
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
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
  tx: Tx,
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
  const startsAt = slot?.startsAt?.toISOString();
  const endsAt = slot?.endsAt?.toISOString();

  return await createApprovalPaymentIntent({
    userId: requestedBy.user.id,
    appointmentType: "CONSULTATION",
    consultationId: consultation.id,
    planId: consultationPlan.id,
    paymentGateway: PaymentGateway.STRIPE, // Default to Stripe, could be made configurable
    startsAt,
    endsAt,
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
