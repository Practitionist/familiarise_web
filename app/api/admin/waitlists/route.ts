import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import prisma from "@/lib/prisma";
import { Prisma, UserRole, WaitlistStatus } from "@prisma/client";
import authOptions from "../../auth/[...nextauth]/options";

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify user is admin or staff
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.ADMIN && user?.role !== UserRole.STAFF) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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

    const now = new Date();

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

    // Filter by timeline after transformation (since we need scheduledDate)
    let filteredWaitlists = transformedWaitlists;
    if (timeline === "upcoming") {
      filteredWaitlists = transformedWaitlists.filter(
        (w) => w.isUpcoming === true
      );
    } else if (timeline === "past") {
      filteredWaitlists = transformedWaitlists.filter(
        (w) => w.isUpcoming === false
      );
    }

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
      {} as Record<string, number>
    );

    // Group entries if requested
    let groupedData: Record<string, typeof filteredWaitlists> | null = null;

    if (groupBy === "event") {
      groupedData = {};
      for (const entry of filteredWaitlists) {
        const key = `${entry.eventType}:${entry.eventId}`;
        const label = entry.eventTitle;
        if (!groupedData[label]) {
          groupedData[label] = [];
        }
        groupedData[label].push(entry);
      }
    } else if (groupBy === "status") {
      groupedData = {};
      for (const entry of filteredWaitlists) {
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
      for (const entry of filteredWaitlists) {
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
      waitlists: filteredWaitlists,
      grouped: groupedData,
      total,
      filteredTotal: filteredWaitlists.length,
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
    console.error("Error fetching admin waitlists:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
