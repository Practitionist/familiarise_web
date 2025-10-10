import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { RequestStatus } from "@prisma/client";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  try {
    const { consultantId } = await params;

    if (!consultantId) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 },
      );
    }

    // Fetch all requests data in parallel using direct Prisma queries
    const [
      consultations,
      subscriptions,
      weeklyAvailability,
      customAvailability,
      appointments,
      consultant,
    ] = await Promise.all([
      // Pending consultations
      prisma.consultation.findMany({
        where: {
          consultationPlan: {
            consultantProfileId: consultantId,
          },
          requestStatus: RequestStatus.PENDING,
        },
        select: {
          id: true,
          requestStatus: true,
          requestedAt: true,
          requestNotes: true,
          consultationPlan: {
            select: {
              id: true,
              title: true,
              description: true,
              durationInHours: true,
              price: true,
              consultantProfile: {
                select: {
                  id: true,
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
            },
          },
          requestedBy: {
            select: {
              id: true,
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
        },
        orderBy: {
          requestedAt: "desc",
        },
      }),

      // Pending subscriptions
      prisma.subscription.findMany({
        where: {
          subscriptionPlan: {
            consultantProfileId: consultantId,
          },
          requestStatus: RequestStatus.PENDING,
        },
        select: {
          id: true,
          requestStatus: true,
          requestedAt: true,
          requestNotes: true,
          startDate: true,
          endDate: true,
          subscriptionPlan: {
            select: {
              id: true,
              title: true,
              description: true,
              durationInMonths: true,
              price: true,
              callsPerWeek: true,
              consultantProfile: {
                select: {
                  id: true,
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
            },
          },
          requestedBy: {
            select: {
              id: true,
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
        },
        orderBy: {
          requestedAt: "desc",
        },
      }),

      // Weekly availability slots
      prisma.slotOfAvailabilityWeekly.findMany({
        where: {
          consultantProfileId: consultantId,
        },
        select: {
          id: true,
          dayOfWeekforStartTimeInUTC: true,
          slotStartTimeInUTC: true,
          dayOfWeekforEndTimeInUTC: true,
          slotEndTimeInUTC: true,
          consultantProfile: {
            select: {
              id: true,
              user: {
                select: {
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
        orderBy: {
          dayOfWeekforStartTimeInUTC: "asc",
        },
      }),

      // Custom availability slots
      prisma.slotOfAvailabilityCustom.findMany({
        where: {
          consultantProfileId: consultantId,
        },
        select: {
          id: true,
          slotStartTimeInUTC: true,
          slotEndTimeInUTC: true,
          consultantProfile: {
            select: {
              id: true,
              user: {
                select: {
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
        orderBy: {
          slotStartTimeInUTC: "asc",
        },
      }),

      // Approved appointments
      prisma.appointment.findMany({
        where: {
          OR: [
            {
              consultation: {
                consultationPlan: {
                  consultantProfileId: consultantId,
                },
                requestStatus: RequestStatus.APPROVED,
              },
            },
            {
              subscription: {
                subscriptionPlan: {
                  consultantProfileId: consultantId,
                },
                requestStatus: RequestStatus.APPROVED,
              },
            },
            {
              webinar: {
                webinarPlan: {
                  consultantProfileId: consultantId,
                },
                status: "SCHEDULED",
              },
            },
            {
              class: {
                classPlan: {
                  consultantProfileId: consultantId,
                },
                status: "SCHEDULED",
              },
            },
          ],
        },
        select: {
          id: true,
          appointmentType: true,
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
                  email: true,
                  image: true,
                  phone: true,
                  consulteeProfileId: true,
                },
              },
            },
          },
          consultation: {
            select: {
              id: true,
              requestStatus: true,
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
            },
          },
          subscription: {
            select: {
              id: true,
              requestStatus: true,
              startDate: true,
              endDate: true,
              subscriptionPlan: {
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
            },
          },
          webinar: {
            select: {
              id: true,
              status: true,
              webinarPlan: {
                select: {
                  id: true,
                  title: true,
                  consultantProfile: {
                    select: {
                      id: true,
                    },
                  },
                },
              },
            },
          },
          class: {
            select: {
              id: true,
              status: true,
              classPlan: {
                select: {
                  id: true,
                  title: true,
                  consultantProfile: {
                    select: {
                      id: true,
                    },
                  },
                },
              },
            },
          },
        },
        take: 100,
        orderBy: {
          createdAt: "desc",
        },
      }),

      // Consultant profile
      prisma.consultantProfile.findUnique({
        where: {
          id: consultantId,
        },
        select: {
          id: true,
          description: true,
          qualifications: true,
          specialization: true,
          experience: true,
          rating: true,
          scheduleType: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
              phone: true,
              role: true,
            },
          },
          domain: {
            select: {
              id: true,
              name: true,
            },
          },
          subDomains: {
            select: {
              id: true,
              name: true,
            },
          },
          tags: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
    ]);

    const requestsData = {
      consultations: consultations || [],
      subscriptions: subscriptions || [],
      weeklyAvailability: weeklyAvailability || [],
      customAvailability: customAvailability || [],
      appointments: appointments || [],
      consultant: consultant || null,
    };

    return NextResponse.json({
      data: requestsData,
      success: true,
    });
  } catch (error: unknown) {
    console.error("Error fetching requests data:", error);
    return NextResponse.json(
      { error: "Failed to fetch requests data" },
      { status: 500 },
    );
  }
}
