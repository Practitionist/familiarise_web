/**
 * Staff Appointments API
 * Staff/Admin access to all appointments with filtering and pagination
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentsType, Prisma } from "@prisma/client";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type") as AppointmentsType | null;
    const status = searchParams.get("status");
    const search = searchParams.get("search");
    const dateFrom = searchParams.get("dateFrom");
    const dateTo = searchParams.get("dateTo");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = (page - 1) * limit;

    // Build where clause
    const where: Prisma.AppointmentWhereInput = {};

    if (type && Object.values(AppointmentsType).includes(type)) {
      where.appointmentType = type;
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
              requestStatus: true,
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
              requestStatus: true,
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
      let requestStatus = null;
      let duration = 0;

      switch (apt.appointmentType) {
        case "CONSULTATION":
          if (apt.consultation) {
            consultant =
              apt.consultation.consultationPlan.consultantProfile.user;
            consultee = apt.consultation.requestedBy.user;
            title = apt.consultation.consultationPlan.title;
            requestStatus = apt.consultation.requestStatus;
            duration = apt.consultation.consultationPlan.durationInHours * 60;
          }
          break;
        case "SUBSCRIPTION":
          if (apt.subscription) {
            consultant =
              apt.subscription.subscriptionPlan.consultantProfile.user;
            consultee = apt.subscription.requestedBy.user;
            title = apt.subscription.subscriptionPlan.title;
            requestStatus = apt.subscription.requestStatus;
          }
          break;
        case "WEBINAR":
          if (apt.webinar) {
            consultant =
              apt.webinar.webinarPlan.consultantProfile?.user || null;
            consultee = {
              name: `${apt.webinar._count.waitlist} attendees`,
              email: "",
              image: null,
            };
            title = apt.webinar.webinarPlan.title;
            requestStatus = apt.webinar.status;
          }
          break;
        case "CLASS":
          if (apt.class) {
            consultant = apt.class.classPlan.consultantProfile?.user || null;
            consultee = {
              name: `${apt.class._count.waitlist} students`,
              email: "",
              image: null,
            };
            title = apt.class.classPlan.title;
            requestStatus = apt.class.status;
          }
          break;
      }

      const slot = apt.slotsOfAppointment[0];
      const payment = apt.payment[0];

      // Determine status for display
      let displayStatus = "scheduled";
      if (requestStatus) {
        const statusStr = String(requestStatus).toLowerCase();
        if (statusStr === "cancelled") displayStatus = "cancelled";
        else if (statusStr === "completed") displayStatus = "completed";
        else if (statusStr === "in_progress") displayStatus = "in_progress";
        else if (statusStr === "scheduled") displayStatus = "scheduled";
        else displayStatus = statusStr;
      }

      // Check if there's an issue (cancelled, no payment, etc.)
      const hasIssue =
        displayStatus === "cancelled" ||
        (!payment && requestStatus !== "PENDING");

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
              name: (consultee as { name?: string | null }).name,
              email: (consultee as { email?: string | null }).email,
              avatar: (consultee as { image?: string | null }).image,
            }
          : null,
        scheduledAt: slot?.startsAt || apt.createdAt,
        endsAt: slot?.endsAt,
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
        createdAt: apt.createdAt,
      };
    });

    // Filter by status if provided (after formatting since status is derived)
    let filteredAppointments = formattedAppointments;
    if (status && status !== "all") {
      if (status === "issue") {
        filteredAppointments = formattedAppointments.filter(
          (apt) => apt.hasIssue,
        );
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

    return NextResponse.json({
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
  } catch (error) {
    console.error("Error fetching appointments:", error);
    return NextResponse.json(
      { error: "Failed to fetch appointments" },
      { status: 500 },
    );
  }
}
