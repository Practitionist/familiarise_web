import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { RequestStatus } from "@prisma/client";

/**
 * GET /api/dashboard/admin/approval-payments
 * Fetch all consultations and subscriptions that are in APPROVED_PENDING_PAYMENT status
 * This endpoint is used by admins to monitor approval payments and identify expired payment links
 */
export async function GET() {
  try {
    // Fetch consultations with APPROVED_PENDING_PAYMENT status
    const pendingConsultations = await prisma.consultation.findMany({
      where: {
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
                    email: true,
                  },
                },
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: {
              select: {
                name: true,
                email: true,
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
                    email: true,
                  },
                },
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: {
              select: {
                name: true,
                email: true,
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
    const approvalPayments = [
      ...pendingConsultations.map((consultation) => {
        const expiresAt = new Date(
          consultation.updatedAt.getTime() + 48 * 60 * 60 * 1000,
        ); // 48 hours from approval
        const now = Date.now();
        const timeUntilExpiry = expiresAt.getTime() - now;
        const isExpired = timeUntilExpiry < 0;
        const isExpiringSoon =
          !isExpired && timeUntilExpiry < 24 * 60 * 60 * 1000; // < 24 hours

        return {
          id: consultation.id,
          type: "consultation" as const,
          title: consultation.consultationPlan?.title || "Consultation",
          consultantName:
            consultation.consultationPlan?.consultantProfile?.user?.name ||
            "Unknown Consultant",
          consultantEmail:
            consultation.consultationPlan?.consultantProfile?.user?.email || "",
          consulteeName:
            consultation.requestedBy?.user?.name || "Unknown Consultee",
          consulteeEmail: consultation.requestedBy?.user?.email || "",
          amount: consultation.consultationPlan?.price || 0,
          currency: consultation.consultationPlan?.priceCurrency || "INR",
          // Extract payment URL from requestNotes (it's appended there in the approval endpoint)
          paymentUrl: extractPaymentUrl(consultation.requestNotes || ""),
          approvedAt: consultation.updatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          isExpired,
          isExpiringSoon,
          status: consultation.requestStatus,
        };
      }),
      ...pendingSubscriptions.map((subscription) => {
        const expiresAt = new Date(
          subscription.updatedAt.getTime() + 48 * 60 * 60 * 1000,
        ); // 48 hours from approval
        const now = Date.now();
        const timeUntilExpiry = expiresAt.getTime() - now;
        const isExpired = timeUntilExpiry < 0;
        const isExpiringSoon =
          !isExpired && timeUntilExpiry < 24 * 60 * 60 * 1000; // < 24 hours

        return {
          id: subscription.id,
          type: "subscription" as const,
          title: subscription.subscriptionPlan?.title || "Subscription",
          consultantName:
            subscription.subscriptionPlan?.consultantProfile?.user?.name ||
            "Unknown Consultant",
          consultantEmail:
            subscription.subscriptionPlan?.consultantProfile?.user?.email || "",
          consulteeName:
            subscription.requestedBy?.user?.name || "Unknown Consultee",
          consulteeEmail: subscription.requestedBy?.user?.email || "",
          amount: subscription.subscriptionPlan?.price || 0,
          currency: subscription.subscriptionPlan?.priceCurrency || "INR",
          // Extract payment URL from requestNotes (it's appended there in the approval endpoint)
          paymentUrl: extractPaymentUrl(subscription.requestNotes || ""),
          approvedAt: subscription.updatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          isExpired,
          isExpiringSoon,
          status: subscription.requestStatus,
        };
      }),
    ].sort((a, b) => {
      // Sort by: expired first, then expiring soon, then by approval date (newest first)
      if (a.isExpired && !b.isExpired) return -1;
      if (!a.isExpired && b.isExpired) return 1;
      if (a.isExpiringSoon && !b.isExpiringSoon && !a.isExpired && !b.isExpired)
        return -1;
      if (!a.isExpiringSoon && b.isExpiringSoon && !a.isExpired && !b.isExpired)
        return 1;
      return (
        new Date(b.approvedAt).getTime() - new Date(a.approvedAt).getTime()
      );
    });

    return NextResponse.json({
      approvalPayments,
      count: approvalPayments.length,
      expiredCount: approvalPayments.filter((p) => p.isExpired).length,
      expiringSoonCount: approvalPayments.filter(
        (p) => p.isExpiringSoon && !p.isExpired,
      ).length,
      activeCount: approvalPayments.filter(
        (p) => !p.isExpired && !p.isExpiringSoon,
      ).length,
    });
  } catch (error) {
    console.error("Error fetching approval payments:", error);
    return NextResponse.json(
      {
        error: "An error occurred while fetching approval payments",
        approvalPayments: [],
        count: 0,
      },
      { status: 500 },
    );
  }
}

/**
 * Helper function to extract payment URL from requestNotes
 * The URL is appended in the format: "[System] Payment link generated: https://..."
 */
function extractPaymentUrl(requestNotes: string): string {
  const urlMatch = requestNotes.match(
    /Payment link generated: (https:\/\/[^\s\n]+)/,
  );
  return urlMatch?.[1] || "";
}
