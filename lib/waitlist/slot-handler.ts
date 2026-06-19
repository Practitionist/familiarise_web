/**
 * Waitlist Slot Handler
 * Handles spot availability and notifying users when slots open up
 */

import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { WaitlistStatus } from "@prisma/client";
import {
  getNextBatchInQueue,
  updatePositions,
  calculatePosition,
} from "./queue-manager";
import { sendWaitlistSpotAvailableEmail } from "./notifications";
import { countWebinarParticipants } from "@/lib/payments/utils/participants";

// Notification window in hours (48 hours to respond)
const NOTIFICATION_WINDOW_HOURS = 48;

// Type for slot opening params
export interface SlotOpeningParams {
  webinarId?: string;
  classId?: string;
  slotsAvailable?: number;
  reason?: "cancellation" | "capacity_increase" | "participant_removed";
}

/**
 * Handle a slot opening event
 * Called when:
 * 1. A booking is cancelled
 * 2. Consultant increases capacity
 * 3. A participant is removed
 */
export async function handleSlotOpening(params: SlotOpeningParams): Promise<{
  notified: number;
  errors: Array<{ userId: string; error: string }>;
}> {
  const {
    webinarId,
    classId,
    slotsAvailable = 1,
    reason = "cancellation",
  } = params;

  if (!webinarId && !classId) {
    throw new Error("Either webinarId or classId must be provided");
  }

  const notified: string[] = [];
  const errors: Array<{ userId: string; error: string }> = [];

  // Batched claim (write-path scale hardening): the old shape ran a
  // findFirst + guarded updateMany PER SLOT with an `i--` retry on every
  // race loss — a webinar cancellation freeing N seats against M concurrent
  // openings cost O(N×M) query waves. Each round below is one ordered
  // findMany + one $transaction of per-id CAS claims (a single round trip
  // whose per-id counts say exactly which candidates THIS call won — a
  // bulk updateMany can't report that). Losers shrink the next round's
  // batch; the loop ends when the queue runs dry or all slots are claimed.
  let remaining = slotsAvailable;
  while (remaining > 0) {
    const candidates = await getNextBatchInQueue(
      { webinarId, classId },
      remaining,
    );
    if (candidates.length === 0) break;

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + NOTIFICATION_WINDOW_HOURS * 60 * 60 * 1000,
    );

    // Same per-entry CAS guard as before (status must still be WAITING),
    // batched into one transaction.
    const claims = await prisma.$transaction(
      candidates.map((candidate) =>
        prisma.waitlist.updateMany({
          where: { id: candidate.id, status: WaitlistStatus.WAITING },
          data: {
            status: WaitlistStatus.NOTIFIED,
            notifiedAt: now,
            expiresAt,
          },
        }),
      ),
    );
    const winners = candidates.filter((_, i) => claims[i].count === 1);
    remaining -= winners.length;

    for (const winner of winners) {
      try {
        // Send notification email. A failed delivery is recorded but the
        // claim stands — the 48h expiration cron recycles the spot, same
        // backstop as before.
        if (winner.user.email) {
          const eventTitle =
            winner.webinar?.webinarPlan.title ||
            winner.class?.classPlan.title ||
            "Event";

          const eventType = winner.webinarId ? "webinar" : "class";
          const eventId = winner.webinarId || winner.classId;

          // Get scheduled date if available
          let scheduledDate: Date | undefined;
          if (winner.webinar?.appointment?.slotsOfAppointment?.[0]) {
            scheduledDate =
              winner.webinar.appointment.slotsOfAppointment[0].startsAt;
          } else if (winner.class?.appointments?.[0]?.slotsOfAppointment?.[0]) {
            scheduledDate =
              winner.class.appointments[0].slotsOfAppointment[0].startsAt;
          }

          await sendWaitlistSpotAvailableEmail({
            email: winner.user.email,
            name: winner.user.name || "Valued User",
            eventTitle,
            eventType,
            eventId: eventId!,
            scheduledDate,
            expiresAt,
            waitlistId: winner.id,
          });
        }

        notified.push(winner.userId);

        console.log(
          JSON.stringify({
            event: "waitlist_user_notified",
            waitlistId: winner.id,
            userId: winner.userId,
            webinarId,
            classId,
            reason,
            expiresAt: expiresAt.toISOString(),
            timestamp: new Date().toISOString(),
          }),
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors.push({ userId: winner.userId, error: errorMessage });
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          { tags: { subsystem: "waitlist" } },
        );
        console.error(`Error notifying waitlist user ${winner.userId}:`, error);
      }
    }
  }

  // Update positions for remaining queue members
  await updatePositions({ webinarId, classId });

  return { notified: notified.length, errors };
}

/**
 * Handle user response to a waitlist notification
 */
export async function handleWaitlistResponse(params: {
  waitlistId: string;
  userId: string;
  action: "ACCEPT" | "DECLINE" | "SKIP";
}): Promise<{
  success: boolean;
  redirectUrl?: string;
  message: string;
}> {
  const { waitlistId, userId, action } = params;

  const entry = await prisma.waitlist.findUnique({
    where: { id: waitlistId },
    include: {
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

  if (!entry) {
    return { success: false, message: "Waitlist entry not found" };
  }

  if (entry.userId !== userId) {
    return { success: false, message: "Unauthorized" };
  }

  if (entry.status !== WaitlistStatus.NOTIFIED) {
    return {
      success: false,
      message: `Cannot respond to a waitlist entry with status: ${entry.status}`,
    };
  }

  // Check if notification has expired
  if (entry.expiresAt && new Date() > entry.expiresAt) {
    // #834 — CAS: only NOTIFIED may expire; a racing respond/expire-cron
    // already moved it on if count is 0.
    await prisma.waitlist.updateMany({
      where: { id: waitlistId, status: WaitlistStatus.NOTIFIED },
      data: {
        status: WaitlistStatus.EXPIRED,
        respondedAt: new Date(),
      },
    });
    return {
      success: false,
      message:
        "This spot offer has expired. You have been moved back in the queue.",
    };
  }

  const now = new Date();

  switch (action) {
    case "ACCEPT": {
      // Mark as accepted (actual booking will happen through checkout)
      // We don't mark as BOOKED yet - that happens after successful payment
      // For now, redirect them to checkout with a reserved spot

      const eventType = entry.webinarId ? "webinar" : "class";
      const planId = entry.webinar?.webinarPlan.id || entry.class?.classPlan.id;
      const eventId = entry.webinarId || entry.classId;

      // Build checkout URL with waitlist flag
      const checkoutUrl = `/checkout/plans/${eventType}/${planId}?eventId=${eventId}&fromWaitlist=${waitlistId}`;

      return {
        success: true,
        redirectUrl: checkoutUrl,
        message: "Redirecting to checkout to complete your booking...",
      };
    }

    case "DECLINE": {
      // #834 — CAS: two tabs declining concurrently must fire exactly one
      // handleSlotOpening; the loser would double-notify the next in queue.
      const declined = await prisma.waitlist.updateMany({
        where: { id: waitlistId, status: WaitlistStatus.NOTIFIED },
        data: {
          status: WaitlistStatus.CANCELLED,
          respondedAt: now,
        },
      });
      if (declined.count === 0) {
        return {
          success: false,
          message: "This spot offer was already responded to.",
        };
      }

      // Notify next person in queue
      await handleSlotOpening({
        webinarId: entry.webinarId ?? undefined,
        classId: entry.classId ?? undefined,
        slotsAvailable: 1,
        reason: "cancellation",
      });

      return {
        success: true,
        message: "You have been removed from the waitlist.",
      };
    }

    case "SKIP": {
      // #834 — CAS: a double-submitted SKIP must not insert two back-of-queue
      // rows or double-fire handleSlotOpening.
      const skipped = await prisma.waitlist.updateMany({
        where: { id: waitlistId, status: WaitlistStatus.NOTIFIED },
        data: {
          status: WaitlistStatus.SKIPPED,
          respondedAt: now,
        },
      });
      if (skipped.count === 0) {
        return {
          success: false,
          message: "This spot offer was already responded to.",
        };
      }

      // Create a new waitlist entry at the back of the queue
      await prisma.waitlist.create({
        data: {
          userId: entry.userId,
          webinarId: entry.webinarId,
          classId: entry.classId,
          priority: entry.priority,
          preferences: entry.preferences as object | undefined,
          status: WaitlistStatus.WAITING,
          // joinedAt will be set to now, putting them at the back
        },
      });

      // Notify next person in queue
      await handleSlotOpening({
        webinarId: entry.webinarId ?? undefined,
        classId: entry.classId ?? undefined,
        slotsAvailable: 1,
        reason: "cancellation",
      });

      // Update positions
      await updatePositions({
        webinarId: entry.webinarId ?? undefined,
        classId: entry.classId ?? undefined,
      });

      return {
        success: true,
        message:
          "You have been moved to the back of the queue. We'll notify you when another spot opens up.",
      };
    }

    default:
      return { success: false, message: "Invalid action" };
  }
}

/**
 * Mark a waitlist entry as booked after successful payment
 */
export async function markWaitlistAsBooked(waitlistId: string): Promise<void> {
  // #834 — CAS: webhook replays re-stamp, and a CANCELLED/EXPIRED entry must
  // not be resurrected to BOOKED. Zero rows = already stamped or moved on.
  const res = await prisma.waitlist.updateMany({
    where: {
      id: waitlistId,
      status: { in: [WaitlistStatus.NOTIFIED, WaitlistStatus.WAITING] },
    },
    data: {
      status: WaitlistStatus.BOOKED,
      bookedAt: new Date(),
      respondedAt: new Date(),
    },
  });

  console.log(
    JSON.stringify({
      event:
        res.count === 0
          ? "waitlist_booking_already_stamped"
          : "waitlist_booking_completed",
      waitlistId,
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Check current availability for an event
 */
export async function checkEventAvailability(params: {
  webinarId?: string;
  classId?: string;
}): Promise<{
  available: boolean;
  currentParticipants: number;
  maxParticipants: number;
  waitlistCount: number;
}> {
  const { webinarId, classId } = params;

  if (webinarId) {
    const webinar = await prisma.webinar.findUnique({
      where: { id: webinarId },
      include: {
        webinarPlan: {
          include: { consultantProfile: true },
        },
        appointment: {
          include: {
            slotsOfAppointment: {
              include: { user: true },
            },
          },
        },
        waitlist: {
          where: {
            status: { in: [WaitlistStatus.WAITING, WaitlistStatus.NOTIFIED] },
          },
        },
      },
    });

    if (!webinar) {
      throw new Error("Webinar not found");
    }

    const webinarConsultantUserId =
      webinar.webinarPlan.consultantProfile?.userId;
    const currentParticipants = countWebinarParticipants(
      webinar.appointment,
      webinarConsultantUserId ? [webinarConsultantUserId] : [],
    );
    const maxParticipants = webinar.webinarPlan.maxParticipants;

    return {
      available: currentParticipants < maxParticipants,
      currentParticipants,
      maxParticipants,
      waitlistCount: webinar.waitlist.length,
    };
  }

  if (classId) {
    const classInstance = await prisma.class.findUnique({
      where: { id: classId },
      include: {
        classPlan: {
          include: { consultantProfile: true },
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
        waitlist: {
          where: {
            status: { in: [WaitlistStatus.WAITING, WaitlistStatus.NOTIFIED] },
          },
        },
      },
    });

    if (!classInstance) {
      throw new Error("Class not found");
    }

    // Count unique participants across all appointments, excluding the consultant
    const classConsultantUserId =
      classInstance.classPlan.consultantProfile?.userId;
    const uniqueParticipantIds = new Set<string>();
    for (const appointment of classInstance.appointments) {
      for (const slot of appointment.slotsOfAppointment) {
        for (const user of slot.user) {
          if (classConsultantUserId && user.id === classConsultantUserId)
            continue;
          uniqueParticipantIds.add(user.id);
        }
      }
    }

    const currentParticipants = uniqueParticipantIds.size;
    const maxParticipants = classInstance.classPlan.maxParticipants;

    return {
      available: currentParticipants < maxParticipants,
      currentParticipants,
      maxParticipants,
      waitlistCount: classInstance.waitlist.length,
    };
  }

  throw new Error("Either webinarId or classId must be provided");
}

/**
 * Join the waitlist for an event
 */
export async function joinWaitlist(params: {
  userId: string;
  webinarId?: string;
  classId?: string;
  preferences?: Record<string, unknown>;
}): Promise<{
  success: boolean;
  waitlistId?: string;
  position?: number;
  message: string;
}> {
  const { userId, webinarId, classId, preferences } = params;

  if (!webinarId && !classId) {
    return {
      success: false,
      message: "Either webinarId or classId must be provided",
    };
  }

  // XOR: exactly one event type must be specified
  if (webinarId && classId) {
    return {
      success: false,
      message: "Provide either webinarId or classId, not both",
    };
  }

  // Check if user is already on the waitlist
  const existingEntry = await prisma.waitlist.findFirst({
    where: {
      userId,
      ...(webinarId ? { webinarId } : { classId }),
      status: { in: [WaitlistStatus.WAITING, WaitlistStatus.NOTIFIED] },
    },
  });

  if (existingEntry) {
    return {
      success: false,
      message: "You are already on the waitlist for this event",
    };
  }

  // Check event availability
  const availability = await checkEventAvailability({ webinarId, classId });

  if (availability.available) {
    return {
      success: false,
      message:
        "Spots are still available. You can register directly without joining the waitlist.",
    };
  }

  // Create waitlist entry
  const entry = await prisma.waitlist.create({
    data: {
      userId,
      webinarId,
      classId,
      preferences: preferences as object | undefined,
      status: WaitlistStatus.WAITING,
    },
  });

  // Calculate position using priority-based queue
  const position = await calculatePosition(entry.id);

  // Update the position in the entry
  await prisma.waitlist.update({
    where: { id: entry.id },
    data: { position },
  });

  console.log(
    JSON.stringify({
      event: "waitlist_joined",
      waitlistId: entry.id,
      userId,
      webinarId,
      classId,
      position,
      timestamp: new Date().toISOString(),
    }),
  );

  return {
    success: true,
    waitlistId: entry.id,
    position,
    message: `You have been added to the waitlist at position #${position}`,
  };
}

/**
 * Leave the waitlist voluntarily
 */
export async function leaveWaitlist(params: {
  waitlistId: string;
  userId: string;
}): Promise<{
  success: boolean;
  message: string;
}> {
  const { waitlistId, userId } = params;

  const entry = await prisma.waitlist.findUnique({
    where: { id: waitlistId },
  });

  if (!entry) {
    return { success: false, message: "Waitlist entry not found" };
  }

  if (entry.userId !== userId) {
    return { success: false, message: "Unauthorized" };
  }

  if (!["WAITING", "NOTIFIED"].includes(entry.status)) {
    return {
      success: false,
      message: "Cannot leave waitlist with current status",
    };
  }

  // #834 — CAS: the pre-check above is friendly error text; the WHERE is
  // what prevents a leave racing a respond/expire from double-firing.
  const left = await prisma.waitlist.updateMany({
    where: {
      id: waitlistId,
      status: { in: [WaitlistStatus.WAITING, WaitlistStatus.NOTIFIED] },
    },
    data: {
      status: WaitlistStatus.CANCELLED,
      respondedAt: new Date(),
    },
  });
  if (left.count === 0) {
    return {
      success: false,
      message: "Cannot leave waitlist with current status",
    };
  }

  // If the entry was NOTIFIED, notify next person
  if (entry.status === WaitlistStatus.NOTIFIED) {
    await handleSlotOpening({
      webinarId: entry.webinarId ?? undefined,
      classId: entry.classId ?? undefined,
      slotsAvailable: 1,
      reason: "cancellation",
    });
  }

  // Update positions
  await updatePositions({
    webinarId: entry.webinarId ?? undefined,
    classId: entry.classId ?? undefined,
  });

  console.log(
    JSON.stringify({
      event: "waitlist_left",
      waitlistId,
      userId,
      previousStatus: entry.status,
      timestamp: new Date().toISOString(),
    }),
  );

  return {
    success: true,
    message: "You have been removed from the waitlist",
  };
}
