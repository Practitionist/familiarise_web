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

// Derive types from the include objects
type DashboardAppointment = Prisma.AppointmentGetPayload<{
  include: typeof appointmentInclude;
}>;
type DashboardConsultation = Prisma.ConsultationGetPayload<{
  include: typeof consultationInclude;
}>;
type DashboardSubscription = Prisma.SubscriptionGetPayload<{
  include: typeof subscriptionInclude;
}>;

// =============================================================================
// Helper Functions
// =============================================================================

function formatDate(dateString?: string | Date | null): string {
  if (!dateString) return "Date not set";
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return "Invalid date";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(dateString?: string | Date | null): string {
  if (!dateString) return "Time not set";
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return "Invalid time";

  return date.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function getRelativeTime(date: Date): string {
  const now = new Date();
  // Use Math.max to handle potential future dates (e.g., clock skew)
  const diffMs = Math.max(0, now.getTime() - new Date(date).getTime());
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return "just now";
  } else if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays === 1) {
    return "1d ago";
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    return formatDate(date);
  }
}

// =============================================================================
// Route Handler
// =============================================================================

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  // Note: request parameter kept for Next.js API route signature compatibility
  void request;

  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const resolvedParams = await params;
    const { consultantId: consultantProfileId } = resolvedParams;

    if (!consultantProfileId) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 },
      );
    }

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    const ownsProfile =
      session.user.role === "CONSULTANT" &&
      session.user.consultantProfileId === consultantProfileId;

    if (!isPrivileged && !ownsProfile) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // PERFORMANCE FIX #364: Use direct Prisma queries instead of internal HTTP fetches
    // This eliminates network overhead and reduces response time significantly
    const [
      appointmentsRaw,
      pendingConsultations,
      pendingSubscriptions,
      recentActivities,
    ] = await Promise.all([
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
      // Fetch recent activities
      prisma.activityLog.findMany({
        where: {
          consultantProfileId,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 10,
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

    // Transform appointments (same logic as fetchHelpers.ts)
    const transformedAppointments = sortedAppointments.map(
      (appointment: DashboardAppointment) => ({
        id: appointment.id,
        appointmentType: appointment.appointmentType,
        slotsOfAppointment: appointment.slotsOfAppointment.map((slot) => ({
          id: slot.id,
          slotStartTimeInUTC: new Date(slot.startsAt),
          slotEndTimeInUTC: slot.endsAt ? new Date(slot.endsAt) : null,
          isTentative: slot.isTentative,
          user: Array.isArray(slot.user)
            ? slot.user.map((u) => ({
                id: u.id,
                name: u.name,
                email: u.email,
                image: u.image,
              }))
            : [],
        })),
        consultation: appointment.consultation
          ? {
              id: appointment.consultation.id,
              consultationPlan: {
                ...appointment.consultation.consultationPlan,
                consultantProfile:
                  appointment.consultation.consultationPlan.consultantProfile,
              },
              requestStatus: appointment.consultation.requestStatus,
              requestedBy: {
                id: appointment.consultation.requestedBy?.id ?? "",
                user: {
                  name:
                    appointment.consultation.requestedBy?.user?.name ?? null,
                  image:
                    appointment.consultation.requestedBy?.user?.image ?? null,
                },
              },
            }
          : undefined,
        subscription: appointment.subscription
          ? {
              id: appointment.subscription.id,
              subscriptionPlan: {
                ...appointment.subscription.subscriptionPlan,
                consultantProfile:
                  appointment.subscription.subscriptionPlan.consultantProfile,
              },
              requestStatus: appointment.subscription.requestStatus,
              requestedBy: {
                id: appointment.subscription.requestedBy?.id ?? "",
                user: {
                  name:
                    appointment.subscription.requestedBy?.user?.name ?? null,
                  image:
                    appointment.subscription.requestedBy?.user?.image ?? null,
                },
              },
              startDate: new Date(
                appointment.subscription.schedulingPeriodStartsAt,
              ).toISOString(),
              endDate: new Date(
                appointment.subscription.schedulingPeriodEndsAt,
              ).toISOString(),
            }
          : undefined,
        webinar: appointment.webinar
          ? {
              id: appointment.webinar.id,
              webinarPlan: {
                ...appointment.webinar.webinarPlan,
                consultantProfile:
                  appointment.webinar.webinarPlan.consultantProfile,
              },
              status: appointment.webinar.status,
            }
          : undefined,
        class: appointment.class
          ? {
              id: appointment.class.id,
              classPlan: {
                ...appointment.class.classPlan,
                consultantProfile:
                  appointment.class.classPlan.consultantProfile,
              },
              status: appointment.class.status,
            }
          : undefined,
      }),
    );

    // Transform approvals (same logic as fetchHelpers.ts)
    const consultationApprovals = pendingConsultations.map(
      (consultation: DashboardConsultation) => ({
        id: consultation.id,
        type: "Consultation",
        name: consultation.requestedBy?.user?.name ?? "Unknown",
        requestedAt: consultation.requestedAt,
      }),
    );

    const subscriptionApprovals = pendingSubscriptions.map(
      (subscription: DashboardSubscription) => ({
        id: subscription.id,
        type: "Subscription",
        name: subscription.requestedBy?.user?.name ?? "Unknown",
        requestedAt: subscription.requestedAt,
      }),
    );

    // Sort by requestedAt (ISO string) for type safety
    const sortedApprovals = [
      ...consultationApprovals,
      ...subscriptionApprovals,
    ].sort(
      (a, b) =>
        new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime(),
    );

    // Map to display format for response
    const approvals = sortedApprovals.map((approval) => ({
      id: approval.id,
      type: approval.type,
      name: approval.name,
      date: formatDate(approval.requestedAt),
      time: formatTime(approval.requestedAt),
    }));

    // Transform activities for display
    const activities = recentActivities.map((activity) => ({
      id: activity.id,
      type: activity.activityType,
      description: activity.description,
      actorId: activity.actorId,
      actorName: activity.actorName,
      actorImage: activity.actorImage,
      metadata: activity.metadata,
      createdAt: activity.createdAt,
      // Formatted time for display
      timeAgo: getRelativeTime(activity.createdAt),
    }));

    // Return consolidated response
    return NextResponse.json({
      success: true,
      data: {
        appointments: transformedAppointments,
        activities,
        approvals,
      },
    });
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch dashboard data",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
