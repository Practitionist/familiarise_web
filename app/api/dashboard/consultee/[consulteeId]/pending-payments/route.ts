import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentStatus } from "@prisma/client";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

/**
 * GET /api/dashboard/consultee/[consulteeId]/pending-payments
 * Fetch pending payments for this consultee from two sources:
 * 1. Consultations/subscriptions with APPROVED_PENDING_PAYMENT status (awaiting checkout)
 * 2. Payment records with paymentStatus PENDING (checkout initiated, awaiting gateway confirmation)
 */
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
      return forbiddenResponse("You can only access your own pending payments");
    }

    // Fetch consultee profile to get their userId
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { id: true, userId: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const planInclude = {
      select: {
        title: true,
        consultantProfile: {
          select: {
            user: { select: { name: true } },
          },
        },
      },
    } as const;

    // Fetch all three data sources in parallel
    const [pendingConsultations, pendingSubscriptions, pendingGatewayPayments] =
      await Promise.all([
        // Source 1: Consultations with APPROVED_PENDING_PAYMENT status
        prisma.consultation.findMany({
          where: {
            requestedById: consulteeId,
            status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
          },
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: { select: { name: true } },
                  },
                },
              },
            },
          },
          orderBy: { updatedAt: "desc" },
        }),

        // Source 2: Subscriptions with APPROVED_PENDING_PAYMENT status
        prisma.subscription.findMany({
          where: {
            requestedById: consulteeId,
            status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
          },
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: { select: { name: true } },
                  },
                },
              },
            },
          },
          orderBy: { updatedAt: "desc" },
        }),

        // Source 3: Payment records with PENDING gateway status (non-expired only)
        prisma.payment.findMany({
          where: {
            userId: consulteeProfile.userId,
            paymentStatus: "PENDING",
            OR: [
              // Has explicit expiresAt that's still in the future
              { expiresAt: { gt: new Date() } },
              // No expiresAt but created within last 30 min (default checkout window)
              {
                expiresAt: null,
                createdAt: { gt: new Date(Date.now() - 30 * 60 * 1000) },
              },
            ],
          },
          include: {
            appointment: {
              select: {
                appointmentType: true,
                consultation: {
                  select: { consultationPlan: planInclude },
                },
                subscription: {
                  select: { subscriptionPlan: planInclude },
                },
                webinar: {
                  select: { webinarPlan: planInclude },
                },
                class: {
                  select: { classPlan: planInclude },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        }),
      ]);

    // Transform approval-pending consultations
    const approvalPendingItems = [
      ...pendingConsultations.map((consultation) => {
        const expiresAt = new Date(
          consultation.updatedAt.getTime() + 48 * 60 * 60 * 1000,
        ); // 48 hours from approval
        const isExpiringSoon =
          expiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1000;

        return {
          id: consultation.id,
          type: "consultation" as const,
          title: consultation.consultationPlan?.title || "Consultation",
          consultantName:
            consultation.consultationPlan?.consultantProfile?.user?.name ||
            "Consultant",
          amount: consultation.consultationPlan?.price || 0,
          currency: consultation.consultationPlan?.priceCurrency || "INR",
          paymentUrl: consultation.pendingPaymentUrl || "",
          approvedAt: consultation.updatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          isExpiringSoon,
          source: "approval_pending" as const,
        };
      }),
      ...pendingSubscriptions.map((subscription) => {
        const expiresAt = new Date(
          subscription.updatedAt.getTime() + 48 * 60 * 60 * 1000,
        );
        const isExpiringSoon =
          expiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1000;

        return {
          id: subscription.id,
          type: "subscription" as const,
          title: subscription.subscriptionPlan?.title || "Subscription",
          consultantName:
            subscription.subscriptionPlan?.consultantProfile?.user?.name ||
            "Consultant",
          amount: subscription.subscriptionPlan?.price || 0,
          currency: subscription.subscriptionPlan?.priceCurrency || "INR",
          paymentUrl: subscription.pendingPaymentUrl || "",
          approvedAt: subscription.updatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          isExpiringSoon,
          source: "approval_pending" as const,
        };
      }),
    ];

    // Transform gateway-pending payments
    const gatewayPendingItems = pendingGatewayPayments.map((payment) => {
      const apt = payment.appointment;
      const planTitle =
        apt?.consultation?.consultationPlan?.title ??
        apt?.subscription?.subscriptionPlan?.title ??
        apt?.webinar?.webinarPlan?.title ??
        apt?.class?.classPlan?.title ??
        "Payment";
      const consultantName =
        apt?.consultation?.consultationPlan?.consultantProfile?.user?.name ??
        apt?.subscription?.subscriptionPlan?.consultantProfile?.user?.name ??
        apt?.webinar?.webinarPlan?.consultantProfile?.user?.name ??
        apt?.class?.classPlan?.consultantProfile?.user?.name ??
        "Consultant";
      const type =
        (apt?.appointmentType?.toLowerCase() as
          | "consultation"
          | "subscription"
          | "webinar"
          | "class") || "consultation";

      // Gateway-pending payments expire based on expiresAt or default to 30 min from creation
      const expiresAt =
        payment.expiresAt ||
        new Date(payment.createdAt.getTime() + 30 * 60 * 1000);
      const isExpiringSoon = expiresAt.getTime() - Date.now() < 10 * 60 * 1000; // < 10 min

      return {
        id: payment.id,
        type,
        title: planTitle,
        consultantName,
        amount: payment.amount,
        currency: payment.currency,
        paymentUrl: "",
        approvedAt: payment.createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        isExpiringSoon,
        source: "gateway_pending" as const,
      };
    });

    // Merge and sort: expiring soon first, then by date (newest first)
    const pendingPayments = [
      ...approvalPendingItems,
      ...gatewayPendingItems,
    ].sort((a, b) => {
      if (a.isExpiringSoon && !b.isExpiringSoon) return -1;
      if (!a.isExpiringSoon && b.isExpiringSoon) return 1;
      return (
        new Date(b.approvedAt).getTime() - new Date(a.approvedAt).getTime()
      );
    });

    return NextResponse.json({
      pendingPayments,
      count: pendingPayments.length,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "dashboard" } });
    console.error("Error fetching pending payments:", error);
    return NextResponse.json(
      {
        error: "An error occurred while fetching pending payments",
        pendingPayments: [],
        count: 0,
      },
      { status: 500 },
    );
  }
}
