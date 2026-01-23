import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  TAppointment,
  TConsultation,
  TSubscription,
} from "@/types/appointment";
import { TConsultantProfile } from "@/types/consultant";
import { Prisma } from "@prisma/client";

// Type for weekly availability slots
type TWeeklyAvailability = Prisma.SlotOfAvailabilityWeeklyGetPayload<{
  include: {
    consultantProfile: {
      select: {
        id: true;
        user: {
          select: {
            name: true;
            email: true;
          };
        };
      };
    };
  };
}>;

// Type for custom availability slots
type TCustomAvailability = Prisma.SlotOfAvailabilityCustomGetPayload<{
  include: {
    consultantProfile: {
      select: {
        id: true;
        user: {
          select: {
            name: true;
            email: true;
          };
        };
      };
    };
  };
}>;

interface RequestsData {
  consultations: TConsultation[];
  subscriptions: TSubscription[];
  weeklyAvailability: TWeeklyAvailability[];
  customAvailability: TCustomAvailability[];
  appointments: TAppointment[];
  consultant: TConsultantProfile | null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  // Note: request parameter kept for Next.js API route signature compatibility
  void request;

  try {
    const { consultantId } = await params;
    const consultantProfileId = consultantId;

    if (!consultantId) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 },
      );
    }

    // PERFORMANCE FIX #364: Use direct Prisma queries instead of internal HTTP fetches
    // This eliminates network overhead and reduces response time significantly
    const [
      consultations,
      subscriptions,
      weeklyAvailability,
      customAvailability,
      appointmentsRaw,
      consultant,
    ] = await Promise.all([
      // Fetch pending consultations
      prisma.consultation.findMany({
        where: {
          consultationPlan: {
            consultantProfile: {
              id: consultantProfileId,
            },
          },
          requestStatus: "PENDING",
        },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: true,
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
                orderBy: {
                  startsAt: "asc",
                },
              },
              payment: true,
            },
          },
        },
        orderBy: {
          requestedAt: "desc",
        },
      }),
      // Fetch pending subscriptions
      prisma.subscription.findMany({
        where: {
          subscriptionPlan: {
            consultantProfileId,
          },
          requestStatus: "PENDING",
        },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
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
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                },
              },
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
              payment: true,
            },
          },
        },
        orderBy: {
          requestedAt: "desc",
        },
      }),
      // Fetch weekly availability slots
      prisma.slotOfAvailabilityWeekly.findMany({
        where: {
          consultantProfileId,
        },
        orderBy: [
          { dayOfWeekForStartsAt: "asc" },
          { availabilityStartsAt: "asc" },
        ],
        include: {
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
      }),
      // Fetch custom availability slots
      prisma.slotOfAvailabilityCustom.findMany({
        where: {
          consultantProfileId,
        },
        orderBy: {
          availabilityStartsAt: "asc",
        },
        include: {
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
      }),
      // Fetch approved appointments for consultations, subscriptions, webinars, and classes
      prisma.appointment.findMany({
        where: {
          OR: [
            {
              consultation: {
                consultationPlan: { consultantProfileId },
                requestStatus: "APPROVED",
              },
            },
            {
              subscription: {
                subscriptionPlan: { consultantProfileId },
                requestStatus: "APPROVED",
              },
            },
            {
              webinar: {
                webinarPlan: { consultantProfileId },
                status: "SCHEDULED",
              },
            },
            {
              class: {
                classPlan: { consultantProfileId },
                status: "SCHEDULED",
              },
            },
          ],
        },
        include: {
          slotsOfAppointment: {
            include: {
              user: true,
            },
          },
          consultation: {
            include: {
              consultationPlan: {
                include: {
                  consultantProfile: {
                    include: {
                      user: true,
                    },
                  },
                },
              },
              requestedBy: {
                include: {
                  user: true,
                },
              },
            },
          },
          subscription: {
            select: {
              id: true,
              subscriptionPlan: {
                include: {
                  consultantProfile: {
                    include: {
                      user: true,
                    },
                  },
                },
              },
              requestedBy: {
                include: {
                  user: true,
                },
              },
              schedulingPeriodStartsAt: true,
              schedulingPeriodEndsAt: true,
              requestStatus: true,
            },
          },
          webinar: {
            include: {
              webinarPlan: {
                include: {
                  consultantProfile: {
                    include: {
                      user: true,
                    },
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
                      user: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      // Fetch consultant profile
      prisma.consultantProfile.findUnique({
        where: { id: consultantId },
        include: {
          user: true,
          domain: true,
          subDomains: true,
          tags: true,
          slotsOfAvailabilityWeekly: true,
          slotsOfAvailabilityCustom: true,
          consultationPlans: true,
          subscriptionPlans: true,
          webinarPlans: true,
          classPlans: true,
          workExperiences: true,
          certifications: true,
          education: true,
        },
      }),
    ]);

    // Sort appointments by slot start time (matching original API behavior)
    const sortedAppointments = appointmentsRaw.sort((a, b) => {
      const aTime = a.slotsOfAppointment?.[0]?.startsAt;
      const bTime = b.slotsOfAppointment?.[0]?.startsAt;

      if (!aTime && !bTime) return 0;
      if (!aTime) return 1;
      if (!bTime) return -1;

      return new Date(aTime).getTime() - new Date(bTime).getTime();
    });

    const requestsData: RequestsData = {
      consultations: (consultations || []) as unknown as TConsultation[],
      subscriptions: (subscriptions || []) as unknown as TSubscription[],
      weeklyAvailability: (weeklyAvailability ||
        []) as unknown as TWeeklyAvailability[],
      customAvailability: (customAvailability ||
        []) as unknown as TCustomAvailability[],
      appointments: (sortedAppointments || []) as unknown as TAppointment[],
      consultant: (consultant || null) as unknown as TConsultantProfile | null,
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
