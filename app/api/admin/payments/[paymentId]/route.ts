import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
interface RouteParams {
  params: Promise<{
    paymentId: string;
  }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession();
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

    const resolvedParams = await params;

    // Fetch payment details
    const payment = await prisma.payment.findUnique({
      where: { id: resolvedParams.paymentId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        appointment: {
          select: {
            id: true,
            appointmentType: true,
          },
        },
        discountCode: {
          select: {
            code: true,
            discountType: true,
            discountValue: true,
          },
        },
        refunds: {
          orderBy: { createdAt: "desc" },
        },
        disputes: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    return NextResponse.json(payment);
  } catch (error) {
    console.error("Admin payment details error:", error);
    return NextResponse.json(
      { error: "Failed to fetch payment details" },
      { status: 500 },
    );
  }
}
