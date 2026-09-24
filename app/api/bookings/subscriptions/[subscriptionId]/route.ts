import { stageNoticesForAppointmentHolds } from "@/lib/booking/backup-interest";
import * as Sentry from "@sentry/nextjs";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import prisma from "@/lib/prisma";
import { Prisma, AppointmentStatus } from "@prisma/client";
import { addMonths } from "date-fns";
import { NextRequest, NextResponse } from "next/server";
import {
  mintApprovalPaymentAfterCommit,
  SETTLED_SUBSCRIPTION,
} from "@/lib/booking/approve-request";
import {
  APPROVAL_LOCK_TTL_MS,
  ApprovalLockLostError,
  type ApprovalLock,
  lockSubscriptionApproval,
  renewApprovalLock,
  unlockApproval,
} from "@/utils/appointmentlock";
import { transitionSubscriptionRequest } from "@/lib/booking/transitions";
import {
  refuseMalformedEventId,
  refusePlanNotOwned,
} from "@/lib/booking/request-route-guards";
import { PARTY_USER_SELECT } from "@/lib/booking/list-selects";
import { APPROVAL_STATUSES_DETAIL_ONLY } from "@/lib/booking/list-query";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { refundRejectedRequest } from "@/lib/booking/rejection-refund";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import {
  notifySubscriptionStarted,
  notifySubscriptionCancelled,
} from "@/lib/novu";
import { logSubscriptionCancelled } from "@/lib/activity/log-activity";
import {
  UpdateSubscriptionSchema,
  PatchSubscriptionStatusSchema,
} from "@/schemas/subscriptions";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { createDirectMessageChannel } from "@/actions/stream/chat/channel.action";
import { streamLogger } from "@/lib/stream-logger";
import { bookingOrgId } from "@/lib/stream-utils";

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
    const malformedId = refuseMalformedEventId(subscriptionId);
    if (malformedId) return malformedId;
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
        appointment: {
          include: {
            occurrences: true,
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
      !!subscriptionData.requestedById &&
      subscriptionData.requestedById === session.user.consulteeProfileId;
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
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
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
    const malformedId = refuseMalformedEventId(subscriptionId);
    if (malformedId) return malformedId;
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
        // bookingOrgId's fallback when the plan carries no org.
        appointment: { select: { organizationId: true } },
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
      !!existingSubscription.requestedById &&
      existingSubscription.requestedById === session.user.consulteeProfileId;
    if (!isPrivileged(session.user.role) && !isConsultant && !isConsultee) {
      return forbiddenResponse(
        "You can only modify subscriptions you are a participant in",
      );
    }

    // #1704 — a planId is only accepted from the same consultant as the
    // request; connecting any plan let a request migrate to another seller.
    const planRefusal = await refusePlanNotOwned(
      validatedData.planId,
      {
        consultantProfileId:
          existingSubscription.subscriptionPlan?.consultantProfileId,
        organizationId: bookingOrgId(existingSubscription),
      },
      () =>
        prisma.subscriptionPlan.findUnique({
          where: { id: validatedData.planId },
          select: { consultantProfileId: true, organizationId: true },
        }),
    );
    if (planRefusal) return planRefusal;

    const subscriptionData = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        schedulingPeriodStartsAt: validatedData.schedulingPeriodStartsAt,
        schedulingPeriodEndsAt: validatedData.schedulingPeriodEndsAt,
        requestNotes: validatedData.requestNotes,
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
        appointment: {
          include: {
            occurrences: true,
          },
        },
      },
    });

    return NextResponse.json({ data: subscriptionData }, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
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

  // Doctrine rule 2 — nothing is deleted. This ADMIN-only route used to run a
  // raw `prisma.subscription.delete`, whose cascades reach every Appointment
  // of the plan and from there the Payments pointing at those appointments
  // (Payment.appointment onDelete: Cascade) — or FK-fail on
  // Refund.payment onDelete: Restrict, surfacing as a 500. Bookings are
  // soft-cancelled through the cancel API, which routes refunds through the
  // booking front door.
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
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  // Require authentication
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  // #831 — the list PATCH had a limiter; the heavier detail PATCH did not.
  const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (rl) return rl;

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
    const malformedId = refuseMalformedEventId(subscriptionId);
    if (malformedId) return malformedId;

    // First fetch the subscription to validate it exists and get all necessary data
    const existingSubscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        subscriptionPlan: {
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
      !!existingSubscription.requestedById &&
      existingSubscription.requestedById === session.user.consulteeProfileId;
    if (!isPrivileged(session.user.role) && !isConsultant && !isConsultee) {
      return forbiddenResponse(
        "You can only modify subscriptions you are a participant in",
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

    // #1775 — a dual-profile user was both sides of the request, so the
    // participant check passed and they could approve their own booking.
    if (
      APPROVAL_STATUSES_DETAIL_ONLY.has(status) &&
      existingSubscription.subscriptionPlan.consultantProfile.user.id ===
        existingSubscription.requestedBy.user.id &&
      !isPrivileged(session.user.role)
    ) {
      return NextResponse.json(
        { error: "You cannot approve your own request", code: "SELF_APPROVAL" },
        { status: 403 },
      );
    }

    const startDate = new Date();
    const endDate = addMonths(
      startDate,
      existingSubscription.subscriptionPlan.durationInMonths,
    );

    // LAYER 1: Distributed lock (only for APPROVED status changes)
    let lock: ApprovalLock | null = null;
    if (status === AppointmentStatus.APPROVED) {
      try {
        lock = await lockSubscriptionApproval(
          subscriptionId,
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
            const currentSubscription = await tx.subscription.findUnique({
              where: { id: subscriptionId },
              include: {
                subscriptionPlan: {
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

            if (!currentSubscription) {
              throw new Error("Subscription not found");
            }

            // IDEMPOTENCY: Check if already in target state or processing
            if (status === AppointmentStatus.APPROVED) {
              if (
                currentSubscription.status ===
                AppointmentStatus.APPROVED_PENDING_PAYMENT
              ) {
                // Already processing, return existing state
                return {
                  data: currentSubscription,
                  message: "Approval already in progress",
                  duplicate: true,
                };
              }

              if (currentSubscription.status === AppointmentStatus.APPROVED) {
                return {
                  data: currentSubscription,
                  message: "Already approved",
                  duplicate: true,
                };
              }
            }

            // #836 — allowed-from guard rides the WHERE; the idempotency
            // pre-checks above are only friendly error text. updateMany
            // returns no row, so re-read for the heavy include.
            await transitionSubscriptionRequest(tx, {
              where: { id: subscriptionId },
              to: status,
            });
            // #1778 — a decline frees the held times: tell anyone waiting.
            if (status === AppointmentStatus.REJECTED) {
              const held = await tx.appointment.findFirst({
                where: { subscriptionId: subscriptionId, deletedAt: null },
                select: { id: true },
              });
              if (held) await stageNoticesForAppointmentHolds(tx, held.id);
            }
            const subscription = await tx.subscription.findUniqueOrThrow({
              where: { id: subscriptionId },
              include: {
                subscriptionPlan: {
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

            // #1775 C-1 — a plan is paid at purchase: approval needs a settled
            // payment, and the throw rolls the APPROVED write above back.
            if (status === AppointmentStatus.APPROVED) {
              const settled = await tx.subscription.count({
                where: { id: subscriptionId, ...SETTLED_SUBSCRIPTION },
              });
              if (settled === 0) {
                throw new BookingRuleError(
                  "SUBSCRIPTION_UNPAID",
                  "This plan is paid at purchase — the request has no successful payment.",
                );
              }
              await tx.subscription.update({
                where: { id: subscriptionId },
                data: {
                  schedulingPeriodStartsAt: startDate,
                  schedulingPeriodEndsAt: endDate,
                },
              });

              // Confirm existing tentative sessions. RESCHEDULED rows keep their
              // ORIGINAL startsAt; flipping them re-confirms the time the
              // consultee asked to leave (#1169 PR 2).
              if (subscription.appointment) {
                await tx.appointmentOccurrence.updateMany({
                  where: {
                    appointmentId: subscription.appointment.id,
                    completionStatus: "SCHEDULED",
                  },
                  data: { isTentative: false },
                });
              }
              return { data: subscription, duplicate: false };
            }

            return { data: subscription, duplicate: false };
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
      // re-approval restores the link.
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
      // Legacy in-flight APPROVED_PENDING_PAYMENT rows only (#1775 C-1).
      if (needsLinkRetry) {
        const mint = await mintApprovalPaymentAfterCommit({
          kind: "subscription",
          id: subscriptionId,
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

      // #1004 — a rejected request that was already paid for has to give the
      // money back. Direct checkout captures BEFORE the request exists, so the
      // consultant is declining a booking the buyer has already paid; REJECTED
      // is terminal and the cancel route refuses it, so this is the only exit.
      // Runs after the transition commits — the allowed-from guard on that
      // transition is what makes it at-most-once.
      let rejectionRefund: Awaited<ReturnType<typeof refundRejectedRequest>> =
        null;
      if (!result.duplicate && status === AppointmentStatus.REJECTED) {
        rejectionRefund = await refundRejectedRequest({
          kind: "subscription",
          requestId: subscriptionId,
          initiatedByUserId: session.user.id,
          actor: isConsultant ? "CONSULTANT" : "PLATFORM",
        });
      }

      // Fire-and-forget: send Novu notifications for non-duplicate status changes
      if (!result.duplicate && "data" in result && result.data) {
        const subData = result.data;
        const consulteeUserId = subData.requestedBy?.user?.id;
        const consultantUserId =
          subData.subscriptionPlan?.consultantProfile?.user?.id;

        if (status === AppointmentStatus.APPROVED && consulteeUserId) {
          await notifySubscriptionStarted(consulteeUserId, {
            subscriptionId: subData.id,
            planTitle: subData.subscriptionPlan?.title || "Subscription",
            consultantName:
              subData.subscriptionPlan?.consultantProfile?.user?.name ||
              "Consultant",
            consulteeName: subData.requestedBy?.user?.name || undefined,
            dashboardUrl: "/dashboard",
          });
        }

        if (status === AppointmentStatus.CANCELLED) {
          const userIds = [consultantUserId, consulteeUserId].filter(
            (id): id is string => !!id,
          );
          if (userIds.length > 0) {
            await notifySubscriptionCancelled(userIds, {
              subscriptionId: subData.id,
              planTitle: subData.subscriptionPlan?.title || "Subscription",
              consultantName:
                subData.subscriptionPlan?.consultantProfile?.user?.name ||
                "Consultant",
              consulteeName: subData.requestedBy?.user?.name || undefined,
              dashboardUrl: "/dashboard",
            });
          }

          // Log cancellation activity (awaited — DB write should not be dropped in serverless)
          const cpId = subData.subscriptionPlan?.consultantProfileId;
          if (cpId) {
            await logSubscriptionCancelled(
              cpId,
              subData.id,
              {
                id: session.user.id,
                name: session.user.name || "User",
                image: session.user.image,
              },
              subData.subscriptionPlan?.title || "Subscription",
              session.user.id === consultantUserId ? "consultant" : "consultee",
            );
          }
        }
      }

      // --- Stream channel creation (fire-and-forget, after transaction) ---
      if (
        !result.duplicate &&
        status === AppointmentStatus.APPROVED &&
        "data" in result &&
        result.data
      ) {
        try {
          const subData = result.data;
          const consultantUid =
            subData.subscriptionPlan?.consultantProfile?.user?.id;
          const consulteeUid = subData.requestedBy?.user?.id;

          if (consultantUid && consulteeUid) {
            // #1134 P0-7 / P0-8 — see the consultation twin. No
            // `subscription-<id>` channel (the reconciler deleted it on the next
            // load), and the org is threaded so the DM key matches what
            // getDmPairsForUser expects.
            // #1554 — a subscription is one appointment, so the org tag is a
            // single column and `bookingOrgId` reads the same row the creator did.
            const dmOrgId = bookingOrgId(subData);
            await createDirectMessageChannel(
              consultantUid,
              consulteeUid,
              dmOrgId,
            );
            streamLogger.info(
              "Stream DM channel ensured on subscription approval",
              { subscriptionId: subData.id, organizationId: dmOrgId },
            );
          }
        } catch (channelError) {
          Sentry.captureException(
            channelError instanceof Error
              ? channelError
              : new Error(String(channelError)),
            { tags: { subsystem: "bookings" } },
          );
          streamLogger.error(
            "Auto-channel creation failed on subscription approval",
            channelError,
            { subscriptionId },
          );
        }
      }

      // Return success response (exclude emailData from response)
      return NextResponse.json({
        ...result,
        ...mintedLink,
        refund: rejectionRefund,
      });
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "bookings" } },
      );
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
    if (error instanceof BookingRuleError) return bookingRuleResponse(error);
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
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
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
