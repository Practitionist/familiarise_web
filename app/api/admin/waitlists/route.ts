import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, WaitlistStatus } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    // Parse query parameters
    const searchParams = req.nextUrl.searchParams;
    const status = searchParams.get("status");
    const eventType = searchParams.get("eventType");
    const search = searchParams.get("search");
    const groupBy = searchParams.get("groupBy") || "event"; // event, status, date
    const timeline = searchParams.get("timeline"); // upcoming, past, all
    const page = parseInt(searchParams.get("page") || "1");
    const limit = 50;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Prisma.WaitlistWhereInput = {};

    // Filter by status
    if (
      status &&
      status !== "all" &&
      Object.values(WaitlistStatus).includes(status as WaitlistStatus)
    ) {
      where.status = status as WaitlistStatus;
    }

    // Filter by event type
    if (eventType === "webinar") {
      where.webinarId = { not: null };
      where.classId = null;
    } else if (eventType === "class") {
      where.classId = { not: null };
      where.webinarId = null;
    }

    // Search by user name or email
    if (search) {
      where.user = {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
        ],
      };
    }

    // Filter by timeline at database level
    const now = new Date();
    if (timeline === "upcoming") {
      // Upcoming: scheduled date is in the future
      where.OR = [
        {
          webinar: {
            appointment: {
              slotsOfAppointment: {
                some: {
                  startsAt: { gt: now },
                },
              },
            },
          },
        },
        {
          class: {
            appointments: {
              some: {
                slotsOfAppointment: {
                  some: {
                    startsAt: { gt: now },
                  },
                },
              },
            },
          },
        },
      ];
    } else if (timeline === "past") {
      // Past: scheduled date is in the past (or no schedule)
      where.AND = [
        {
          OR: [
            // Webinar with past date
            {
              webinar: {
                appointment: {
                  slotsOfAppointment: {
                    every: {
                      startsAt: { lte: now },
                    },
                  },
                },
              },
            },
            // Class with past date
            {
              class: {
                appointments: {
                  every: {
                    slotsOfAppointment: {
                      every: {
                        startsAt: { lte: now },
                      },
                    },
                  },
                },
              },
            },
            // No appointment scheduled (webinar with null appointment)
            {
              webinarId: { not: null },
              webinar: {
                appointment: null,
              },
            },
            // No appointments scheduled (class with empty appointments)
            {
              classId: { not: null },
              class: {
                appointments: {
                  none: {},
                },
              },
            },
          ],
        },
      ];
    }

    // Fetch waitlist entries with full appointment data
    const [waitlists, total] = await Promise.all([
      prisma.waitlist.findMany({
        where,
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
              webinarPlan: {
                select: {
                  id: true,
                  title: true,
                  consultantProfile: {
                    select: {
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
                    orderBy: { startsAt: "asc" },
                  },
                },
              },
            },
          },
          class: {
            include: {
              classPlan: {
                select: {
                  id: true,
                  title: true,
                  consultantProfile: {
                    select: {
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
                    orderBy: { startsAt: "asc" },
                  },
                },
              },
            },
          },
        },
        orderBy: { joinedAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.waitlist.count({ where }),
    ]);

    // Transform data for frontend
    const transformedWaitlists = waitlists.map((entry) => {
      // Get scheduled date
      const scheduledDate =
        entry.webinar?.appointment?.slotsOfAppointment?.[0]?.startsAt ||
        entry.class?.appointments?.[0]?.slotsOfAppointment?.[0]?.startsAt ||
        null;

      // Get consultant info
      const consultant =
        entry.webinar?.webinarPlan.consultantProfile?.user ||
        entry.class?.classPlan.consultantProfile?.user ||
        null;

      return {
        id: entry.id,
        userId: entry.userId,
        user: entry.user,
        eventType: entry.webinarId ? ("webinar" as const) : ("class" as const),
        eventId: entry.webinarId || entry.classId,
        eventTitle:
          entry.webinar?.webinarPlan.title ||
          entry.class?.classPlan.title ||
          "Unknown",
        planId: entry.webinar?.webinarPlan.id || entry.class?.classPlan.id,
        consultant,
        scheduledDate: scheduledDate?.toISOString() || null,
        isUpcoming: scheduledDate ? scheduledDate > now : null,
        status: entry.status,
        position: entry.position,
        priority: entry.priority,
        joinedAt: entry.joinedAt.toISOString(),
        notifiedAt: entry.notifiedAt?.toISOString() || null,
        expiresAt: entry.expiresAt?.toISOString() || null,
        respondedAt: entry.respondedAt?.toISOString() || null,
        bookedAt: entry.bookedAt?.toISOString() || null,
      };
    });

    // Timeline filtering is now done at database level (see where clause above)

    // Get stats for the header
    const stats = await prisma.waitlist.groupBy({
      by: ["status"],
      _count: true,
    });

    const statusCounts = stats.reduce(
      (acc, curr) => {
        acc[curr.status] = curr._count;
        return acc;
      },
      {} as Record<string, number>,
    );

    // Group entries if requested
    let groupedData: Record<string, typeof transformedWaitlists> | null = null;

    if (groupBy === "event") {
      groupedData = {};
      for (const entry of transformedWaitlists) {
        const _key = `${entry.eventType}:${entry.eventId}`;
        const label = entry.eventTitle;
        if (!groupedData[label]) {
          groupedData[label] = [];
        }
        groupedData[label].push(entry);
      }
    } else if (groupBy === "status") {
      groupedData = {};
      for (const entry of transformedWaitlists) {
        if (!groupedData[entry.status]) {
          groupedData[entry.status] = [];
        }
        groupedData[entry.status].push(entry);
      }
    } else if (groupBy === "date") {
      groupedData = {
        "Upcoming Events": [],
        "Past Events": [],
        "No Date Set": [],
      };
      for (const entry of transformedWaitlists) {
        if (entry.isUpcoming === true) {
          groupedData["Upcoming Events"].push(entry);
        } else if (entry.isUpcoming === false) {
          groupedData["Past Events"].push(entry);
        } else {
          groupedData["No Date Set"].push(entry);
        }
      }
      // Remove empty groups
      for (const key of Object.keys(groupedData)) {
        if (groupedData[key].length === 0) {
          delete groupedData[key];
        }
      }
    }

    // Count active waitlists (need attention)
    const activeCount = await prisma.waitlist.count({
      where: {
        status: { in: [WaitlistStatus.WAITING, WaitlistStatus.NOTIFIED] },
      },
    });

    return NextResponse.json({
      waitlists: transformedWaitlists,
      grouped: groupedData,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      stats: {
        total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
        active: activeCount,
        waiting: statusCounts.WAITING || 0,
        notified: statusCounts.NOTIFIED || 0,
        booked: statusCounts.BOOKED || 0,
        expired: statusCounts.EXPIRED || 0,
        cancelled: statusCounts.CANCELLED || 0,
        skipped: statusCounts.SKIPPED || 0,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error fetching admin waitlists:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
