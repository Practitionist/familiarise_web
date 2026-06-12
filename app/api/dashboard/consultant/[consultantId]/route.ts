import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import { PAYOUT_CONSTANTS } from "@/lib/payments/payouts/constants";
import { sumPaise } from "@/lib/payments/utils/money";

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
    orderBy: { startsAt: "asc" as const },
    include: {
      user: {
        select: userSelectFields,
      },
      meetingSession: {
        select: { id: true, endedAt: true },
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
      status: true,
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
          collaborators: {
            where: { status: "ACCEPTED" },
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
          collaborators: {
            where: { status: "ACCEPTED" },
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

// Derive types from the include objects via the extended client — raw
// GetPayload would re-introduce bigint money fields (#780).
type DashboardAppointment = Prisma.Result<
  typeof prisma.appointment,
  { include: typeof appointmentInclude },
  "findFirstOrThrow"
>;
type DashboardConsultation = Prisma.Result<
  typeof prisma.consultation,
  { include: typeof consultationInclude },
  "findFirstOrThrow"
>;
type DashboardSubscription = Prisma.Result<
  typeof prisma.subscription,
  { include: typeof subscriptionInclude },
  "findFirstOrThrow"
>;

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

    // --- Performance Snapshot date boundaries ---
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    // PERFORMANCE FIX #364: Use direct Prisma queries instead of internal HTTP fetches
    // This eliminates network overhead and reduces response time significantly
    const [
      appointmentsRaw,
      pendingConsultations,
      pendingSubscriptions,
      recentActivities,
      earningsThisMonth,
      earningsLastMonth,
      ratingAgg,
      slotCounts,
      trialCounts,
      netEarningsAgg,
      readyEarningsAgg,
    ] = await Promise.all([
      // Fetch approved appointments for consultations, subscriptions, webinars, and classes
      prisma.appointment.findMany({
        where: {
          OR: [
            {
              consultation: {
                consultationPlan: { consultantProfileId },
                status: "APPROVED",
              },
            },
            {
              subscription: {
                subscriptionPlan: { consultantProfileId },
                status: "APPROVED",
              },
            },
            {
              webinar: {
                webinarPlan: { consultantProfileId },
                status: "SCHEDULED",
              },
            },
            {
              // Collaborated webinars (co-host, moderator, etc.)
              webinar: {
                webinarPlan: {
                  collaborators: {
                    some: {
                      consultantProfileId,
                      status: "ACCEPTED",
                    },
                  },
                },
                status: "SCHEDULED",
              },
            },
            {
              class: {
                classPlan: { consultantProfileId },
                status: "SCHEDULED",
              },
            },
            {
              // Collaborated classes (co-instructor, TA, etc.)
              class: {
                classPlan: {
                  collaborators: {
                    some: {
                      consultantProfileId,
                      status: "ACCEPTED",
                    },
                  },
                },
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
          status: "PENDING",
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
          status: "PENDING",
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
      // --- Performance Snapshot Queries ---
      // 1a. Earnings this month (consultant share from ConsultantEarnings, excluding refunded, minus partial refunds)
      prisma.consultantEarnings.aggregate({
        _sum: { consultantSharePaise: true, refundedShareAmount: true },
        where: {
          consultantProfileId,
          status: { not: "REFUNDED" },
          createdAt: { gte: startOfMonth },
        },
      }),
      // 1b. Earnings last month
      prisma.consultantEarnings.aggregate({
        _sum: { consultantSharePaise: true, refundedShareAmount: true },
        where: {
          consultantProfileId,
          status: { not: "REFUNDED" },
          createdAt: { gte: startOfLastMonth, lt: startOfMonth },
        },
      }),
      // 2. Average rating
      prisma.consultantReview.aggregate({
        _avg: { rating: true },
        _count: { rating: true },
        where: { consultantProfileId },
      }),
      // 3. Session completion rate (last 30 days)
      prisma.slotOfAppointment.groupBy({
        by: ["completionStatus"],
        _count: true,
        where: {
          appointment: {
            OR: [
              { consultation: { consultationPlan: { consultantProfileId } } },
              { subscription: { subscriptionPlan: { consultantProfileId } } },
              { webinar: { webinarPlan: { consultantProfileId } } },
              { class: { classPlan: { consultantProfileId } } },
            ],
          },
          startsAt: { gte: thirtyDaysAgo, lt: now },
        },
      }),
      // 4. Trial conversion rate (90-day window)
      prisma.trialSession.groupBy({
        by: ["status"],
        _count: true,
        where: { consultantProfileId, createdAt: { gte: ninetyDaysAgo } },
      }),
      // --- Financial Summary Queries ---
      // 5. Net earnings (all-time, excluding refunded, minus partial refunds)
      prisma.consultantEarnings.aggregate({
        _sum: { consultantSharePaise: true, refundedShareAmount: true },
        where: {
          consultantProfileId,
          status: { not: "REFUNDED" },
        },
      }),
      // 6. Ready earnings (eligible for next payout — not yet assigned to a payout)
      prisma.consultantEarnings.aggregate({
        _sum: { consultantSharePaise: true, refundedShareAmount: true },
        where: {
          consultantProfileId,
          status: "READY",
          payoutId: null,
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

    // Transform appointments (same logic as fetchHelpers.ts)
    const transformedAppointments = sortedAppointments.map(
      (appointment: DashboardAppointment) => ({
        id: appointment.id,
        appointmentType: appointment.appointmentType,
        // Org-funding marker — drives the "Sponsored · <Org>" badge on
        // the consultant Home + Appointments surfaces. Previously dropped
        // by this manual field-mapping transform.
        organizationId: appointment.organizationId,
        slotsOfAppointment: appointment.slotsOfAppointment.map((slot) => ({
          id: slot.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          isTentative: slot.isTentative,
          completionStatus: slot.completionStatus,
          meetingSession: slot.meetingSession ?? null,
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
              status: appointment.consultation.status,
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
              status: appointment.subscription.status,
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
                collaborators:
                  appointment.webinar.webinarPlan.collaborators ?? [],
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
                collaborators: appointment.class.classPlan.collaborators ?? [],
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

    // --- Compute Performance Snapshot derived values ---
    // #780 — _sum bypasses the result extension: bigint until sumPaise'd.
    const earningsThisMonthVal =
      sumPaise(earningsThisMonth._sum.consultantSharePaise) -
      sumPaise(earningsThisMonth._sum.refundedShareAmount);
    const earningsLastMonthVal =
      sumPaise(earningsLastMonth._sum.consultantSharePaise) -
      sumPaise(earningsLastMonth._sum.refundedShareAmount);

    // Earnings trend: percentage change (guard against division by zero)
    const earningsTrend =
      earningsLastMonthVal > 0
        ? Math.round(
            ((earningsThisMonthVal - earningsLastMonthVal) /
              earningsLastMonthVal) *
              100,
          )
        : earningsThisMonthVal > 0
          ? 100
          : 0;

    // Session completion rate from slot counts
    const slotCountMap = new Map(
      slotCounts.map((s) => [s.completionStatus, s._count]),
    );
    const completedSlots = slotCountMap.get("COMPLETED") ?? 0;
    const cancelledSlots = slotCountMap.get("CANCELLED") ?? 0;
    const unverifiedSlots = slotCountMap.get("UNVERIFIED") ?? 0;
    const completionDenom = completedSlots + cancelledSlots + unverifiedSlots;
    const completionRate =
      completionDenom > 0
        ? Math.round((completedSlots / completionDenom) * 100)
        : null;

    // Trial conversion rate
    const trialCountMap = new Map(trialCounts.map((t) => [t.status, t._count]));
    const completedTrials = trialCountMap.get("COMPLETED") ?? 0;
    const convertedTrials = trialCountMap.get("CONVERTED") ?? 0;
    const trialDenom = completedTrials + convertedTrials;
    const trialConversionRate =
      trialDenom > 0 ? Math.round((convertedTrials / trialDenom) * 100) : null;

    // --- Financial Summary derived values ---
    const netEarningsVal =
      sumPaise(netEarningsAgg._sum.consultantSharePaise) -
      sumPaise(netEarningsAgg._sum.refundedShareAmount);
    const readyEarningsVal =
      sumPaise(readyEarningsAgg._sum.consultantSharePaise) -
      sumPaise(readyEarningsAgg._sum.refundedShareAmount);
    const payoutMinimum = PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT;
    const payoutEligible = readyEarningsVal >= payoutMinimum;

    // Active clients + programs: single pass over sorted appointments
    const activeClientIds = new Set<string>();
    const activeSubIds = new Set<string>();
    const activeClassIds = new Set<string>();
    for (const apt of sortedAppointments) {
      const isCompleted = apt.slotsOfAppointment.every(
        (s) =>
          s.completionStatus === "COMPLETED" ||
          s.completionStatus === "CANCELLED",
      );
      if (isCompleted) continue;
      const consulteeId =
        apt.consultation?.requestedBy?.id ?? apt.subscription?.requestedBy?.id;
      if (consulteeId) activeClientIds.add(consulteeId);
      if (apt.subscription?.id) activeSubIds.add(apt.subscription.id);
      if (apt.class?.id) activeClassIds.add(apt.class.id);
    }

    const financialSummary = {
      netEarnings: netEarningsVal,
      nextPayout: readyEarningsVal,
      payoutStatus: payoutEligible
        ? "Ready"
        : readyEarningsVal > 0
          ? `₹${(readyEarningsVal / 100).toLocaleString("en-IN")} / ₹${(PAYOUT_CONSTANTS.MINIMUM_PAYOUT_AMOUNT / 100).toLocaleString("en-IN")}`
          : "No ready earnings yet",
      activeClients: activeClientIds.size,
      activePrograms: activeSubIds.size + activeClassIds.size,
    };

    // Return consolidated response
    return NextResponse.json({
      success: true,
      data: {
        appointments: transformedAppointments,
        activities,
        approvals,
        performanceSnapshot: {
          earningsThisMonth: earningsThisMonthVal,
          earningsLastMonth: earningsLastMonthVal,
          earningsTrend,
          completionRate,
          averageRating: ratingAgg._avg.rating ?? 0,
          totalReviews: ratingAgg._count.rating,
          trialConversionRate,
        },
        financialSummary,
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
