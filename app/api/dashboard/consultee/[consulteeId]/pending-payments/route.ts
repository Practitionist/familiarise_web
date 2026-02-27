import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { RequestStatus } from "@prisma/client";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

/**
 * GET /api/dashboard/consultee/[consulteeId]/pending-payments
 * Fetch all consultations and subscriptions that are APPROVED_PENDING_PAYMENT for this consultee
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

    // Fetch consultee profile to get their ID
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { id: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    // Fetch consultations with APPROVED_PENDING_PAYMENT status
    const pendingConsultations = await prisma.consultation.findMany({
      where: {
        requestedById: consulteeId,
        requestStatus: RequestStatus.APPROVED_PENDING_PAYMENT,
      },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
        appointment: {
          include: {
            payment: {
              where: {
                paymentStatus: {
                  in: ["PENDING"],
                },
              },
              orderBy: {
                createdAt: "desc",
              },
              take: 1,
            },
          },
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    // Fetch subscriptions with APPROVED_PENDING_PAYMENT status
    const pendingSubscriptions = await prisma.subscription.findMany({
      where: {
        requestedById: consulteeId,
        requestStatus: RequestStatus.APPROVED_PENDING_PAYMENT,
      },
      include: {
        subscriptionPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
        appointments: {
          include: {
            payment: {
              where: {
                paymentStatus: {
                  in: ["PENDING"],
                },
              },
              orderBy: {
                createdAt: "desc",
              },
              take: 1,
            },
          },
          take: 1,
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    // Transform data into a consistent format
    const pendingPayments = [
      ...pendingConsultations.map((consultation) => {
        const payment = consultation.appointment?.payment?.[0];
        const expiresAt = new Date(
          consultation.updatedAt.getTime() + 48 * 60 * 60 * 1000,
        ); // 48 hours from approval
        const isExpiringSoon =
          expiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1000; // < 24 hours

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
        };
      }),
      ...pendingSubscriptions.map((subscription) => {
        const payment = subscription.appointments?.[0]?.payment?.[0];
        const expiresAt = new Date(
          subscription.updatedAt.getTime() + 48 * 60 * 60 * 1000,
        ); // 48 hours from approval
        const isExpiringSoon =
          expiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1000; // < 24 hours

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
        };
      }),
    ].sort((a, b) => {
      // Sort by expiring soon first, then by approval date (newest first)
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
