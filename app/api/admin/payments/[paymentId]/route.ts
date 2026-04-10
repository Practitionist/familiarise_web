import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";

interface RouteParams {
  params: Promise<{
    paymentId: string;
  }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

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
