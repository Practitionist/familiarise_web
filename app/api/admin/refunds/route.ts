import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, RefundStatus, PaymentGateway } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    // Parse query parameters
    const searchParams = req.nextUrl.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const status = searchParams.get("status") as RefundStatus | null;
    const gateway = searchParams.get("gateway") as PaymentGateway | null;
    const search = searchParams.get("search");

    // Build where clause
    const where: Prisma.RefundWhereInput = {};

    if (status) {
      where.status = status;
    }

    if (gateway) {
      where.paymentGateway = gateway;
    }

    if (search) {
      where.refundId = {
        contains: search,
        mode: "insensitive",
      };
    }

    // Fetch refunds with pagination
    const [refunds, total] = await Promise.all([
      prisma.refund.findMany({
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
      prisma.refund.count({ where }),
    ]);

    return NextResponse.json({
      refunds,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Admin refunds list error:", error);
    return NextResponse.json(
      { error: "Failed to fetch refunds" },
      { status: 500 },
    );
  }
}
