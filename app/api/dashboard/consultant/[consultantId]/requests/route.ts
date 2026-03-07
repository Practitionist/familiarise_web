import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

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

const weeklyAvailabilityInclude = {
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
} satisfies Prisma.SlotOfAvailabilityWeeklyInclude;

const customAvailabilityInclude = {
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
} satisfies Prisma.SlotOfAvailabilityCustomInclude;

const appointmentInclude = {
  slotsOfAppointment: {
    include: {
      user: {
        select: userSelectFields,
      },
    },
  },
  consultation: {
    include: {
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
    },
  },
  subscription: {
    select: {
      id: true,
      subscriptionPlan: {
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
              user: {
                select: userSelectFields,
              },
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
              user: {
                select: userSelectFields,
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.AppointmentInclude;

const consultantInclude = {
  user: {
    include: {
      workExperiences: true,
      certifications: true,
      education: true,
    },
  },
  domain: true,
  subDomains: true,
  tags: true,
  slotsOfAvailabilityWeekly: true,
  slotsOfAvailabilityCustom: true,
  consultationPlans: true,
  subscriptionPlans: true,
  webinarPlans: true,
  classPlans: true,
} satisfies Prisma.ConsultantProfileInclude;

// Derive types from the include objects
type RequestsConsultation = Prisma.ConsultationGetPayload<{
  include: typeof consultationInclude;
}>;
type RequestsSubscription = Prisma.SubscriptionGetPayload<{
  include: typeof subscriptionInclude;
}>;
type RequestsWeeklyAvailability = Prisma.SlotOfAvailabilityWeeklyGetPayload<{
  include: typeof weeklyAvailabilityInclude;
}>;
type RequestsCustomAvailability = Prisma.SlotOfAvailabilityCustomGetPayload<{
  include: typeof customAvailabilityInclude;
}>;
type RequestsAppointment = Prisma.AppointmentGetPayload<{
  include: typeof appointmentInclude;
}>;
type RequestsConsultant = Prisma.ConsultantProfileGetPayload<{
  include: typeof consultantInclude;
}>;

// Response data interface
interface RequestsData {
  consultations: RequestsConsultation[];
  subscriptions: RequestsSubscription[];
  weeklyAvailability: RequestsWeeklyAvailability[];
  customAvailability: RequestsCustomAvailability[];
  appointments: RequestsAppointment[];
  consultant: RequestsConsultant | null;
}

// =============================================================================
// Route Handler
// =============================================================================

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  // Note: request parameter kept for Next.js API route signature compatibility
  void request;

  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { consultantId } = await params;
    const consultantProfileId = consultantId;

    if (
      !isPrivileged(session.user.role) &&
      session.user.consultantProfileId !== consultantId
    ) {
      return forbiddenResponse("You can only access your own requests");
    }

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
        include: consultationInclude,
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
        include: subscriptionInclude,
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
          { startDay: "asc" },
          { startTimeUtc: "asc" },
        ],
        include: weeklyAvailabilityInclude,
      }),
      // Fetch custom availability slots
      prisma.slotOfAvailabilityCustom.findMany({
        where: {
          consultantProfileId,
        },
        orderBy: {
          startsAt: "asc",
        },
        include: customAvailabilityInclude,
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
        include: appointmentInclude,
      }),
      // Fetch consultant profile
      prisma.consultantProfile.findUnique({
        where: { id: consultantId },
        include: consultantInclude,
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
      consultations: consultations || [],
      subscriptions: subscriptions || [],
      weeklyAvailability: weeklyAvailability || [],
      customAvailability: customAvailability || [],
      appointments: sortedAppointments || [],
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
