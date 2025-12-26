/**
 * Admin Subscriptions API
 * View and manage platform subscriptions
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

/**
 * GET /api/admin/subscriptions
 * Get all subscriptions with optional filters
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
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
    const status = searchParams.get("status"); // active, expired, cancelled
    const search = searchParams.get("search");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");

    const now = new Date();

    // Build where clause based on status
    let where: any = {
      appointment: {
        appointmentType: "SUBSCRIPTION",
      },
    };

    if (search) {
      where.OR = [
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

    // Get subscription payments
    const [subscriptions, total] = await Promise.all([
      prisma.payment.findMany({
        where: {
          ...where,
          paymentStatus: "SUCCEEDED",
        },
        include: {
          user: {
            select: { name: true, email: true },
          },
          appointment: {
            include: {
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
          paymentStatus: "SUCCEEDED",
        },
      }),
    ]);

    // Format subscriptions with status
    const formattedSubscriptions = subscriptions.map((s) => {
      const subscription = s.appointment?.subscription;
      const endDate = subscription?.schedulingPeriodEndsAt;
      const isActive = endDate && new Date(endDate) > now;
      const isExpiringSoon =
        endDate &&
        new Date(endDate) > now &&
        new Date(endDate) < new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      return {
        id: s.id,
        paymentId: s.id,
        amount: s.amount,
        currency: s.currency,
        gateway: s.paymentGateway,
        userName: s.user?.name || "Unknown",
        userEmail: s.user?.email || "",
        consultantName: subscription?.subscriptionPlan?.consultantProfile?.user?.name,
        startDate: subscription?.schedulingPeriodStartsAt,
        endDate: subscription?.schedulingPeriodEndsAt,
        subscriptionStatus: subscription?.requestStatus,
        status: isActive ? (isExpiringSoon ? "expiring_soon" : "active") : "expired",
        createdAt: s.createdAt,
      };
    });

    // Filter by status if provided
    let filteredSubscriptions = formattedSubscriptions;
    if (status === "active") {
      filteredSubscriptions = formattedSubscriptions.filter(
        (s) => s.status === "active" || s.status === "expiring_soon"
      );
    } else if (status === "expired") {
      filteredSubscriptions = formattedSubscriptions.filter(
        (s) => s.status === "expired"
      );
    } else if (status === "expiring_soon") {
      filteredSubscriptions = formattedSubscriptions.filter(
        (s) => s.status === "expiring_soon"
      );
    }

    return NextResponse.json({
      subscriptions: filteredSubscriptions,
      pagination: {
        total: status ? filteredSubscriptions.length : total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    console.error("Error fetching subscriptions:", error);
    return NextResponse.json(
      { error: "Failed to fetch subscriptions" },
      { status: 500 }
    );
  }
}
