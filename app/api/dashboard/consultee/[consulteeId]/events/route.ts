import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

interface ConsulteeEventsData {
  consultations: any[];
  subscriptions: any[];
  webinars: any[];
  classes: any[];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  try {
    const { consulteeId } = await params;

    if (!consulteeId) {
      return NextResponse.json(
        { error: "Consultee ID is required" },
        { status: 400 },
      );
    }

    // Parse pagination parameters for appointments
    const { searchParams } = new URL(request.url);
    const appointmentsLimit = searchParams.get("appointmentsLimit")
      ? parseInt(searchParams.get("appointmentsLimit")!)
      : 200; // Default: 200 appointments (covers most 12-month subscriptions)
    const appointmentsOffset = searchParams.get("appointmentsOffset")
      ? parseInt(searchParams.get("appointmentsOffset")!)
      : 0;

    // Parse upcomingWindow parameter for filtering near-future appointments
    const upcomingWindowDays = searchParams.get("upcomingWindow");
    const upcomingWindow = upcomingWindowDays
      ? parseInt(upcomingWindowDays)
      : null;
    const upcomingWindowDate =
      upcomingWindow && upcomingWindow > 0
        ? new Date(Date.now() + upcomingWindow * 24 * 60 * 60 * 1000)
        : null;

    // Fetch all consultee events in parallel using direct Prisma queries
    // Only select fields actually needed by the UI
    const [consultations, subscriptions, webinars, classes] =
      await Promise.all([
        // Consultations - only get essential fields
        prisma.consultation.findMany({
          where: { requestedById: consulteeId },
          select: {
            id: true,
            requestStatus: true,
            requestedAt: true,
            consultationPlan: {
              select: {
                id: true,
                title: true,
                consultantProfile: {
                  select: {
                    id: true,
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
              select: {
                id: true,
                user: {
                  select: {
                    id: true,
                    name: true,
                    image: true,
                  },
                },
              },
            },
            appointment: {
              select: {
                id: true,
                createdAt: true,
                slotsOfAppointment: {
                  select: {
                    id: true,
                    slotStartTimeInUTC: true,
                    slotEndTimeInUTC: true,
                    isTentative: true,
                    user: {
                      select: {
                        id: true,
                        name: true,
                        image: true,
                      },
                    },
                  },
                  orderBy: {
                    slotStartTimeInUTC: "asc",
                  },
                },
                payment: {
                  select: {
                    id: true,
                    amount: true,
                    paymentStatus: true,
                    createdAt: true,
                  },
                },
              },
            },
          },
          orderBy: {
            requestedAt: "desc",
          },
        }),

        // Subscriptions - limit appointments to 50 most recent
        prisma.subscription.findMany({
          where: { requestedById: consulteeId },
          select: {
            id: true,
            requestStatus: true,
            requestedAt: true,
            startDate: true,
            endDate: true,
            subscriptionPlan: {
              select: {
                id: true,
                title: true,
                durationInMonths: true,
                callsPerWeek: true,
                consultantProfile: {
                  select: {
                    id: true,
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
              select: {
                id: true,
                user: {
                  select: {
                    id: true,
                    name: true,
                    image: true,
                  },
                },
              },
            },
            appointments: {
              where: upcomingWindowDate
                ? {
                    slotsOfAppointment: {
                      some: {
                        slotStartTimeInUTC: {
                          gte: new Date(),
                          lte: upcomingWindowDate,
                        },
                      },
                    },
                  }
                : undefined,
              select: {
                id: true,
                createdAt: true,
                slotsOfAppointment: {
                  select: {
                    id: true,
                    slotStartTimeInUTC: true,
                    slotEndTimeInUTC: true,
                    isTentative: true,
                    user: {
                      select: {
                        id: true,
                        name: true,
                        image: true,
                      },
                    },
                  },
                },
                payment: {
                  select: {
                    id: true,
                    amount: true,
                    paymentStatus: true,
                    createdAt: true,
                  },
                },
              },
              take: appointmentsLimit,
              skip: appointmentsOffset,
              orderBy: {
                createdAt: "desc",
              },
            },
          },
          orderBy: {
            requestedAt: "desc",
          },
        }),

        // Webinars - using appointments and waitlist pattern
        prisma.webinar.findMany({
          where: {
            OR: [
              // Webinars where consultee is registered through appointments
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
              // Webinars where consultee is in waitlist
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
          select: {
            id: true,
            status: true,
            createdAt: true,
            webinarPlan: {
              select: {
                id: true,
                title: true,
                consultantProfile: {
                  select: {
                    id: true,
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
            appointment: {
              select: {
                id: true,
                createdAt: true,
                slotsOfAppointment: {
                  select: {
                    id: true,
                    slotStartTimeInUTC: true,
                    slotEndTimeInUTC: true,
                    isTentative: true,
                  },
                  orderBy: {
                    slotStartTimeInUTC: "asc",
                  },
                },
                payment: {
                  select: {
                    id: true,
                    amount: true,
                    paymentStatus: true,
                    createdAt: true,
                  },
                },
              },
            },
            waitlist: {
              where: {
                user: {
                  consulteeProfile: {
                    id: consulteeId,
                  },
                },
              },
              select: {
                id: true,
                joinedAt: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
        }),

        // Classes - using appointments and waitlist pattern
        prisma.class.findMany({
          where: {
            OR: [
              // Classes where consultee is registered through appointments
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
              // Classes where consultee is in waitlist
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
          select: {
            id: true,
            status: true,
            startDate: true,
            endDate: true,
            createdAt: true,
            classPlan: {
              select: {
                id: true,
                title: true,
                consultantProfile: {
                  select: {
                    id: true,
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
            appointments: {
              where: upcomingWindowDate
                ? {
                    slotsOfAppointment: {
                      some: {
                        slotStartTimeInUTC: {
                          gte: new Date(),
                          lte: upcomingWindowDate,
                        },
                      },
                    },
                  }
                : undefined,
              select: {
                id: true,
                createdAt: true,
                slotsOfAppointment: {
                  select: {
                    id: true,
                    slotStartTimeInUTC: true,
                    slotEndTimeInUTC: true,
                    isTentative: true,
                  },
                  orderBy: {
                    slotStartTimeInUTC: "asc",
                  },
                },
                payment: {
                  select: {
                    id: true,
                    amount: true,
                    paymentStatus: true,
                    createdAt: true,
                  },
                },
              },
              take: appointmentsLimit,
              skip: appointmentsOffset,
              orderBy: {
                createdAt: "desc",
              },
            },
            waitlist: {
              where: {
                user: {
                  consulteeProfile: {
                    id: consulteeId,
                  },
                },
              },
              select: {
                id: true,
                joinedAt: true,
              },
            },
          },
          orderBy: {
            startDate: "desc",
          },
        }),
      ]);

    const eventsData: ConsulteeEventsData = {
      consultations: consultations || [],
      subscriptions: subscriptions || [],
      webinars: webinars || [],
      classes: classes || [],
    };

    return NextResponse.json({
      data: eventsData,
      success: true,
    });
  } catch (error) {
    console.error("Error fetching consultee events:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch consultee events",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
