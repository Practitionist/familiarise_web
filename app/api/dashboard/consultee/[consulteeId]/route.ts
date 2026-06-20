import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";

// =============================================================================
// Prisma Query Types - Derived from actual query shape for type safety
// =============================================================================

const userSelectFields = {
  id: true,
  name: true,
  email: true,
  image: true,
  role: true,
  phone: true,
} as const;

const consultationInclude = {
  consultationPlan: {
    include: {
      consultantProfile: {
        include: {
          user: {
            select: userSelectFields,
          },
        },
      },
    },
  },
  requestedBy: {
    include: {
      user: {
        select: userSelectFields,
      },
    },
  },
  appointment: {
    include: {
      slotsOfAppointment: {
        include: {
          user: {
            select: userSelectFields,
          },
        },
        orderBy: {
          startsAt: "asc" as const,
        },
      },
      payment: true,
    },
  },
} satisfies Prisma.ConsultationInclude;

const subscriptionInclude = {
  subscriptionPlan: {
    include: {
      consultantProfile: {
        include: {
          user: {
            select: userSelectFields,
          },
          domain: true,
          subDomains: true,
          tags: true,
        },
      },
    },
  },
  requestedBy: {
    include: {
      user: {
        select: userSelectFields,
      },
    },
  },
  appointments: {
    include: {
      slotsOfAppointment: {
        include: {
          user: {
            select: userSelectFields,
          },
        },
      },
      payment: true,
    },
  },
} satisfies Prisma.SubscriptionInclude;

const webinarInclude = {
  webinarPlan: {
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
      topics: true,
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
              consulteeProfileId: true,
            },
          },
        },
      },
      payment: true,
    },
  },
  // Note: waitlist include is dynamic based on consulteeId, handled separately
} satisfies Prisma.WebinarInclude;

const classInclude = {
  classPlan: {
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
      classContents: {
        orderBy: {
          order: "asc" as const,
        },
      },
    },
  },
  appointments: {
    include: {
      slotsOfAppointment: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
              consulteeProfileId: true,
            },
          },
        },
      },
      payment: true,
    },
  },
  // Note: waitlist include is dynamic based on consulteeId, handled separately
} satisfies Prisma.ClassInclude;

// =============================================================================
// Route Handler
// =============================================================================

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  // Note: request parameter kept for Next.js API route signature compatibility
  void request;

  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const resolvedParams = await params;
    const { consulteeId } = resolvedParams;

    if (!consulteeId) {
      return NextResponse.json(
        { error: "Consultee ID is required" },
        { status: 400 },
      );
    }

    // Verify the consultee profile exists before fetching data
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { id: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    const ownsProfile =
      session.user.role === "CONSULTEE" &&
      session.user.consulteeProfileId === consulteeId;

    if (!isPrivileged && !ownsProfile) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // PERFORMANCE FIX #364: Use direct Prisma queries instead of internal HTTP fetches
    // This eliminates network overhead and reduces response time significantly
    const [consultations, subscriptions, webinars, classes] = await Promise.all(
      [
        // Fetch consultations for this consultee
        prisma.consultation.findMany({
          where: { requestedById: consulteeId },
          include: consultationInclude,
          orderBy: {
            requestedAt: "desc",
          },
        }),
        // Fetch subscriptions for this consultee
        prisma.subscription.findMany({
          where: { requestedById: consulteeId },
          include: subscriptionInclude,
          orderBy: {
            requestedAt: "desc",
          },
        }),
        // Webinars: User registered via waitlist or via appointment slots
        prisma.webinar.findMany({
          where: {
            OR: [
              // Get webinars where consultee is registered through appointments
              {
                appointment: {
                  slotsOfAppointment: {
                    some: {
                      user: {
                        some: {
                          consulteeProfile: {
                            id: consulteeId,
                          },
                        },
                      },
                    },
                  },
                },
              },
              // Get webinars where consultee is in waitlist
              {
                waitlist: {
                  some: {
                    user: {
                      consulteeProfile: {
                        id: consulteeId,
                      },
                    },
                  },
                },
              },
            ],
          },
          include: {
            ...webinarInclude,
            waitlist: {
              where: {
                user: {
                  consulteeProfile: {
                    id: consulteeId,
                  },
                },
              },
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                    consulteeProfile: true,
                  },
                },
              },
            },
          },
        }),
        // Classes: User registered via waitlist or via appointment slots
        prisma.class.findMany({
          where: {
            OR: [
              // Get classes where consultee is registered through appointments
              {
                appointments: {
                  some: {
                    slotsOfAppointment: {
                      some: {
                        user: {
                          some: {
                            consulteeProfile: {
                              id: consulteeId,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              // Get classes where consultee is in waitlist
              {
                waitlist: {
                  some: {
                    user: {
                      consulteeProfile: {
                        id: consulteeId,
                      },
                    },
                  },
                },
              },
            ],
          },
          include: {
            ...classInclude,
            waitlist: {
              where: {
                userId: consulteeId,
              },
              select: {
                userId: true,
                joinedAt: true,
              },
            },
          },
          orderBy: [
            {
              schedulingPeriodStartsAt: "desc",
            },
            {
              status: "asc",
            },
          ],
        }),
      ],
    );

    // Return consolidated response
    return NextResponse.json({
      success: true,
      data: {
        consultations: consultations || [],
        subscriptions: subscriptions || [],
        webinars: webinars || [],
        classes: classes || [],
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "dashboard" } });
    console.error("Error fetching consultee events:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch events data",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
