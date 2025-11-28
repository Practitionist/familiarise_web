import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "../../auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole, DisputeStatus, PaymentGateway } from "@prisma/client";

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
    const status = searchParams.get("status") as DisputeStatus | null;
    const gateway = searchParams.get("gateway") as PaymentGateway | null;
    const search = searchParams.get("search");

    // Build where clause
    const where: any = {};

    if (status) {
      where.status = status;
    }

    if (gateway) {
      where.paymentGateway = gateway;
    }

    if (search) {
      where.disputeId = {
        contains: search,
        mode: "insensitive",
      };
    }

    // Fetch disputes with pagination
    const [disputes, total, urgentDisputes] = await Promise.all([
      prisma.dispute.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          payment: {
            select: {
              id: true,
              paymentIntent: true,
            },
          },
        },
      }),
      prisma.dispute.count({ where }),
      // Count urgent disputes (due within 3 days)
      prisma.dispute.count({
        where: {
          dueBy: {
            lte: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
            gte: new Date(),
          },
          status: {
            in: ["WARNING_NEEDS_RESPONSE", "NEEDS_RESPONSE", "UNDER_REVIEW"],
          },
        },
      }),
    ]);

    return NextResponse.json({
      disputes,
      total,
      urgentDisputes,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Admin disputes list error:", error);
    return NextResponse.json(
      { error: "Failed to fetch disputes" },
      { status: 500 },
    );
  }
}
