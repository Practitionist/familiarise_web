import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";

import { getSession } from "@/lib/auth-server";
export type ConsulteeSearchResult = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  relationshipType: "consultation" | "subscription" | "webinar" | "class";
};

/**
 * Search consultees of the current consultant
 * Returns only users who have an active relationship with the consultant
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    // Verify user is a consultant
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true, consultantProfileId: true },
    });

    if (user?.role !== "CONSULTANT" || !user.consultantProfileId) {
      return NextResponse.json(
        { error: "Only consultants can search consultees" },
        { status: 403 },
      );
    }

    const consultantProfileId = user.consultantProfileId;
    const url = new URL(req.url);
    const searchTerm = url.searchParams.get("term")?.trim().toLowerCase() || "";
    const excludeIds = url.searchParams.get("exclude")?.split(",") || [];

    // Get all consultees from different relationship types
    const results: ConsulteeSearchResult[] = [];
    const seenUserIds = new Set<string>(excludeIds);

    // 1. Get consultees from active consultations
    const consultations = await prisma.consultation.findMany({
      where: {
        consultationPlan: {
          consultantProfileId: consultantProfileId,
        },
        status: {
          in: [
            "APPROVED",
            "APPROVED_PENDING_PAYMENT",
            "SCHEDULED",
            "COMPLETED",
          ],
        },
      },
      include: {
        requestedBy: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
      },
    });

    for (const consultation of consultations) {
      const consulteeUser = consultation.requestedBy?.user;
      if (
        consulteeUser &&
        !seenUserIds.has(consulteeUser.id) &&
        (searchTerm === "" ||
          consulteeUser.name?.toLowerCase().includes(searchTerm) ||
          consulteeUser.email?.toLowerCase().includes(searchTerm))
      ) {
        seenUserIds.add(consulteeUser.id);
        results.push({
          id: consulteeUser.id,
          name: consulteeUser.name,
          email: consulteeUser.email,
          image: consulteeUser.image,
          relationshipType: "consultation",
        });
      }
    }

    // 2. Get consultees from active subscriptions
    const subscriptions = await prisma.subscription.findMany({
      where: {
        subscriptionPlan: {
          consultantProfileId: consultantProfileId,
        },
        status: {
          in: [
            "APPROVED",
            "APPROVED_PENDING_PAYMENT",
            "SCHEDULED",
            "COMPLETED",
          ],
        },
      },
      include: {
        requestedBy: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
      },
    });

    for (const subscription of subscriptions) {
      const consulteeUser = subscription.requestedBy?.user;
      if (
        consulteeUser &&
        !seenUserIds.has(consulteeUser.id) &&
        (searchTerm === "" ||
          consulteeUser.name?.toLowerCase().includes(searchTerm) ||
          consulteeUser.email?.toLowerCase().includes(searchTerm))
      ) {
        seenUserIds.add(consulteeUser.id);
        results.push({
          id: consulteeUser.id,
          name: consulteeUser.name,
          email: consulteeUser.email,
          image: consulteeUser.image,
          relationshipType: "subscription",
        });
      }
    }

    // 3. Get attendees from webinars (only BOOKED/WAITING/NOTIFIED waitlist users)
    const webinars = await prisma.webinar.findMany({
      where: {
        webinarPlan: {
          consultantProfileId: consultantProfileId,
        },
        status: {
          in: ["SCHEDULED", "IN_PROGRESS", "COMPLETED"],
        },
      },
      include: {
        waitlist: {
          where: {
            status: { in: ["BOOKED", "WAITING", "NOTIFIED"] },
          },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
      },
    });

    for (const webinar of webinars) {
      for (const waitlistEntry of webinar.waitlist) {
        const attendeeUser = waitlistEntry.user;
        if (
          attendeeUser &&
          !seenUserIds.has(attendeeUser.id) &&
          (searchTerm === "" ||
            attendeeUser.name?.toLowerCase().includes(searchTerm) ||
            attendeeUser.email?.toLowerCase().includes(searchTerm))
        ) {
          seenUserIds.add(attendeeUser.id);
          results.push({
            id: attendeeUser.id,
            name: attendeeUser.name,
            email: attendeeUser.email,
            image: attendeeUser.image,
            relationshipType: "webinar",
          });
        }
      }
    }

    // 4. Get attendees from classes (only BOOKED/WAITING/NOTIFIED waitlist users)
    const classes = await prisma.class.findMany({
      where: {
        classPlan: {
          consultantProfileId: consultantProfileId,
        },
        status: {
          in: ["SCHEDULED", "IN_PROGRESS", "COMPLETED"],
        },
      },
      include: {
        waitlist: {
          where: {
            status: { in: ["BOOKED", "WAITING", "NOTIFIED"] },
          },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
      },
    });

    for (const classItem of classes) {
      for (const waitlistEntry of classItem.waitlist) {
        const attendeeUser = waitlistEntry.user;
        if (
          attendeeUser &&
          !seenUserIds.has(attendeeUser.id) &&
          (searchTerm === "" ||
            attendeeUser.name?.toLowerCase().includes(searchTerm) ||
            attendeeUser.email?.toLowerCase().includes(searchTerm))
        ) {
          seenUserIds.add(attendeeUser.id);
          results.push({
            id: attendeeUser.id,
            name: attendeeUser.name,
            email: attendeeUser.email,
            image: attendeeUser.image,
            relationshipType: "class",
          });
        }
      }
    }

    // Sort by name
    results.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    return NextResponse.json({
      success: true,
      consultees: results.slice(0, 50), // Limit to 50 results
      total: results.length,
    });
  } catch (error) {
    console.error("Error searching consultees:", error);
    return NextResponse.json(
      { error: "Failed to search consultees" },
      { status: 500 },
    );
  }
}
