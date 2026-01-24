/**
 * Waitlist Queue Manager
 * Handles queue position calculations, ordering, and position updates
 */

import prisma from "@/lib/prisma";
import { Prisma, WaitlistStatus } from "@prisma/client";

// Type for waitlist entry with user details
export type WaitlistEntryWithDetails = Prisma.WaitlistGetPayload<{
  include: {
    user: {
      select: {
        id: true;
        name: true;
        email: true;
        image: true;
      };
    };
    webinar: {
      include: {
        webinarPlan: true;
        appointment: {
          include: {
            slotsOfAppointment: true;
          };
        };
      };
    };
    class: {
      include: {
        classPlan: true;
        appointments: {
          include: {
            slotsOfAppointment: true;
          };
        };
      };
    };
  };
}>;

/**
 * Calculate a user's position in the waitlist queue
 * Position is based on priority (descending) and joinedAt (ascending)
 */
export async function calculatePosition(waitlistId: string): Promise<number> {
  const entry = await prisma.waitlist.findUnique({
    where: { id: waitlistId },
    select: {
      webinarId: true,
      classId: true,
      priority: true,
      joinedAt: true,
      status: true,
    },
  });

  if (!entry) {
    throw new Error("Waitlist entry not found");
  }

  // Only WAITING entries have a position
  if (entry.status !== WaitlistStatus.WAITING) {
    return -1;
  }

  const eventFilter = entry.webinarId
    ? { webinarId: entry.webinarId }
    : { classId: entry.classId };

  // Count entries ahead of this one
  // Higher priority = ahead, same priority = earlier joinedAt is ahead
  const position = await prisma.waitlist.count({
    where: {
      ...eventFilter,
      status: WaitlistStatus.WAITING,
      OR: [
        // Higher priority entries
        { priority: { gt: entry.priority } },
        // Same priority but joined earlier
        {
          AND: [
            { priority: entry.priority },
            { joinedAt: { lt: entry.joinedAt } },
          ],
        },
      ],
    },
  });

  // Position is 1-indexed
  return position + 1;
}

/**
 * Get the next person in queue to notify when a spot opens
 * Returns the highest priority person who joined earliest among waiting entries
 */
export async function getNextInQueue(params: {
  webinarId?: string;
  classId?: string;
}): Promise<WaitlistEntryWithDetails | null> {
  const { webinarId, classId } = params;

  if (!webinarId && !classId) {
    throw new Error("Either webinarId or classId must be provided");
  }

  const eventFilter = webinarId ? { webinarId } : { classId };

  const entry = await prisma.waitlist.findFirst({
    where: {
      ...eventFilter,
      status: WaitlistStatus.WAITING,
    },
    orderBy: [
      { priority: "desc" }, // Higher priority first
      { joinedAt: "asc" }, // Earlier joiners first
    ],
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      webinar: {
        include: {
          webinarPlan: true,
          appointment: {
            include: {
              slotsOfAppointment: true,
            },
          },
        },
      },
      class: {
        include: {
          classPlan: true,
          appointments: {
            include: {
              slotsOfAppointment: true,
            },
          },
        },
      },
    },
  });

  return entry;
}

/**
 * Update positions for all waiting entries in a queue
 * This is typically called after a position change (someone leaves or gets notified)
 */
export async function updatePositions(params: {
  webinarId?: string;
  classId?: string;
}): Promise<void> {
  const { webinarId, classId } = params;

  if (!webinarId && !classId) {
    throw new Error("Either webinarId or classId must be provided");
  }

  const eventFilter = webinarId ? { webinarId } : { classId };

  // Get all waiting entries ordered by priority and join time
  const entries = await prisma.waitlist.findMany({
    where: {
      ...eventFilter,
      status: WaitlistStatus.WAITING,
    },
    orderBy: [{ priority: "desc" }, { joinedAt: "asc" }],
    select: { id: true },
  });

  // Update positions in a transaction
  await prisma.$transaction(
    entries.map((entry, index) =>
      prisma.waitlist.update({
        where: { id: entry.id },
        data: { position: index + 1 },
      }),
    ),
  );
}

// Type for expired entry with user and event details
export type ExpiredEntryWithDetails = Prisma.WaitlistGetPayload<{
  include: {
    user: {
      select: {
        id: true;
        name: true;
        email: true;
      };
    };
    webinar: {
      include: {
        webinarPlan: true;
      };
    };
    class: {
      include: {
        classPlan: true;
      };
    };
  };
}>;

/**
 * Process expired notifications and notify next person in queue
 * Called by cron job to handle users who didn't respond in time
 * Returns the number of expired entries processed and the entries themselves
 */
export async function processExpiredNotifications(): Promise<{
  processed: number;
  entries: ExpiredEntryWithDetails[];
  errors: Array<{ id: string; error: string }>;
}> {
  const now = new Date();
  const errors: Array<{ id: string; error: string }> = [];
  const processedEntries: ExpiredEntryWithDetails[] = [];

  // Find all expired NOTIFIED entries
  const expiredEntries = await prisma.waitlist.findMany({
    where: {
      status: WaitlistStatus.NOTIFIED,
      expiresAt: { lt: now },
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
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

  for (const entry of expiredEntries) {
    try {
      await prisma.$transaction(async (tx) => {
        // Mark as expired
        await tx.waitlist.update({
          where: { id: entry.id },
          data: {
            status: WaitlistStatus.EXPIRED,
            respondedAt: now,
          },
        });

        // Note: The slot-handler will be called separately to notify next person
      });

      processedEntries.push(entry);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      errors.push({ id: entry.id, error: errorMessage });
      console.error(
        `Error processing expired waitlist entry ${entry.id}:`,
        error,
      );
    }
  }

  // Update positions for affected events
  const webinarIds = Array.from(
    new Set(expiredEntries.filter((e) => e.webinarId).map((e) => e.webinarId!)),
  );
  const classIds = Array.from(
    new Set(expiredEntries.filter((e) => e.classId).map((e) => e.classId!)),
  );

  for (const webinarId of webinarIds) {
    await updatePositions({ webinarId });
  }

  for (const classId of classIds) {
    await updatePositions({ classId });
  }

  return {
    processed: processedEntries.length,
    entries: processedEntries,
    errors,
  };
}

/**
 * Get waitlist statistics for a consultant
 */
export async function getWaitlistStats(consultantProfileId: string) {
  // Get all webinars and classes for this consultant
  const [webinarPlans, classPlans] = await Promise.all([
    prisma.webinarPlan.findMany({
      where: { consultantProfileId },
      include: {
        webinars: {
          include: {
            waitlist: {
              where: { status: WaitlistStatus.WAITING },
            },
          },
        },
      },
    }),
    prisma.classPlan.findMany({
      where: { consultantProfileId },
      include: {
        classes: {
          include: {
            waitlist: {
              where: { status: WaitlistStatus.WAITING },
            },
          },
        },
      },
    }),
  ]);

  // Calculate statistics
  let totalWaiting = 0;
  const byWebinar: Array<{
    webinarId: string;
    title: string;
    waitingCount: number;
  }> = [];
  const byClass: Array<{
    classId: string;
    title: string;
    waitingCount: number;
  }> = [];

  for (const plan of webinarPlans) {
    for (const webinar of plan.webinars) {
      const count = webinar.waitlist.length;
      totalWaiting += count;
      if (count > 0) {
        byWebinar.push({
          webinarId: webinar.id,
          title: plan.title,
          waitingCount: count,
        });
      }
    }
  }

  for (const plan of classPlans) {
    for (const classInstance of plan.classes) {
      const count = classInstance.waitlist.length;
      totalWaiting += count;
      if (count > 0) {
        byClass.push({
          classId: classInstance.id,
          title: plan.title,
          waitingCount: count,
        });
      }
    }
  }

  // Calculate average wait time for entries that have been processed
  const completedEntries = await prisma.waitlist.findMany({
    where: {
      OR: [
        {
          webinar: {
            webinarPlan: { consultantProfileId },
          },
        },
        {
          class: {
            classPlan: { consultantProfileId },
          },
        },
      ],
      status: { in: [WaitlistStatus.BOOKED, WaitlistStatus.EXPIRED] },
      respondedAt: { not: null },
    },
    select: {
      joinedAt: true,
      respondedAt: true,
    },
  });

  let averageWaitTimeMs = 0;
  if (completedEntries.length > 0) {
    const totalWaitTime = completedEntries.reduce((sum, entry) => {
      if (entry.respondedAt) {
        return sum + (entry.respondedAt.getTime() - entry.joinedAt.getTime());
      }
      return sum;
    }, 0);
    averageWaitTimeMs = totalWaitTime / completedEntries.length;
  }

  return {
    totalWaiting,
    byWebinar,
    byClass,
    averageWaitTimeMs,
    averageWaitTimeDays:
      Math.round((averageWaitTimeMs / (1000 * 60 * 60 * 24)) * 10) / 10,
  };
}

/**
 * Get all waitlist entries for a user
 */
export async function getUserWaitlistEntries(userId: string) {
  const entries = await prisma.waitlist.findMany({
    where: {
      userId,
      status: { in: [WaitlistStatus.WAITING, WaitlistStatus.NOTIFIED] },
    },
    include: {
      webinar: {
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: {
                    select: {
                      name: true,
                      image: true,
                    },
                  },
                },
              },
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                take: 1,
              },
            },
          },
        },
      },
      class: {
        include: {
          classPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: {
                    select: {
                      name: true,
                      image: true,
                    },
                  },
                },
              },
            },
          },
          appointments: {
            take: 1,
            include: {
              slotsOfAppointment: {
                take: 1,
              },
            },
          },
        },
      },
    },
    orderBy: [
      { status: "asc" }, // NOTIFIED first
      { joinedAt: "asc" },
    ],
  });

  // Calculate positions for waiting entries
  const entriesWithPositions = await Promise.all(
    entries.map(async (entry) => {
      const position =
        entry.status === WaitlistStatus.WAITING
          ? await calculatePosition(entry.id)
          : null;
      return { ...entry, position };
    }),
  );

  // Separate into webinars and classes
  const webinars = entriesWithPositions.filter((e) => e.webinarId);
  const classes = entriesWithPositions.filter((e) => e.classId);

  return { webinars, classes };
}
