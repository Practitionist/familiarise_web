/**
 * Admin Invoices API
 * View all platform invoices
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { PaymentStatus, Prisma } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
/**
 * GET /api/admin/invoices
 * Get all invoices with optional filters
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check admin role
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") as PaymentStatus | null;
    const search = searchParams.get("search");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");

    // Build where clause
    const where: Prisma.PaymentWhereInput = {};
    if (status) {
      where.paymentStatus = status;
    }
    if (search) {
      where.OR = [
        { paymentIntent: { contains: search, mode: "insensitive" } },
        {
          user: {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          },
        },
      ];
    }

    // Get invoices (payments with succeeded status are considered invoices)
    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where: {
          ...where,
          paymentStatus: status || "SUCCEEDED",
        },
        include: {
          user: {
            select: { name: true, email: true },
          },
          appointment: {
            include: {
              consultation: {
                include: {
                  consultationPlan: {
                    include: {
                      consultantProfile: {
                        include: { user: { select: { name: true } } },
                      },
                    },
                  },
                },
              },
              subscription: {
                include: {
                  subscriptionPlan: {
                    include: {
                      consultantProfile: {
                        include: { user: { select: { name: true } } },
                      },
                    },
                  },
                },
              },
              webinar: {
                include: {
                  webinarPlan: {
                    include: {
                      consultantProfile: {
                        include: { user: { select: { name: true } } },
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
                        include: { user: { select: { name: true } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.payment.count({
        where: {
          ...where,
          paymentStatus: status || "SUCCEEDED",
        },
      }),
    ]);

    // Helper to extract consultant name from different appointment types
    const getConsultantName = (
      appointment: (typeof payments)[0]["appointment"],
    ) => {
      if (!appointment) return undefined;
      return (
        appointment.consultation?.consultationPlan?.consultantProfile?.user
          ?.name ||
        appointment.subscription?.subscriptionPlan?.consultantProfile?.user
          ?.name ||
        appointment.webinar?.webinarPlan?.consultantProfile?.user?.name ||
        appointment.class?.classPlan?.consultantProfile?.user?.name
      );
    };

    // Format as invoices
    const invoices = payments.map((p) => ({
      id: p.id,
      invoiceNumber: `INV-${p.id.slice(-8).toUpperCase()}`,
      paymentIntent: p.paymentIntent,
      amount: p.amount,
      currency: p.currency,
      status: p.paymentStatus,
      gateway: p.paymentGateway,
      userName: p.user?.name || "Unknown",
      userEmail: p.user?.email || "",
      appointmentType: p.appointment?.appointmentType,
      consultantName: getConsultantName(p.appointment),
      createdAt: p.createdAt,
    }));

    return NextResponse.json({
      invoices,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    console.error("Error fetching invoices:", error);
    return NextResponse.json(
      { error: "Failed to fetch invoices" },
      { status: 500 },
    );
  }
}
