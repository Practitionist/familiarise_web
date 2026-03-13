/**
 * Waitlist Slot Handler
 * Handles spot availability and notifying users when slots open up
 */

import prisma from "@/lib/prisma";
import { WaitlistStatus } from "@prisma/client";
import {
  getNextInQueue,
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

  // Notify up to `slotsAvailable` users
  for (let i = 0; i < slotsAvailable; i++) {
    const nextInQueue = await getNextInQueue({ webinarId, classId });

    if (!nextInQueue) {
      // No more users waiting
      break;
    }

    try {
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + NOTIFICATION_WINDOW_HOURS * 60 * 60 * 1000,
      );

      // Update waitlist entry to NOTIFIED
      await prisma.waitlist.update({
        where: { id: nextInQueue.id },
        data: {
          status: WaitlistStatus.NOTIFIED,
          notifiedAt: now,
          expiresAt,
          position: null, // Clear position since they're no longer in the queue
        },
      });

      // Send notification email
      if (nextInQueue.user.email) {
        const eventTitle =
          nextInQueue.webinar?.webinarPlan.title ||
          nextInQueue.class?.classPlan.title ||
          "Event";

        const eventType = nextInQueue.webinarId ? "webinar" : "class";
        const eventId = nextInQueue.webinarId || nextInQueue.classId;

        // Get scheduled date if available
        let scheduledDate: Date | undefined;
        if (nextInQueue.webinar?.appointment?.slotsOfAppointment?.[0]) {
          scheduledDate =
            nextInQueue.webinar.appointment.slotsOfAppointment[0].startsAt;
        } else if (
          nextInQueue.class?.appointments?.[0]?.slotsOfAppointment?.[0]
        ) {
          scheduledDate =
            nextInQueue.class.appointments[0].slotsOfAppointment[0].startsAt;
        }

        await sendWaitlistSpotAvailableEmail({
          email: nextInQueue.user.email,
          name: nextInQueue.user.name || "Valued User",
          eventTitle,
          eventType,
          eventId: eventId!,
          scheduledDate,
          expiresAt,
          waitlistId: nextInQueue.id,
        });
      }

      notified.push(nextInQueue.userId);

      console.log(
        JSON.stringify({
          event: "waitlist_user_notified",
          waitlistId: nextInQueue.id,
          userId: nextInQueue.userId,
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
      errors.push({ userId: nextInQueue.userId, error: errorMessage });
      console.error(
        `Error notifying waitlist user ${nextInQueue.userId}:`,
        error,
      );
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
    await prisma.waitlist.update({
      where: { id: waitlistId },
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
      // User doesn't want the spot - remove from waitlist
      await prisma.waitlist.update({
        where: { id: waitlistId },
        data: {
          status: WaitlistStatus.CANCELLED,
          respondedAt: now,
        },
      });

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
      // User wants to skip this time - move to back of queue
      await prisma.waitlist.update({
        where: { id: waitlistId },
        data: {
          status: WaitlistStatus.SKIPPED,
          respondedAt: now,
        },
      });

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
  await prisma.waitlist.update({
    where: { id: waitlistId },
    data: {
      status: WaitlistStatus.BOOKED,
      bookedAt: new Date(),
      respondedAt: new Date(),
    },
  });

  console.log(
    JSON.stringify({
      event: "waitlist_booking_completed",
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

    const webinarConsultantUserId = webinar.webinarPlan.consultantProfile?.userId;
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
    const classConsultantUserId = classInstance.classPlan.consultantProfile?.userId;
    const uniqueParticipantIds = new Set<string>();
    for (const appointment of classInstance.appointments) {
      for (const slot of appointment.slotsOfAppointment) {
        for (const user of slot.user) {
          if (classConsultantUserId && user.id === classConsultantUserId) continue;
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

  await prisma.waitlist.update({
    where: { id: waitlistId },
    data: {
      status: WaitlistStatus.CANCELLED,
      respondedAt: new Date(),
    },
  });

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
