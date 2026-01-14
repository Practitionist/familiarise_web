import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";
import { getServerSession } from "next-auth";
import authOptions from "../../../auth/[...nextauth]/options";

export type AppointmentSearchResult = {
  id: string;
  type: "consultation" | "subscription" | "webinar" | "class";
  name: string;
  consultantName: string;
  consultantImage?: string;
  channelId: string;
};

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to search appointments" },
        { status: 401 }
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
            requestStatus: {
              in: ["APPROVED", "APPROVED_PENDING_PAYMENT", "SCHEDULED", "COMPLETED"],
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

    for (const consultation of consultations) {
      results.push({
        id: consultation.id,
        type: "consultation",
        name: consultation.consultationPlan.title,
        consultantName: consultation.consultationPlan.consultantProfile.user.name || "Unknown",
        consultantImage: consultation.consultationPlan.consultantProfile.user.image || undefined,
        channelId: `consultation-${consultation.id}`,
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
            requestStatus: {
              in: ["APPROVED", "APPROVED_PENDING_PAYMENT", "SCHEDULED", "COMPLETED"],
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

    for (const subscription of subscriptions) {
      results.push({
        id: subscription.id,
        type: "subscription",
        name: subscription.subscriptionPlan.title,
        consultantName: subscription.subscriptionPlan.consultantProfile.user.name || "Unknown",
        consultantImage: subscription.subscriptionPlan.consultantProfile.user.image || undefined,
        channelId: `subscription-${subscription.id}`,
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
              // User is on the waitlist
              {
                waitlist: {
                  some: {
                    userId: userId,
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
          consultantName: webinar.webinarPlan.consultantProfile.user.name || "Unknown",
          consultantImage: webinar.webinarPlan.consultantProfile.user.image || undefined,
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
              // User is on the waitlist
              {
                waitlist: {
                  some: {
                    userId: userId,
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
          consultantName: classItem.classPlan.consultantProfile.user.name || "Unknown",
          consultantImage: classItem.classPlan.consultantProfile.user.image || undefined,
          channelId: `class-${classItem.id}`,
        });
      }
    }

    // Sort results by name
    results.sort((a, b) => a.name.localeCompare(b.name));

    // Limit total results
    return NextResponse.json(results.slice(0, 20));
  } catch (error) {
    console.error("Error searching appointments:", error);
    return NextResponse.json(
      { error: "Failed to search appointments" },
      { status: 500 }
    );
  }
}
