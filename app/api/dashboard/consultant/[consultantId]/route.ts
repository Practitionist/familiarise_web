import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { RequestStatus } from "@prisma/client";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  try {
    const resolvedParams = await params;
    const { consultantId } = resolvedParams;

    // Fetch all dashboard data in parallel using direct Prisma queries
    const [appointments, consultations, subscriptions] = await Promise.all([
      // Appointments with APPROVED status
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
                  address: true,
                  onlineStatus: true,
                  currentTimezone: true,
                  onboardingCompleted: true,
                  role: true,
                  consultantProfileId: true,
                  consulteeProfileId: true,
                  staffProfileId: true,
                },
              },
            },
            orderBy: {
              slotStartTimeInUTC: "asc",
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
                  description: true,
                  durationInMonths: true,
                  price: true,
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
                  description: true,
                  price: true,
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
                  description: true,
                  price: true,
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
            },
          },
        },
        take: 100, // Limit to 100 most recent appointments
        orderBy: {
          createdAt: "desc",
        },
      }),

      // Consultations with PENDING status
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
          consultationPlan: {
            select: {
              id: true,
              title: true,
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
        orderBy: {
          requestedAt: "desc",
        },
      }),

      // Subscriptions with PENDING status
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
          subscriptionPlan: {
            select: {
              id: true,
              title: true,
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
        orderBy: {
          requestedAt: "desc",
        },
      }),
    ]);

    // Transform appointments for response format
    const transformedAppointments = appointments.map((appointment) => ({
      ...appointment,
      slotsOfAppointment: appointment.slotsOfAppointment.map((slot) => ({
        ...slot,
        slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
        slotEndTimeInUTC: slot.slotEndTimeInUTC
          ? new Date(slot.slotEndTimeInUTC)
          : null,
      })),
      subscription: appointment.subscription
        ? {
            ...appointment.subscription,
            startDate: new Date(appointment.subscription.startDate).toISOString(),
            endDate: new Date(appointment.subscription.endDate).toISOString(),
          }
        : undefined,
    }));

    // Transform approvals
    const consultationApprovals = consultations.map((consultation) => ({
      id: consultation.id,
      type: "Consultation",
      name: consultation.requestedBy?.user?.name ?? "Unknown",
      requestedAt: consultation.requestedAt,
    }));

    const subscriptionApprovals = subscriptions.map((subscription) => ({
      id: subscription.id,
      type: "Subscription",
      name: subscription.requestedBy?.user?.name ?? "Unknown",
      requestedAt: subscription.requestedAt,
    }));

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

    // Activities are empty for now (as in original)
    const activities: any[] = [];

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
