import * as Sentry from "@sentry/nextjs";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import prisma, { type Tx } from "@/lib/prisma";
import { PaymentStatus, Prisma, AppointmentStatus } from "@prisma/client";
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { mintApprovalPaymentAfterCommit } from "@/lib/booking/approve-request";
import {
  APPROVAL_LOCK_TTL_MS,
  ApprovalLockLostError,
  type ApprovalLock,
  lockConsultationApproval,
  renewApprovalLock,
  unlockApproval,
} from "@/utils/appointmentlock";
import { transitionConsultationRequest } from "@/lib/booking/transitions";
import {
  refuseMalformedEventId,
  refusePlanNotOwned,
} from "@/lib/booking/request-route-guards";
import { PARTY_USER_SELECT } from "@/lib/booking/list-selects";
import { APPROVAL_STATUSES_DETAIL_ONLY } from "@/lib/booking/list-query";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { refundRejectedRequest } from "@/lib/booking/rejection-refund";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { MAX_TEXT_LENGTH } from "@/lib/validation/limits";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { createDirectMessageChannel } from "@/actions/stream/chat/channel.action";
import { streamLogger } from "@/lib/stream-logger";
import { bookingOrgId } from "@/lib/stream-utils";
import { reportSentryError } from "@/lib/observability/report";

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
    const malformedId = refuseMalformedEventId(consultationId);
    if (malformedId) return malformedId;
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
            occurrences: true,
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
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
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
    const malformedId = refuseMalformedEventId(consultationId);
    if (malformedId) return malformedId;

    // Fetch the consultation to check ownership
    const existingConsultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: true,
          },
        },
        // bookingOrgId's fallback when the plan carries no org.
        appointment: { select: { organizationId: true } },
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

    // #1704 — a planId is only accepted from the same consultant as the
    // request; connecting any plan let a request migrate to another seller.
    const planRefusal = await refusePlanNotOwned(
      validatedBody.planId,
      {
        consultantProfileId:
          existingConsultation.consultationPlan?.consultantProfileId,
        organizationId: bookingOrgId(existingConsultation),
      },
      () =>
        prisma.consultationPlan.findUnique({
          where: { id: validatedBody.planId },
          select: { consultantProfileId: true, organizationId: true },
        }),
    );
    if (planRefusal) return planRefusal;

    const consultationData = await prisma.consultation.update({
      where: { id: consultationId },
      data: {
        requestNotes: validatedBody.requestNotes,
        bookingSource: validatedBody.bookingSource,
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
            occurrences: true,
          },
        },
      },
    });

    return NextResponse.json({ data: consultationData }, { status: 200 });
  } catch (error) {
    console.error("Error updating consultation:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
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

    // Doctrine rule 2 — nothing is deleted. This route used to run a raw
    // `prisma.consultation.delete`, whose cascades reach the Appointment and
    // from there every Payment pointing at it (Payment.appointment onDelete:
    // Cascade) — hard-destroying financial rows. Bookings are soft-cancelled
    // through the cancel API, which also routes any refund through the front
    // door (lib/payments/operations/booking-refund.ts).
    void params;
    return NextResponse.json(
      {
        error:
          "Deleting bookings is not supported. Cancel via " +
          "POST /api/appointments/{appointmentId}/cancel, which soft-cancels " +
          "and refunds through the booking front door.",
        code: "DELETE_NOT_SUPPORTED",
      },
      { status: 405 },
    );
  } catch (error) {
    console.error("Error deleting consultation:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
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

    // #831 — the list PATCH had a limiter; the heavier detail PATCH did not.
    const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (rl) return rl;

    const body = await request.json();
    const { consultationId } = await params;
    const malformedId = refuseMalformedEventId(consultationId);
    if (malformedId) return malformedId;

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
                user: PARTY_USER_SELECT,
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: PARTY_USER_SELECT,
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

    // #1775 — a dual-profile user was both sides of the request, so the
    // participant check passed and they could approve their own booking.
    if (
      APPROVAL_STATUSES_DETAIL_ONLY.has(status) &&
      existingConsultation.consultationPlan.consultantProfile.user.id ===
        existingConsultation.requestedBy.user.id &&
      !isPrivileged(session.user.role)
    ) {
      return NextResponse.json(
        { error: "You cannot approve your own request", code: "SELF_APPROVAL" },
        { status: 403 },
      );
    }

    // #1004 — declining is the CONSULTANT's act. The transition guard enforces
    // only the from-state, and REJECTED is legal from PENDING and
    // APPROVED_PENDING_PAYMENT, so without this the consultee could reject
    // their own paid request and collect the consultant-initiated 100% refund
    // — every notice tier bypassed, on demand.
    if (
      status === AppointmentStatus.REJECTED &&
      !isConsultant &&
      !isPrivileged(session.user.role)
    ) {
      return forbiddenResponse(
        "Only the consultant can decline a request. Cancel it instead.",
      );
    }

    // LAYER 1: Distributed lock (only for APPROVED status changes)
    let lock: ApprovalLock | null = null;
    if (status === AppointmentStatus.APPROVED) {
      try {
        lock = await lockConsultationApproval(
          consultationId,
          APPROVAL_LOCK_TTL_MS,
        ); // #1319 — must outlive the 30 s tx
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
      const result = await withSerializableRetry(async () => {
        // #1319 — re-grant the approval lock for this attempt; the retry loop
        // outlived the fixed grant.
        await renewApprovalLock(lock);
        return prisma.$transaction(
          async (tx) => {
            // Fetch current state inside transaction
            const currentConsultation = await tx.consultation.findUnique({
              where: { id: consultationId },
              include: {
                consultationPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: PARTY_USER_SELECT,
                      },
                    },
                  },
                },
                requestedBy: {
                  include: {
                    user: PARTY_USER_SELECT,
                  },
                },
                appointment: {
                  include: {
                    occurrences: true,
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
                        user: PARTY_USER_SELECT,
                      },
                    },
                  },
                },
                requestedBy: {
                  include: {
                    user: PARTY_USER_SELECT,
                  },
                },
                appointment: {
                  include: {
                    occurrences: true,
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
                  // Confirm existing tentative appointment. RESCHEDULED rows are
                  // excluded (#1169 PR 2): they keep their ORIGINAL startsAt, so
                  // flipping them re-confirms exactly the time the consultee
                  // asked to move away from.
                  await tx.appointmentOccurrence.updateMany({
                    where: {
                      appointmentId: consultation.appointment.id,
                      completionStatus: "SCHEDULED",
                    },
                    data: { isTentative: false },
                  });
                } else {
                  // Paid but no appointment row: the capture webhook that
                  // creates the appointment has not landed (or died mid-flight).
                  // The old fallback fabricated a confirmed slot at now+1h on
                  // the GLOBAL client — no availability check, no lock, no
                  // consultantProfileId, and it survived this transaction's
                  // rollback (#1169 PR 2 / CORE-3). Refuse instead: the
                  // reconcile-orphaned-confirmations sweep (#830) settles this
                  // exact state, after which approval succeeds normally.
                  throw new PaidWithoutAppointmentError(consultation.id);
                }
                return { data: consultation, duplicate: false };
              } else {
                // No payment — record the approval now; the pay-link is minted
                // AFTER commit (#1169 PR 2). A gateway round-trip inside a
                // Serializable transaction pinned a pooled connection for
                // seconds, could blow the 30s budget, and on rollback left a
                // live payment link for an approval that never persisted. The
                // trial path documents the same rule.
                await transitionConsultationRequest(tx, {
                  where: { id: consultationId },
                  to: AppointmentStatus.APPROVED_PENDING_PAYMENT,
                });
                const updatedConsultation =
                  await tx.consultation.findUniqueOrThrow({
                    where: { id: consultationId },
                    include: {
                      consultationPlan: {
                        include: {
                          consultantProfile: {
                            include: {
                              user: PARTY_USER_SELECT,
                            },
                          },
                        },
                      },
                      requestedBy: {
                        include: {
                          user: PARTY_USER_SELECT,
                        },
                      },
                      appointment: {
                        include: {
                          occurrences: true,
                        },
                      },
                    },
                  });

                return {
                  data: updatedConsultation,
                  message: "Consultation approved. Payment link sent to user.",
                  requiresPayment: true,
                  needsPaymentLink: true,
                  duplicate: false,
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
      });

      // If duplicate, return early — EXCEPT an APPROVED_PENDING_PAYMENT whose
      // pay-link mint previously failed (#1169 PR 2): fall through so a
      // re-approval restores the link instead of parroting
      // "already in progress" forever.
      const needsLinkRetry =
        result.duplicate &&
        result.data.status === AppointmentStatus.APPROVED_PENDING_PAYMENT &&
        !result.data.pendingPaymentUrl;
      if (result.duplicate && !needsLinkRetry) {
        return NextResponse.json({
          data: result.data,
          message: result.message,
        });
      }

      // #1004 — a rejected request that was already paid for has to give the
      // money back. Direct checkout captures BEFORE the request exists, so the
      // consultant is declining a booking the buyer has already paid; REJECTED
      // is terminal and the cancel route refuses it, so this is the only exit.
      // Runs after the transition commits — the allowed-from guard on that
      // transition is what makes it at-most-once.
      const rejectionRefund =
        status === AppointmentStatus.REJECTED
          ? await refundRejectedRequest({
              kind: "consultation",
              requestId: consultationId,
              initiatedByUserId: session.user.id,
              actor: isConsultant ? "CONSULTANT" : "PLATFORM",
            })
          : null;

      // #1169 PR 2 — mint the pay-link AFTER the transaction commits (a
      // gateway round-trip inside the Serializable tx pinned a connection and
      // left a live link on rollback). #1775 B-9 — the block is the shared
      // post-commit mint every approval writer calls: it reuses a live
      // PENDING intent on a retry (#1181), CASes the link onto the row,
      // tombstones an orphaned order and mails only a live link.
      let mintedLink: {
        paymentUrl: string;
        paymentAmount?: number;
        paymentCurrency?: string;
      } | null = null;
      if (
        ("needsPaymentLink" in result && result.needsPaymentLink) ||
        needsLinkRetry
      ) {
        const mint = await mintApprovalPaymentAfterCommit({
          kind: "consultation",
          id: consultationId,
        });
        // A lapsed approval is not a retryable mint failure (#1319 review):
        // the dead intent's request has already been swept.
        if (mint.status === "lapsed") {
          return NextResponse.json(
            {
              data: result.data,
              error: mint.message,
              requiresPayment: true,
              paymentUrl: null,
            },
            { status: 409 },
          );
        }
        // The 502 invites a retry; the retry reuses the same PENDING payment.
        if (mint.status === "mint_failed") {
          return NextResponse.json(
            {
              data: result.data,
              error:
                "The approval was recorded, but generating the payment link failed. Approve again to retry generating the link.",
              requiresPayment: true,
              paymentUrl: null,
            },
            { status: 502 },
          );
        }
        if (mint.status === "minted") {
          mintedLink = {
            paymentUrl: mint.paymentUrl,
            paymentAmount: mint.paymentAmount,
            paymentCurrency: mint.paymentCurrency,
          };
        } else if (mint.status === "already_live") {
          mintedLink = { paymentUrl: mint.paymentUrl };
        }
      }

      // --- Stream channel creation (fire-and-forget, only on approval) ---
      if (!result.duplicate && status === AppointmentStatus.APPROVED) {
        try {
          const consultationData = result.data;
          const consultantUserId =
            consultationData.consultationPlan?.consultantProfile?.userId;
          const consulteeUserId = consultationData.requestedBy?.userId;

          if (consultantUserId && consulteeUserId) {
            // #1134 P0-7 — no more `consultation-<id>` channel: the reconcile
            // pass never expected it yet treated its prefix as managed, so it
            // was deleted on the buyer's next dashboard load. #1134 P0-8 — the
            // org must be threaded so the DM lands on the key the reconciler
            // expects — via the one shared resolver, so it cannot drift.
            const dmOrgId = bookingOrgId(consultationData);
            await createDirectMessageChannel(
              consultantUserId,
              consulteeUserId,
              dmOrgId,
            );
            streamLogger.info(
              "Stream DM channel ensured on consultation approval",
              { consultationId, organizationId: dmOrgId },
            );
          }
        } catch (channelError) {
          // The subscription twin reports this and the payment-success handler
          // pages on it: a failure here leaves the buyer with no chat at all,
          // and a log line alone means nobody finds out.
          reportSentryError(channelError, {
            subsystem: "stream",
            op: "consultationApproval.createChannels",
            extra: { consultationId },
          });
          streamLogger.error(
            "Auto-channel creation failed on consultation approval",
            channelError,
            { consultationId },
          );
        }
      }

      // Return success response
      return NextResponse.json({
        ...result,
        ...mintedLink,
        refund: rejectionRefund,
      });
    } catch (error) {
      console.error(
        "Transaction error:",
        error instanceof Error ? error.message : "Unknown error",
      );
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "bookings" } },
      );
      throw error;
    } finally {
      // LAYER 1: Always release lock
      if (lock) {
        await unlockApproval(lock);
      }
    }
  } catch (error) {
    if (error instanceof ApprovalLockLostError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (error instanceof PaidWithoutAppointmentError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error(
      "Error updating consultation:",
      error instanceof Error ? error.message : "Unknown error",
    );
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "An error occurred while updating consultation" },
      { status: 500 },
    );
  }
}

// #1169 PR 2 — thrown inside the approval transaction so the APPROVED
// transition rolls back; mapped to a 409 that names the reconciliation path.
class PaidWithoutAppointmentError extends Error {
  constructor(readonly consultationId: string) {
    super(
      "This consultation is paid but its appointment has not been created yet (the payment confirmation is still being processed). The reconciliation sweep completes it within minutes — approve again after that.",
    );
    this.name = "PaidWithoutAppointmentError";
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

// (removed) createAppointmentForConsultation — #1169 PR 2 / CORE-3.
// It fabricated a confirmed slot at now+1h with no availability check, no
// lock, no consultantProfileId, using the GLOBAL client from inside the
// Serializable approval transaction (the row survived rollback). The paid-
// without-appointment state it papered over is settled by
// scripts/payments/reconcile-orphaned-confirmations.ts (#830); the approval
// route now refuses with PaidWithoutAppointmentError instead.
