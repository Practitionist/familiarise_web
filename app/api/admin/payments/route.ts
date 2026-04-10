import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import {
  Prisma,
  PaymentStatus,
  PaymentGateway,
  AppointmentsType,
} from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    // Parse query parameters
    const searchParams = req.nextUrl.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const status = searchParams.get("status") as PaymentStatus | null;
    const gateway = searchParams.get("gateway") as PaymentGateway | null;
    const appointmentType = searchParams.get(
      "appointmentType",
    ) as AppointmentsType | null;
    const search = searchParams.get("search");

    // Build where clause
    const where: Prisma.PaymentWhereInput = {};

    if (status) {
      where.paymentStatus = status;
    }

    if (gateway) {
      where.paymentGateway = gateway;
    }

    if (search) {
      where.paymentIntent = {
        contains: search,
        mode: "insensitive",
      };
    }

    if (appointmentType) {
      where.appointment = {
        appointmentType,
      };
    }

    // Fetch payments with pagination
    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          appointment: {
            select: {
              appointmentType: true,
            },
          },
        },
      }),
      prisma.payment.count({ where }),
    ]);

    return NextResponse.json({
      payments,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Admin payments list error:", error);
    return NextResponse.json(
      { error: "Failed to fetch payments" },
      { status: 500 },
    );
  }
}
