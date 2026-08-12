import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "lib/prisma";
import { getSession } from "@/lib/auth-server";
import { bookingOrgId, getDmChannelId } from "@/lib/stream-utils";
import {
  AppointmentSearchResultSchema,
  type AppointmentSearchResult,
} from "@/schemas/stream-search";

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to search appointments" },
        { status: 401 },
      );
    }

    const userId = session.user.id;
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get("q")?.trim().toLowerCase();

    if (!query || query.length < 2) {
      return NextResponse.json([]);
    }

    const results: AppointmentSearchResult[] = [];

    // Search Consultations (by plan title OR consultant name)
    const consultations = await prisma.consultation.findMany({
      where: {
        AND: [
          {
            OR: [
              // Search by plan title
              {
                consultationPlan: {
                  title: {
                    contains: query,
                    mode: "insensitive",
                  },
                },
              },
              // Search by consultant name
              {
                consultationPlan: {
                  consultantProfile: {
                    user: {
                      name: {
                        contains: query,
                        mode: "insensitive",
                      },
                    },
                  },
                },
              },
            ],
          },
          {
            status: {
              in: [
                "APPROVED",
                "APPROVED_PENDING_PAYMENT",
                "SCHEDULED",
                "COMPLETED",
              ],
            },
          },
          {
            OR: [
              // User is the consultee
              {
                requestedBy: {
                  userId: userId,
                },
              },
              // User is the consultant
              {
                consultationPlan: {
                  consultantProfile: {
                    userId: userId,
                  },
                },
              },
            ],
          },
        ],
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
              select: { id: true },
            },
          },
        },
        // Needed to resolve which DM thread this hit belongs to.
        appointment: { select: { organizationId: true } },
      },
      take: 10,
    });

    for (const consultation of consultations) {
      results.push({
        id: consultation.id,
        type: "consultation",
        name: consultation.consultationPlan.title,
        consultantName:
          consultation.consultationPlan.consultantProfile.user.name ||
          "Unknown",
        consultantImage:
          consultation.consultationPlan.consultantProfile.user.image ||
          undefined,
        // Funding context is part of the DM key, so a hit must resolve to the
        // SAME channel the creator made. Shared resolver, because reading only
        // the appointment sent org-hosted-plan bookings to a personal channel
        // that was never created — clicking the result opened an empty thread.
        channelId: getDmChannelId(
          consultation.consultationPlan.consultantProfile.user.id,
          consultation.requestedBy.user.id,
          bookingOrgId(consultation),
        ),
      });
    }

    // Search Subscriptions (by plan title OR consultant name)
    const subscriptions = await prisma.subscription.findMany({
      where: {
        AND: [
          {
            OR: [
              // Search by plan title
              {
                subscriptionPlan: {
                  title: {
                    contains: query,
                    mode: "insensitive",
                  },
                },
              },
              // Search by consultant name
              {
                subscriptionPlan: {
                  consultantProfile: {
                    user: {
                      name: {
                        contains: query,
                        mode: "insensitive",
                      },
                    },
                  },
                },
              },
            ],
          },
          {
            status: {
              in: [
                "APPROVED",
                "APPROVED_PENDING_PAYMENT",
                "SCHEDULED",
                "COMPLETED",
              ],
            },
          },
          {
            OR: [
              // User is the consultee
              {
                requestedBy: {
                  userId: userId,
                },
              },
              // User is the consultant
              {
                subscriptionPlan: {
                  consultantProfile: {
                    userId: userId,
                  },
                },
              },
            ],
          },
        ],
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
              select: { id: true },
            },
          },
        },
        // Needed to resolve which DM thread this hit belongs to. Filtered to
        // org-tagged rows because `take: 1` truncates server-side, before
        // bookingOrgId can pick — an unfiltered `take: 1` on a mixed
        // subscription can hand back a personal row and resolve `null`.
        appointments: {
          where: { organizationId: { not: null } },
          select: { organizationId: true },
          take: 1,
        },
      },
      take: 10,
    });

    for (const subscription of subscriptions) {
      results.push({
        id: subscription.id,
        type: "subscription",
        name: subscription.subscriptionPlan.title,
        consultantName:
          subscription.subscriptionPlan.consultantProfile.user.name ||
          "Unknown",
        consultantImage:
          subscription.subscriptionPlan.consultantProfile.user.image ||
          undefined,
        // Same resolver as createSubscriptionChannel.
        channelId: getDmChannelId(
          subscription.subscriptionPlan.consultantProfile.user.id,
          subscription.requestedBy.user.id,
          bookingOrgId(subscription),
        ),
      });
    }

    // Search Webinars
    const webinars = await prisma.webinar.findMany({
      where: {
        AND: [
          {
            webinarPlan: {
              title: {
                contains: query,
                mode: "insensitive",
              },
            },
          },
          {
            status: {
              in: ["SCHEDULED", "IN_PROGRESS", "COMPLETED"],
            },
          },
          {
            OR: [
              // User is on an appointment slot
              {
                appointment: {
                  slotsOfAppointment: {
                    some: { user: { some: { id: userId } } },
                  },
                },
              },
              // User is the consultant
              {
                webinarPlan: {
                  consultantProfile: {
                    userId: userId,
                  },
                },
              },
            ],
          },
        ],
      },
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
      },
      take: 10,
    });

    for (const webinar of webinars) {
      if (webinar.webinarPlan.consultantProfile) {
        results.push({
          id: webinar.id,
          type: "webinar",
          name: webinar.webinarPlan.title,
          consultantName:
            webinar.webinarPlan.consultantProfile.user.name || "Unknown",
          consultantImage:
            webinar.webinarPlan.consultantProfile.user.image || undefined,
          channelId: `webinar-${webinar.id}`,
        });
      }
    }

    // Search Classes
    const classes = await prisma.class.findMany({
      where: {
        AND: [
          {
            classPlan: {
              title: {
                contains: query,
                mode: "insensitive",
              },
            },
          },
          {
            status: {
              in: ["SCHEDULED", "IN_PROGRESS", "COMPLETED"],
            },
          },
          {
            OR: [
              // User is on an appointment slot
              {
                appointments: {
                  some: {
                    slotsOfAppointment: {
                      some: { user: { some: { id: userId } } },
                    },
                  },
                },
              },
              // User is the consultant
              {
                classPlan: {
                  consultantProfile: {
                    userId: userId,
                  },
                },
              },
            ],
          },
        ],
      },
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
      },
      take: 10,
    });

    for (const classItem of classes) {
      if (classItem.classPlan.consultantProfile) {
        results.push({
          id: classItem.id,
          type: "class",
          name: classItem.classPlan.title,
          consultantName:
            classItem.classPlan.consultantProfile.user.name || "Unknown",
          consultantImage:
            classItem.classPlan.consultantProfile.user.image || undefined,
          channelId: `class-${classItem.id}`,
        });
      }
    }

    // Sort results by name
    results.sort((a, b) => a.name.localeCompare(b.name));

    // Limit total results
    // Parse on the way out. The consumer derives its type from this same
    // schema, so validating here is what makes the two agree by construction
    // rather than by assertion — a field renamed in this handler fails at the
    // boundary instead of arriving as `undefined` in the search dropdown.
    return NextResponse.json(
      AppointmentSearchResultSchema.array().parse(results.slice(0, 20)),
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    console.error("Error searching appointments:", error);
    return NextResponse.json(
      { error: "Failed to search appointments" },
      { status: 500 },
    );
  }
}
