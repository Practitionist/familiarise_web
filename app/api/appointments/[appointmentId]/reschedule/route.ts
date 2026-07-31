import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import type { RescheduleInitiatorRole } from "@prisma/client";
import { RescheduleProposalSchema } from "@/schemas/appointments";
import {
  computeProposalExpiry,
  proposalCountMatches,
  supportsProposals,
} from "@/lib/booking/reschedule-proposals";
import {
  ReschedulePolicyError,
  RescheduleAuthorizationError,
  AppointmentTypeMismatchError,
  AppointmentNotFoundError,
} from "@/utils/errors/RescheduleErrors";
import { notifyAppointmentRescheduled } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { logActivity } from "@/lib/activity/log-activity";
import { tryAutoConfirmProposal } from "@/lib/booking/reschedule-auto-confirm";
import { hasActiveDisputeForAppointment } from "@/lib/payments/dispute-guard";
import {
  CLASS_EVENT_ALLOWED_FROM,
  EVENT_ALLOWED_FROM,
  RESCHEDULABLE_FROM,
  SLOT_RESCHEDULABLE_FROM,
} from "@/lib/booking/transitions";

const MINIMUM_HOURS_BEFORE_RESCHEDULE = 24;

/**
 * Which side is asking. Null for a privileged ADMIN/STAFF bypass, which is
 * neither party and therefore never auto-confirms on someone else's behalf.
 */
function roleOf(
  isConsultee: boolean,
  isConsultant: boolean,
): RescheduleInitiatorRole | null {
  if (isConsultee) return "CONSULTEE";
  if (isConsultant) return "CONSULTANT";
  return null;
}

/**
 * POST /api/appointments/[appointmentId]/reschedule
 *
 * Reschedule an appointment or specific session(s) within a subscription.
 *
 * Query Parameters:
 * - type: AppointmentType (CONSULTATION, SUBSCRIPTION, WEBINAR, CLASS)
 *
 * Body (optional):
 * - slotIds: string[] - For SUBSCRIPTION type only. If provided, only these specific
 *                       slots will be marked as tentative. If not provided,
 *                       all slots in the subscription will be marked as tentative.
 *
 * Behavior:
 * - For CONSULTATION: Marks all slots as tentative, reverts status to PENDING
 * - For SUBSCRIPTION with slotIds: Marks only specified slots as tentative (individual/multiple session reschedule)
 * - For SUBSCRIPTION without slotIds: Marks ALL slots as tentative (entire subscription reschedule)
 * - For WEBINAR/CLASS: Marks all slots as tentative
 *
 * 24-Hour Restriction:
 * - Cannot reschedule if ANY slot to be rescheduled is within 24 hours
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId } = await params;
    const { searchParams } = new URL(request.url);
    const appointmentType = searchParams.get("type");

    // #1008 — an appointment with a live payment dispute is frozen: its state is
    // evidence and must not move while the dispute is contested.
    if (await hasActiveDisputeForAppointment(appointmentId)) {
      return NextResponse.json(
        {
          error:
            "This appointment has an open payment dispute and can't be rescheduled until it resolves.",
          code: "DISPUTE_ACTIVE",
        },
        { status: 409 },
      );
    }

    // Parse request body for optional slotIds (used for individual/multiple session reschedule)
    let slotIds: string[] | undefined;
    // Concrete replacement times. Optional: "release these, any time works" is
    // still a valid request and remains the whole contract for group events.
    let proposedSlots: { startsAt: Date; endsAt: Date }[] | undefined;
    let reason: string | undefined;
    try {
      const body = await request.json();
      // Support both single slotId (legacy) and slotIds array
      if (body?.slotIds && Array.isArray(body.slotIds)) {
        slotIds = body.slotIds;
      } else if (body?.slotId) {
        // Legacy support: convert single slotId to array
        slotIds = [body.slotId];
      }
      const parsedProposal = RescheduleProposalSchema.safeParse(body);
      if (!parsedProposal.success) {
        return NextResponse.json(
          {
            error: "Invalid proposed times",
            code: "INVALID_PROPOSAL",
            details: parsedProposal.error.flatten(),
          },
          { status: 400 },
        );
      }
      if (parsedProposal.data.proposedSlots?.length) {
        proposedSlots = parsedProposal.data.proposedSlots.map((s) => ({
          startsAt: new Date(s.startsAt),
          endsAt: new Date(s.endsAt),
        }));
      }
      reason = parsedProposal.data.reason;
    } catch {
      // No body or invalid JSON - that's fine, every field here is optional
    }

    // Start transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // Get appointment details with all related data
        const appointment = await tx.appointment.findUnique({
          where: { id: appointmentId },
          include: {
            slotsOfAppointment: {
              orderBy: { startsAt: "asc" },
            },
            consultation: {
              include: {
                consultationPlan: {
                  include: {
                    consultantProfile: true,
                  },
                },
                requestedBy: true,
              },
            },
            subscription: {
              include: {
                subscriptionPlan: {
                  include: {
                    consultantProfile: true,
                  },
                },
                requestedBy: true,
              },
            },
            webinar: {
              include: {
                webinarPlan: true,
              },
            },
            class: {
              include: {
                classPlan: true,
              },
            },
          },
        });

        if (!appointment) {
          throw new AppointmentNotFoundError("appointment", appointmentId);
        }

        // Participant authorization check
        const consultantProfileId = session.user.consultantProfileId;
        const consulteeProfileId = session.user.consulteeProfileId;

        let isParticipant = false;
        // Which side is asking. Load-bearing rather than descriptive: only a
        // CONSULTEE proposal may auto-confirm, because publishing availability
        // is standing consent to be booked inside it while merely being free is
        // not consent to be moved. Null for a privileged bypass, which never
        // auto-confirms on someone else's behalf.
        let initiatorRole: RescheduleInitiatorRole | null = null;

        // Check the single event-type relation (mutually exclusive via if-else)
        if (appointment.consultation) {
          const consultationConsultantId =
            appointment.consultation.consultationPlan?.consultantProfileId;
          const isConsultant =
            consultantProfileId === consultationConsultantId;
          const isConsultee =
            consulteeProfileId === appointment.consultation.requestedById;
          isParticipant = isConsultant || isConsultee;
          initiatorRole = roleOf(isConsultee, isConsultant);
        } else if (appointment.subscription) {
          const subscriptionConsultantId =
            appointment.subscription.subscriptionPlan?.consultantProfileId;
          const isConsultant =
            consultantProfileId === subscriptionConsultantId;
          const isConsultee =
            consulteeProfileId === appointment.subscription.requestedById;
          isParticipant = isConsultant || isConsultee;
          initiatorRole = roleOf(isConsultee, isConsultant);
        } else if (appointment.webinar) {
          // Only the consultant (organizer) can reschedule group events,
          // since rescheduling changes the time for all participants.
          const webinarConsultantId =
            appointment.webinar.webinarPlan?.consultantProfileId;
          isParticipant = consultantProfileId === webinarConsultantId;
        } else if (appointment.class) {
          // Same as webinar: consultant-only reschedule
          const classConsultantId =
            appointment.class.classPlan?.consultantProfileId;
          isParticipant = consultantProfileId === classConsultantId;
        }

        // Allow ADMIN/STAFF bypass
        const isPrivilegedUser = isPrivileged(session.user.role);

        if (!isParticipant && !isPrivilegedUser) {
          throw new RescheduleAuthorizationError();
        }

        // Derive type from DB instead of trusting query param
        const derivedType = appointment.consultation
          ? "CONSULTATION"
          : appointment.subscription
            ? "SUBSCRIPTION"
            : appointment.webinar
              ? "WEBINAR"
              : appointment.class
                ? "CLASS"
                : null;

        if (appointmentType && derivedType && appointmentType !== derivedType) {
          throw new AppointmentTypeMismatchError(appointmentType, derivedType);
        }

        // For SUBSCRIPTION and CLASS types, we need to get ALL slots across ALL appointments
        // because the UI collects slots from all appointments but only passes one appointmentId
        let allSubscriptionSlots: typeof appointment.slotsOfAppointment = [];

        if (derivedType === "SUBSCRIPTION" && appointment.subscription) {
          // Fetch all appointments for this subscription with their slots
          const allAppointments = await tx.appointment.findMany({
            where: { subscriptionId: appointment.subscription.id },
            include: { slotsOfAppointment: { orderBy: { startsAt: "asc" } } },
          });
          allSubscriptionSlots = allAppointments.flatMap(
            (apt) => apt.slotsOfAppointment,
          );
        } else if (derivedType === "CLASS" && appointment.class) {
          // Fetch all appointments for this class with their slots
          const allAppointments = await tx.appointment.findMany({
            where: { classId: appointment.class.id },
            include: { slotsOfAppointment: { orderBy: { startsAt: "asc" } } },
          });
          allSubscriptionSlots = allAppointments.flatMap(
            (apt) => apt.slotsOfAppointment,
          );
        }

        // Determine which slots will be affected
        // For multi-appointment types (SUBSCRIPTION, CLASS) without slotIds, check all slots
        let slotsToReschedule =
          (derivedType === "SUBSCRIPTION" || derivedType === "CLASS") &&
          (!slotIds || slotIds.length === 0) &&
          allSubscriptionSlots.length > 0
            ? allSubscriptionSlots
            : appointment.slotsOfAppointment;

        // For SUBSCRIPTION/CLASS with slotIds, only reschedule the specific
        // slots. CLASS previously fell through to the whole-class branch, so
        // a per-session class reschedule silently escalated to every session.
        if (
          slotIds &&
          slotIds.length > 0 &&
          ((derivedType === "SUBSCRIPTION" && appointment.subscription) ||
            (derivedType === "CLASS" && appointment.class))
        ) {
          // Filter to only the requested slots from ALL subscription slots
          slotsToReschedule = allSubscriptionSlots.filter((s) =>
            slotIds.includes(s.id),
          );

          // Validate all requested slots exist
          if (slotsToReschedule.length !== slotIds.length) {
            const foundIds = slotsToReschedule.map((s) => s.id);
            const missingIds = slotIds.filter((id) => !foundIds.includes(id));
            throw new AppointmentNotFoundError("slot", missingIds.join(", "));
          }
        }

        // 24-hour restriction check - validate ALL selected slots
        const now = new Date();
        for (const slot of slotsToReschedule) {
          const hoursUntilSlot =
            (new Date(slot.startsAt).getTime() - now.getTime()) /
            (1000 * 60 * 60);

          if (hoursUntilSlot < MINIMUM_HOURS_BEFORE_RESCHEDULE) {
            throw new ReschedulePolicyError(
              hoursUntilSlot,
              MINIMUM_HOURS_BEFORE_RESCHEDULE,
            );
          }
        }

        // Mark the appropriate slots as tentative
        if (
          slotIds &&
          slotIds.length > 0 &&
          ((derivedType === "SUBSCRIPTION" && appointment.subscription) ||
            (derivedType === "CLASS" && appointment.class))
        ) {
          // Individual/multiple session reschedule - mark ALL slots of the affected appointments
          // (e.g. a 1.5h session has 3 consecutive slots; all must be marked tentative together)
          const affectedAppointmentIds = Array.from(
            new Set(slotsToReschedule.map((s) => s.appointmentId)),
          );
          // From-state guard on every slot flip: a reschedule must never
          // resurrect COMPLETED/CANCELLED history to RESCHEDULED (#837).
          await tx.slotOfAppointment.updateMany({
            where: {
              appointmentId: { in: affectedAppointmentIds },
              completionStatus: { in: SLOT_RESCHEDULABLE_FROM },
            },
            data: { isTentative: true, completionStatus: "RESCHEDULED" },
          });
        } else if (derivedType === "SUBSCRIPTION" && appointment.subscription) {
          // Entire subscription reschedule - mark ALL slots in ALL appointments
          const allAppointmentIds = (
            await tx.appointment.findMany({
              where: { subscriptionId: appointment.subscription.id },
              select: { id: true },
            })
          ).map((a) => a.id);

          await tx.slotOfAppointment.updateMany({
            where: {
              appointmentId: { in: allAppointmentIds },
              completionStatus: { in: SLOT_RESCHEDULABLE_FROM },
            },
            data: { isTentative: true, completionStatus: "RESCHEDULED" },
          });
        } else if (derivedType === "CLASS" && appointment.class) {
          // Entire class reschedule - mark ALL slots in ALL appointments
          const allAppointmentIds = (
            await tx.appointment.findMany({
              where: { classId: appointment.class.id },
              select: { id: true },
            })
          ).map((a) => a.id);

          await tx.slotOfAppointment.updateMany({
            where: {
              appointmentId: { in: allAppointmentIds },
              completionStatus: { in: SLOT_RESCHEDULABLE_FROM },
            },
            data: { isTentative: true, completionStatus: "RESCHEDULED" },
          });
        } else {
          // Non-multi-appointment: mark all slots in the single appointment
          await tx.slotOfAppointment.updateMany({
            where: {
              appointmentId,
              completionStatus: { in: SLOT_RESCHEDULABLE_FROM },
            },
            data: { isTentative: true, completionStatus: "RESCHEDULED" },
          });
        }

        // Update status based on appointment type — CAS-guarded (B2): a
        // reschedule racing a cancel/completion must not resurrect the
        // booking; count 0 means the from-state was terminal → 409. The
        // set lives in lib/booking/transitions.ts so the map is canonical.
        let movedStatus = 1; // group events validated below
        if (appointment.consultation) {
          movedStatus = (
            await tx.consultation.updateMany({
              where: {
                id: appointment.consultation.id,
                status: { in: [...RESCHEDULABLE_FROM] },
              },
              data: { status: "PENDING" },
            })
          ).count;
        } else if (appointment.subscription) {
          // #448 — a single/multi-session reschedule must NOT flip the WHOLE
          // subscription to PENDING. Subscription has no per-session status;
          // the affected slots already carry isTentative + RESCHEDULED, so the
          // session-level state is captured there. Only a full-subscription
          // reschedule (no slotIds) genuinely re-enters PENDING. The partial
          // path still terminal-guards (count, no write): rescheduling a
          // session of a cancelled/completed subscription stays a 409.
          const isPartialSubscriptionReschedule = Boolean(
            slotIds && slotIds.length > 0,
          );
          movedStatus = isPartialSubscriptionReschedule
            ? await tx.subscription.count({
                where: {
                  id: appointment.subscription.id,
                  status: { in: [...RESCHEDULABLE_FROM] },
                },
              })
            : (
                await tx.subscription.updateMany({
                  where: {
                    id: appointment.subscription.id,
                    status: { in: [...RESCHEDULABLE_FROM] },
                  },
                  data: { status: "PENDING" },
                })
              ).count;
        } else if (appointment.webinar) {
          // Explicit allowed-from (was notIn) — robust against future enum
          // additions (#837).
          movedStatus = (
            await tx.webinar.updateMany({
              where: {
                id: appointment.webinar.id,
                status: { in: EVENT_ALLOWED_FROM.SCHEDULED },
              },
              data: { status: "SCHEDULED" },
            })
          ).count;
        } else if (appointment.class) {
          movedStatus = (
            await tx.class.updateMany({
              where: {
                id: appointment.class.id,
                status: { in: CLASS_EVENT_ALLOWED_FROM.SCHEDULED },
              },
              data: { status: "SCHEDULED" },
            })
          ).count;
        }
        if (movedStatus === 0) {
          throw Object.assign(
            new Error(
              "This appointment can no longer be rescheduled (already cancelled or completed).",
            ),
            { httpStatus: 409, code: "NOT_RESCHEDULABLE" },
          );
        }

        // Attach the proposed replacement times, if any were given. Without
        // this a reschedule reaches the consultant carrying LESS information
        // than the original booking did — which slots to drop, and nothing
        // about when the consultee actually wants them.
        let rescheduleRequestId: string | null = null;
        if (
          proposedSlots?.length &&
          initiatorRole &&
          supportsProposals(derivedType ?? "")
        ) {
          if (
            !proposalCountMatches(slotsToReschedule.length, proposedSlots.length)
          ) {
            throw Object.assign(
              new Error(
                `Proposed ${proposedSlots.length} time(s) for ${slotsToReschedule.length} released slot(s). ` +
                  `A reschedule replaces slots one for one; changing the count would change what was paid for.`,
              ),
              { httpStatus: 400, code: "PROPOSAL_COUNT_MISMATCH" },
            );
          }

          const expiresAt = computeProposalExpiry(
            slotsToReschedule.map((s) => new Date(s.startsAt)),
          );
          if (!expiresAt) {
            // The 24-hour policy gate above should already have rejected this,
            // so reaching here means the two rules have drifted apart.
            throw Object.assign(
              new Error(
                "This session is too close to propose a new time for.",
              ),
              { httpStatus: 400, code: "PROPOSAL_WINDOW_CLOSED" },
            );
          }

          const created = await tx.rescheduleRequest.create({
            data: {
              appointmentId,
              initiatorRole,
              initiatedById: session.user.id,
              reason,
              releasedSlotIds: slotsToReschedule.map((s) => s.id),
              expiresAt,
              // Reserves the appointment: the nullable @unique makes a second
              // live reschedule a DB-level conflict rather than a race.
              openForAppointmentId: appointmentId,
              organizationId: appointment.organizationId ?? null,
              proposedSlots: {
                create: proposedSlots.map((s) => ({
                  startsAt: s.startsAt,
                  endsAt: s.endsAt,
                  proposedById: session.user.id,
                })),
              },
            },
            select: { id: true },
          });
          rescheduleRequestId = created.id;
        }

        // #448 — count SESSIONS, not raw slots: one Appointment is one session
        // (a 1-hour session is 2 × 30-min slots), so a single 1h-session
        // reschedule must report 1 session, not "2 sessions"/multiple_sessions.
        const sessionsAffected = new Set(
          slotsToReschedule.map((s) => s.appointmentId),
        ).size;

        // Determine reschedule type for response — session-based (#448)
        const getRescheduleType = () => {
          if (
            derivedType !== "SUBSCRIPTION" ||
            !slotIds ||
            slotIds.length === 0
          ) {
            return "entire_booking";
          }
          return sessionsAffected === 1
            ? "individual_session"
            : "multiple_sessions";
        };

        const rescheduleType = getRescheduleType();

        // Return detailed response
        return {
          success: true,
          rescheduleType,
          // #448 — sessionsAffected is the user-facing count (distinct sessions);
          // slotsAffected stays for back-compat / debugging.
          sessionsAffected,
          slotsAffected: slotsToReschedule.length,
          message:
            rescheduleType === "entire_booking"
              ? "All sessions marked for rescheduling. Please select new times."
              : `${sessionsAffected} session(s) marked for rescheduling. Please select new time(s).`,
          // B14 — context for the post-tx activity log (appointment is only
          // in scope inside this callback).
          logContext: {
            cpId:
              appointment.consultation?.consultationPlan?.consultantProfileId ??
              appointment.subscription?.subscriptionPlan?.consultantProfileId ??
              appointment.webinar?.webinarPlan?.consultantProfileId ??
              appointment.class?.classPlan?.consultantProfileId ??
              null,
            appointmentType: appointment.appointmentType,
            consultationId: appointment.consultation?.id,
            subscriptionId: appointment.subscription?.id,
            webinarId: appointment.webinar?.id,
            classId: appointment.class?.id,
          },
          rescheduleRequestId,
        };
      },
      {
        timeout: 60000, // 60 second timeout for complex transactions
      },
    );

    // A consultee's proposal that lands in published availability and finds both
    // calendars free needs no approval, so take it now. Deliberately AFTER the
    // transaction: validating inside it would pin a pooled connection through
    // the whole availability check, which is the shape #908 documents as having
    // 500'd with "Unable to start a transaction in the given time".
    //
    // Failure here is an ordinary outcome, not an error — the proposal simply
    // stays PENDING_REVIEW for the consultant to answer.
    let autoConfirmed = false;
    if (result.rescheduleRequestId) {
      const proposalEventType = result.logContext.consultationId
        ? ("consultation" as const)
        : result.logContext.subscriptionId
          ? ("subscription" as const)
          : null;
      const proposalEventId =
        result.logContext.consultationId ?? result.logContext.subscriptionId;

      if (proposalEventType && proposalEventId) {
        try {
          const outcome = await tryAutoConfirmProposal(
            result.rescheduleRequestId,
            proposalEventType,
            proposalEventId,
          );
          autoConfirmed = outcome.confirmed;
        } catch (err) {
          Sentry.captureException(
            err instanceof Error ? err : new Error(String(err)),
            { tags: { subsystem: "bookings", op: "reschedule-auto-confirm" } },
          );
        }
      }
    }

    // B14 — reschedule now leaves an activity-log entry (cancel always did).
    if (result.logContext.cpId) {
      await logActivity({
        activityType: "APPOINTMENT_RESCHEDULED",
        description: `Appointment reschedule requested (${result.logContext.appointmentType.toLowerCase()})`,
        actorId: session.user.id,
        actorName: session.user.name || "User",
        actorImage: session.user.image,
        consultantProfileId: result.logContext.cpId,
        consultationId: result.logContext.consultationId,
        subscriptionId: result.logContext.subscriptionId,
        webinarId: result.logContext.webinarId,
        classId: result.logContext.classId,
      });
    }

    // Fire-and-forget: notify both parties about reschedule

    // FIX #624: Include webinar/class so group event participants are also notified.
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          consultation: {
            include: {
              consultationPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { userId: true, user: { select: { name: true } } },
                  },
                },
              },
              requestedBy: {
                select: { userId: true, user: { select: { name: true } } },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { userId: true, user: { select: { name: true } } },
                  },
                },
              },
              requestedBy: {
                select: { userId: true, user: { select: { name: true } } },
              },
            },
          },
          webinar: {
            include: {
              webinarPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { userId: true, user: { select: { name: true } } },
                  },
                },
              },
            },
          },
          class: {
            include: {
              classPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { userId: true, user: { select: { name: true } } },
                  },
                },
              },
            },
          },
          slotsOfAppointment: {
            select: {
              user: { select: { id: true, name: true } },
            },
          },
        },
      });

      if (appointment) {
        const consultation = appointment.consultation;
        const subscription = appointment.subscription;
        const webinar = appointment.webinar;
        const classEvent = appointment.class;

        const plan =
          consultation?.consultationPlan ??
          subscription?.subscriptionPlan ??
          webinar?.webinarPlan ??
          classEvent?.classPlan ??
          null;
        const requestedBy =
          consultation?.requestedBy ?? subscription?.requestedBy ?? null;

        // For 1:1 events, notify consultant + consultee
        // For group events (webinar/class), notify consultant + all slot participants
        const userIds: string[] = [];
        if (plan?.consultantProfile?.userId) {
          userIds.push(plan.consultantProfile.userId);
        }
        if (requestedBy?.userId) {
          userIds.push(requestedBy.userId);
        }
        // FIX #624: Add all participants from slots (webinar/class attendees)
        if (appointment.slotsOfAppointment) {
          for (const slot of appointment.slotsOfAppointment) {
            for (const user of slot.user) {
              userIds.push(user.id);
            }
          }
        }

        // Deduplicate; exclude the initiator — you don't need a notification
        // about your own reschedule (B15).
        const uniqueUserIds = Array.from(new Set(userIds)).filter(
          (id) => id !== session.user.id,
        );

        const appointmentType = consultation
          ? "consultation"
          : subscription
            ? "subscription"
            : webinar
              ? "webinar"
              : "class";

        if (uniqueUserIds.length > 0) {
          void notifyAppointmentRescheduled(uniqueUserIds, {
            ...notificationScope(appointment.organizationId),
            appointmentType,
            consultantName: plan?.consultantProfile?.user?.name ?? "Consultant",
            consulteeName: requestedBy?.user?.name ?? "Participant",
            planTitle: plan?.title ?? "Unknown",
            // Group events fan out to every attendee, so one href must serve
            // them all — org route when org-hosted, router bounce otherwise.
            dashboardUrl: notificationHref(
              appointment.organizationId,
              "appointments",
            ),
          }).catch((err) =>
            console.error("[reschedule] Failed to send notification:", err),
          );
        }
      }
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "appointments" } });
      console.error("[reschedule] Failed to send notification:", error);
    }

    // The three outcomes read very differently to a user — you're moved, we've
    // asked, or nothing was proposed — so they must not collapse into one line.
    const resultMessage = () => {
      if (autoConfirmed) return "Your new time is confirmed.";
      if (result.rescheduleRequestId) {
        return "Your requested time has been sent to the consultant.";
      }
      return result.message;
    };

    return NextResponse.json({
      ...result,
      autoConfirmed,
      // The two outcomes read very differently to a user — "you're moved" versus
      // "we've asked" — so the client must be able to tell them apart rather
      // than inferring it from the proposal's presence.
      message: resultMessage(),
    });
  } catch (error) {
    // B2 — the CAS guard's structured 409 (NOT_RESCHEDULABLE).
    if (error instanceof Error && "httpStatus" in error) {
      const status =
        typeof (error as { httpStatus?: number }).httpStatus === "number"
          ? (error as { httpStatus: number }).httpStatus
          : 500;
      const code =
        "code" in error && typeof (error as { code?: string }).code === "string"
          ? (error as { code: string }).code
          : undefined;
      return NextResponse.json(
        { error: error.message, ...(code && { code }) },
        { status },
      );
    }
    // Type-safe error handling using custom error classes
    if (error instanceof RescheduleAuthorizationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    if (error instanceof AppointmentTypeMismatchError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof ReschedulePolicyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof AppointmentNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    // Only log unexpected errors — the known error types above are normal control flow
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "appointments" } });
    console.error("Error requesting reschedule:", error);
    return NextResponse.json(
      { error: "Failed to request reschedule" },
      { status: 500 },
    );
  }
}
