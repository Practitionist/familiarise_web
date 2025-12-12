import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "../../auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import {
  UserRole,
  PaymentStatus,
  PaymentGateway,
  AppointmentsType,
} from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is admin
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
    const where: any = {};

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
