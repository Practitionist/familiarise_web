import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { consulteeId } = await params;

    if (
      !isPrivileged(session.user.role) &&
      session.user.consulteeProfileId !== consulteeId
    ) {
      return forbiddenResponse("You can only access your own payment history");
    }

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
      const apt = p.appointment;
      const planTitle =
        apt?.consultation?.consultationPlan?.title ??
        apt?.subscription?.subscriptionPlan?.title ??
        apt?.webinar?.webinarPlan?.title ??
        apt?.class?.classPlan?.title ??
        "Payment";

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
        expiresAt: p.expiresAt,
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
