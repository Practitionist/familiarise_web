import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "../../../../auth/[...nextauth]/options";

/**
 * Check if a consultant can switch their schedule type.
 * Returns canSwitch: false if there are active/pending appointments.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: consultantId } = await params;

    // Verify the consultant exists
    const consultant = await prisma.consultantProfile.findUnique({
      where: { id: consultantId },
      select: { id: true, userId: true, scheduleType: true },
    });

    if (!consultant) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 },
      );
    }

    // Check for pending/active consultations
    const pendingConsultations = await prisma.consultation.count({
      where: {
        consultationPlan: { consultantProfileId: consultantId },
        requestStatus: {
          in: [
            "PENDING",
            "APPROVED",
            "APPROVED_PENDING_PAYMENT",
            "SCHEDULED",
          ],
        },
      },
    });

    // Check for pending/active subscriptions
    const activeSubscriptions = await prisma.subscription.count({
      where: {
        subscriptionPlan: { consultantProfileId: consultantId },
        requestStatus: {
          in: [
            "PENDING",
            "APPROVED",
            "APPROVED_PENDING_PAYMENT",
            "SCHEDULED",
          ],
        },
      },
    });

    // Check for upcoming webinars (scheduled or in progress with future slots)
    const upcomingWebinars = await prisma.webinar.count({
      where: {
        webinarPlan: { consultantProfileId: consultantId },
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
        appointment: {
          slotsOfAppointment: {
            some: { startsAt: { gte: new Date() } },
          },
        },
      },
    });

    // Check for upcoming classes (scheduled or in progress)
    const upcomingClasses = await prisma.class.count({
      where: {
        classPlan: { consultantProfileId: consultantId },
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
      },
    });

    const totalPending =
      pendingConsultations +
      activeSubscriptions +
      upcomingWebinars +
      upcomingClasses;

    if (totalPending > 0) {
      // Build a detailed breakdown for the UI
      const details: string[] = [];
      if (pendingConsultations > 0) {
        details.push(
          `${pendingConsultations} pending consultation${pendingConsultations > 1 ? "s" : ""}`,
        );
      }
      if (activeSubscriptions > 0) {
        details.push(
          `${activeSubscriptions} active subscription${activeSubscriptions > 1 ? "s" : ""}`,
        );
      }
      if (upcomingWebinars > 0) {
        details.push(
          `${upcomingWebinars} upcoming webinar${upcomingWebinars > 1 ? "s" : ""}`,
        );
      }
      if (upcomingClasses > 0) {
        details.push(
          `${upcomingClasses} upcoming class${upcomingClasses > 1 ? "es" : ""}`,
        );
      }

      return NextResponse.json({
        canSwitch: false,
        reason: `Cannot switch schedule type while you have active appointments`,
        details: details.join(", "),
        breakdown: {
          pendingConsultations,
          activeSubscriptions,
          upcomingWebinars,
          upcomingClasses,
          total: totalPending,
        },
      });
    }

    return NextResponse.json({
      canSwitch: true,
      currentScheduleType: consultant.scheduleType,
    });
  } catch (error) {
    console.error("Error checking schedule switch eligibility:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
