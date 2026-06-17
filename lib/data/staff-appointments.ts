/**
 * Shared read for the staff appointments table. #890
 *
 * Single entry point behind GET /api/staff/appointments AND the staff
 * appointments server page's SSR prefetch, so the SSR-hydrated cache and the
 * client useQuery (queryKey ["staff-appointments", filters]) resolve identical
 * payloads — both paths funnel through here and can't drift. Auth stays at the
 * call site: the route runs requirePrivilegedAuth(); the prefetch runs under
 * the dashboard layout's gate.
 *
 * The query + display formatting moved here verbatim from the route. The ONLY
 * shape change vs. the old route is Date→ISO string on the per-row
 * scheduledAt / endsAt / createdAt fields, which is exactly what the route's
 * NextResponse.json did on the wire — so the payload is byte-identical, it's
 * just now also safe to dehydrate into the React Query cache.
 */

import prisma from "@/lib/prisma";
import { AppointmentsType, Prisma } from "@prisma/client";
import { toPlain } from "@/lib/data/serialize";

type Participant = {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
} | null;

type AppointmentPayment = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  gateway: string;
} | null;

export type StaffAppointment = {
  id: string;
  type: string;
  title: string;
  consultant: Participant;
  consultee: Participant;
  scheduledAt: string;
  endsAt?: string;
  duration: number;
  status: string;
  hasIssue: boolean;
  issueType: string | null;
  payment: AppointmentPayment;
  createdAt: string;
};

export type StaffAppointmentsPayload = {
  appointments: StaffAppointment[];
  counts: {
    all: number;
    issues: number;
    scheduled: number;
    completed: number;
  };
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
};

export type StaffAppointmentsParams = {
  type?: string | null;
  status?: string | null;
  search?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  orgId?: string | null;
  page?: number;
  limit?: number;
};

/**
 * Fetch the staff appointments table as a JSON-safe payload.
 *
 * Single source of truth for both the route and the prefetch — the returned
 * object is the exact shape the client useQuery(["staff-appointments", ...])
 * caches. Date fields are pre-serialized to ISO strings here so the
 * SSR-dehydrated cache matches the client fetch verbatim.
 */
export async function getStaffAppointments(
  params: StaffAppointmentsParams = {},
): Promise<StaffAppointmentsPayload> {
  const type = (params.type as AppointmentsType | null) ?? null;
  const status = params.status ?? null;
  const search = params.search ?? null;
  const dateFrom = params.dateFrom ?? null;
  const dateTo = params.dateTo ?? null;
  // #674 comment 7 — optional org-scope filter for support staff drilling into
  // a single tenant's appointments. Uses Appointment.organizationId.
  const orgId = params.orgId ?? null;
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const offset = (page - 1) * limit;

  // Build where clause
  const where: Prisma.AppointmentWhereInput = {};

  if (type && Object.values(AppointmentsType).includes(type)) {
    where.appointmentType = type;
  }

  if (orgId) {
    where.organizationId = orgId;
  }

  // Filter by date at the database level using slotsOfAppointment
  if (dateFrom || dateTo) {
    where.slotsOfAppointment = {
      some: {
        ...(dateFrom && { startsAt: { gte: new Date(dateFrom) } }),
        ...(dateTo && { startsAt: { lte: new Date(dateTo) } }),
      },
    };
  }

  // Handle search across multiple fields
  if (search) {
    where.OR = [
      { id: { contains: search, mode: "insensitive" } },
      // Consultation search
      {
        consultation: {
          consultationPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
      {
        consultation: {
          consultationPlan: {
            consultantProfile: {
              user: {
                OR: [
                  { name: { contains: search, mode: "insensitive" } },
                  { email: { contains: search, mode: "insensitive" } },
                ],
              },
            },
          },
        },
      },
      {
        consultation: {
          requestedBy: {
            user: {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
              ],
            },
          },
        },
      },
      // Subscription search
      {
        subscription: {
          subscriptionPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
      // Webinar search
      {
        webinar: {
          webinarPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
      // Class search
      {
        class: {
          classPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
    ];
  }

  // Get appointments with related data
  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where,
      include: {
        slotsOfAppointment: {
          orderBy: { startsAt: "asc" },
          take: 1,
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            isTentative: true,
          },
        },
        consultation: {
          select: {
            id: true,
            status: true,
            consultationPlan: {
              select: {
                id: true,
                title: true,
                price: true,
                priceCurrency: true,
                durationInHours: true,
                consultantProfile: {
                  select: {
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
        subscription: {
          select: {
            id: true,
            status: true,
            subscriptionPlan: {
              select: {
                id: true,
                title: true,
                price: true,
                priceCurrency: true,
                consultantProfile: {
                  select: {
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
        webinar: {
          select: {
            id: true,
            status: true,
            webinarPlan: {
              select: {
                id: true,
                title: true,
                price: true,
                priceCurrency: true,
                maxParticipants: true,
                consultantProfile: {
                  select: {
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
            _count: {
              select: { waitlist: true },
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
                price: true,
                priceCurrency: true,
                maxParticipants: true,
                consultantProfile: {
                  select: {
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
            _count: {
              select: { waitlist: true },
            },
          },
        },
        payment: {
          select: {
            id: true,
            amount: true,
            currency: true,
            paymentStatus: true,
            paymentGateway: true,
            createdAt: true,
          },
          take: 1,
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.appointment.count({ where }),
  ]);

  // Format appointments for frontend
  const formattedAppointments = appointments.map((apt) => {
    // Get consultant and consultee info based on type
    let consultant = null;
    let consultee = null;
    let title = "";
    let aptStatus = null;
    let duration = 0;

    switch (apt.appointmentType) {
      case "CONSULTATION":
        if (apt.consultation) {
          consultant =
            apt.consultation.consultationPlan.consultantProfile.user;
          consultee = apt.consultation.requestedBy.user;
          title = apt.consultation.consultationPlan.title;
          aptStatus = apt.consultation.status;
          duration = apt.consultation.consultationPlan.durationInHours * 60;
        }
        break;
      case "SUBSCRIPTION":
        if (apt.subscription) {
          consultant =
            apt.subscription.subscriptionPlan.consultantProfile.user;
          consultee = apt.subscription.requestedBy.user;
          title = apt.subscription.subscriptionPlan.title;
          aptStatus = apt.subscription.status;
        }
        break;
      case "WEBINAR":
        if (apt.webinar) {
          consultant = apt.webinar.webinarPlan.consultantProfile?.user || null;
          consultee = {
            id: "",
            name: `${apt.webinar._count.waitlist} attendees`,
            email: "",
            image: null,
          };
          title = apt.webinar.webinarPlan.title;
          aptStatus = apt.webinar.status;
        }
        break;
      case "CLASS":
        if (apt.class) {
          consultant = apt.class.classPlan.consultantProfile?.user || null;
          consultee = {
            id: "",
            name: `${apt.class._count.waitlist} students`,
            email: "",
            image: null,
          };
          title = apt.class.classPlan.title;
          aptStatus = apt.class.status;
        }
        break;
    }

    const slot = apt.slotsOfAppointment[0];
    const payment = apt.payment[0];

    // Determine status for display
    let displayStatus = "scheduled";
    if (aptStatus) {
      const statusStr = String(aptStatus).toLowerCase();
      if (statusStr === "cancelled") displayStatus = "cancelled";
      else if (statusStr === "completed") displayStatus = "completed";
      else if (statusStr === "in_progress") displayStatus = "in_progress";
      else if (statusStr === "scheduled") displayStatus = "scheduled";
      else displayStatus = statusStr;
    }

    // Check if there's an issue (cancelled, no payment, etc.)
    const hasIssue =
      displayStatus === "cancelled" || (!payment && aptStatus !== "PENDING");

    // Date→ISO so the payload is JSON-safe verbatim (matches NextResponse.json)
    const scheduledAtDate = slot?.startsAt || apt.createdAt;

    return {
      id: apt.id,
      type: apt.appointmentType.toLowerCase(),
      title,
      consultant: consultant
        ? {
            id: consultant.id,
            name: consultant.name,
            email: consultant.email,
            avatar: consultant.image,
          }
        : null,
      consultee: consultee
        ? {
            id: (consultee as { id?: string }).id || "",
            name: (consultee as { name?: string | null }).name ?? null,
            email: (consultee as { email?: string | null }).email ?? null,
            avatar: (consultee as { image?: string | null }).image ?? null,
          }
        : null,
      scheduledAt: scheduledAtDate.toISOString(),
      endsAt: slot?.endsAt ? slot.endsAt.toISOString() : undefined,
      duration,
      status: displayStatus,
      hasIssue,
      issueType: hasIssue
        ? displayStatus === "cancelled"
          ? "Cancelled"
          : "Payment pending"
        : null,
      payment: payment
        ? {
            id: payment.id,
            amount: payment.amount,
            currency: payment.currency,
            status: payment.paymentStatus,
            gateway: payment.paymentGateway,
          }
        : null,
      createdAt: apt.createdAt.toISOString(),
    };
  });

  // Filter by status if provided (after formatting since status is derived)
  let filteredAppointments = formattedAppointments;
  if (status && status !== "all") {
    if (status === "issue") {
      filteredAppointments = formattedAppointments.filter((apt) => apt.hasIssue);
    } else {
      filteredAppointments = formattedAppointments.filter(
        (apt) => apt.status === status,
      );
    }
  }

  // Get counts for stats
  const counts = {
    all: total,
    issues: formattedAppointments.filter((a) => a.hasIssue).length,
    scheduled: formattedAppointments.filter((a) => a.status === "scheduled")
      .length,
    completed: formattedAppointments.filter((a) => a.status === "completed")
      .length,
  };

  // toPlain — payment rows carry the #780/#781 money result extension's inspect
  // symbol, so the payload must be plainified before crossing the RSC→Client
  // HydrationBoundary.
  return toPlain({
    appointments: filteredAppointments,
    counts,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: offset + limit < total,
    },
  });
}
