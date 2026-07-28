import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";

import { getSession } from "@/lib/auth-server";
// See schemas/stream-search.ts for why the shape does not live here.
import {
  ConsulteeSearchResultSchema,
  type ConsulteeSearchResult,
} from "@/schemas/stream-search";

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

    // Capability, not UserRole (#org-appts): gate on owning a consultantProfile.
    // An org EXPERT (whose top-level role may be CONSULTEE) legitimately searches
    // the consultees they're delivering to; the old `role !== "CONSULTANT"` half
    // wrongly blocked them. The query is already scoped to their own profile id.
    // consultantProfileId is already on the session (customSession) — no re-query.
    if (!session.user.consultantProfileId) {
      return NextResponse.json(
        { error: "Only consultants can search consultees" },
        { status: 403 },
      );
    }

    const consultantProfileId = session.user.consultantProfileId;
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

    // Validated against the same schema the dialog derives its type from, so
    // a drift in this handler fails here rather than showing up as a blank row.
    return NextResponse.json({
      success: true,
      consultees: ConsulteeSearchResultSchema.array().parse(
        results.slice(0, 50),
      ),
      total: results.length,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    console.error("Error searching consultees:", error);
    return NextResponse.json(
      { error: "Failed to search consultees" },
      { status: 500 },
    );
  }
}
