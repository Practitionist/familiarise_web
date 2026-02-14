import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  try {
    const { consulteeId } = await params;

    if (!consulteeId) {
      return NextResponse.json(
        { error: "Consultee ID is required" },
        { status: 400 },
      );
    }

    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { userId: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const userId = consulteeProfile.userId;

    const [payments, invoices, credits, creditUsages] = await Promise.all([
      // All payments for this user
      prisma.payment.findMany({
        where: { userId },
        include: {
          appointment: {
            select: {
              appointmentType: true,
              consultation: {
                select: {
                  consultationPlan: { select: { title: true } },
                },
              },
              subscription: {
                select: {
                  subscriptionPlan: { select: { title: true } },
                },
              },
              webinar: {
                select: {
                  webinarPlan: { select: { title: true } },
                },
              },
              class: {
                select: {
                  classPlan: { select: { title: true } },
                },
              },
            },
          },
          discountCode: {
            select: {
              code: true,
              discountType: true,
              discountValue: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),

      // Invoices for this user's payments
      prisma.invoice.findMany({
        where: {
          payment: { userId },
        },
        include: {
          payment: {
            select: {
              id: true,
              amount: true,
              currency: true,
              paymentStatus: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),

      // Referral credits
      prisma.referralCredit.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),

      // Credit usages
      prisma.referralCreditUsage.findMany({
        where: { credit: { userId } },
        include: {
          credit: { select: { source: true } },
          payment: {
            select: {
              id: true,
              amount: true,
              currency: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // Transform payments to include plan title
    const transformedPayments = payments.map((p) => {
      let planTitle = "Payment";
      const apt = p.appointment;
      if (apt) {
        if (apt.consultation?.consultationPlan?.title) {
          planTitle = apt.consultation.consultationPlan.title;
        } else if (apt.subscription?.subscriptionPlan?.title) {
          planTitle = apt.subscription.subscriptionPlan.title;
        } else if (apt.webinar?.webinarPlan?.title) {
          planTitle = apt.webinar.webinarPlan.title;
        } else if (apt.class?.classPlan?.title) {
          planTitle = apt.class.classPlan.title;
        }
      }

      return {
        id: p.id,
        amount: p.amount,
        originalAmount: p.originalAmount,
        taxAmount: p.taxAmount,
        currency: p.currency,
        status: p.paymentStatus,
        paymentMethod: p.paymentMethod,
        paymentGateway: p.paymentGateway,
        appointmentType: apt?.appointmentType || null,
        planTitle,
        discount: p.discountCode
          ? {
              code: p.discountCode.code,
              type: p.discountCode.discountType,
              value: p.discountCode.discountValue,
            }
          : null,
        receiptUrl: p.receiptUrl,
        createdAt: p.createdAt,
      };
    });

    // Calculate credit summary
    const totalCredits = credits.reduce((sum, c) => sum + c.amount, 0);
    const usedCredits = credits.reduce((sum, c) => sum + c.usedAmount, 0);
    const remainingCredits = credits.reduce(
      (sum, c) => sum + c.remainingAmount,
      0,
    );

    return NextResponse.json({
      data: {
        payments: transformedPayments,
        invoices,
        credits,
        creditUsages,
        creditSummary: {
          total: totalCredits,
          used: usedCredits,
          remaining: remainingCredits,
        },
      },
      success: true,
    });
  } catch (error) {
    console.error("Error fetching consultee payments:", error);
    return NextResponse.json(
      { error: "Failed to fetch payments" },
      { status: 500 },
    );
  }
}
