import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";

export const runtime = "nodejs";

/**
 * Observability Endpoint: Real-time Booking Statistics
 * 
 * Provides a high-level overview of the booking subsystem health:
 * - Active vs Expired sessions
 * - Conflict rates
 * - Revenue throughput
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true }
    });

    if (user?.role !== "ADMIN" && user?.role !== "STAFF") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const [
      totalAppointments,
      pendingConsultations,
      activeSubscriptions,
      successfulPayments,
      totalRevenue
    ] = await Promise.all([
      prisma.appointment.count(),
      prisma.consultation.count({ where: { requestStatus: "PENDING" } }),
      prisma.subscription.count({ where: { requestStatus: "APPROVED" } }),
      prisma.payment.count({ where: { paymentStatus: "SUCCEEDED" } }),
      prisma.payment.aggregate({
        where: { paymentStatus: "SUCCEEDED" },
        _sum: { amount: true }
      })
    ]);

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      metrics: {
        appointments: { total: totalAppointments },
        consultations: { pending: pendingConsultations },
        subscriptions: { active: activeSubscriptions },
        financial: {
          successful_payments: successfulPayments,
          gross_revenue_paise: totalRevenue._sum.amount || 0
        }
      }
    });

  } catch (error) {
    console.error("[OBSERVABILITY] Failed to fetch stats:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
