import prisma from "@/lib/prisma";
import { Prisma, RequestStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { addMonths } from "date-fns";
import {
  notifySubscriptionStarted,
  notifySubscriptionCancelled,
} from "@/lib/novu";
import { UpdateSubscriptionStatusSchema } from "@/schemas/subscriptions";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(request: NextRequest) {
  // Require authentication
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const { searchParams } = new URL(request.url);
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const status = searchParams.get("status") as RequestStatus | null;
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "10");

  try {
    const whereClause: Prisma.SubscriptionWhereInput = {};

    // Authorization: filter by ownership for non-privileged users
    if (!isPrivileged(session.user.role)) {
      if (session.user.role === "CONSULTANT") {
        // Consultants can only see their own subscriptions
        whereClause.subscriptionPlan = {
          consultantProfile: {
            id: session.user.consultantProfileId,
          },
        };
      } else if (session.user.role === "CONSULTEE") {
        // Consultees can only see their own subscriptions
        whereClause.requestedById = session.user.consulteeProfileId;
      } else {
        // Unknown role - deny access
        return forbiddenResponse("Access denied");
      }
    } else {
      // Privileged users can filter by any profile
      if (consultantProfileId) {
        whereClause.subscriptionPlan = {
          consultantProfileId,
        };
      }

      if (consulteeProfileId) {
        whereClause.requestedById = consulteeProfileId;
      }
    }

    if (status) {
      whereClause.requestStatus = status;
    }

    const [subscriptions, total] = await Promise.all([
      prisma.subscription.findMany({
        where: whereClause,
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                  domain: true,
                  subDomains: true,
                  tags: true,
                },
              },
            },
          },
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
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
              payment: true,
            },
          },
        },
        orderBy: {
          requestedAt: "desc",
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.subscription.count({ where: whereClause }),
    ]);

    return NextResponse.json({
      data: subscriptions,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching subscriptions:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching subscriptions" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const body = await request.json();
    const result = UpdateSubscriptionStatusSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const { id, status } = result.data;

    // First fetch the subscription to validate it exists and get all necessary data
    const existingSubscription = await prisma.subscription.findUnique({
      where: { id },
      include: {
        subscriptionPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true,
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!existingSubscription) {
      return NextResponse.json(
        { error: "Subscription not found" },
        { status: 404 },
      );
    }

    if (!existingSubscription.subscriptionPlan?.consultantProfile?.user?.id) {
      return NextResponse.json(
        { error: "Invalid subscription: missing consultant information" },
        { status: 400 },
      );
    }

    if (!existingSubscription.requestedBy?.user?.id) {
      return NextResponse.json(
        { error: "Invalid subscription: missing requestedBy information" },
        { status: 400 },
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      existingSubscription.subscriptionPlan?.consultantProfile?.id ===
      session.user.consultantProfileId;
    const isConsultee =
      existingSubscription.requestedById === session.user.consulteeProfileId;
    if (!isPrivileged(session.user.role) && !isConsultant && !isConsultee) {
      return forbiddenResponse(
        "You can only modify subscriptions you are a participant in",
      );
    }

    const startDate = new Date();
    const endDate = addMonths(
      startDate,
      existingSubscription.subscriptionPlan.durationInMonths,
    );

    try {
      // Update subscription status and dates
      const subscription = await prisma.subscription.update({
        where: { id },
        data: {
          requestStatus: status,
          schedulingPeriodStartsAt: startDate,
          schedulingPeriodEndsAt: endDate,
        },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: true,
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
              payment: true,
            },
          },
        },
      });

      // If approved, notify consultee
      // Note: Appointment slots are created through SlotAllocationService during checkout,
      // not here. This handler only manages status transitions and notifications.
      if (status === RequestStatus.APPROVED) {
        // Fire-and-forget: notify consultee that subscription started
        const consulteeUserId = subscription.requestedBy?.user?.id;
        if (consulteeUserId) {
          void notifySubscriptionStarted(consulteeUserId, {
            subscriptionId: subscription.id,
            planTitle: subscription.subscriptionPlan?.title || "Subscription",
            consultantName:
              subscription.subscriptionPlan?.consultantProfile?.user?.name ||
              "Consultant",
            consulteeName: subscription.requestedBy?.user?.name || undefined,
            dashboardUrl: "/dashboard",
          });
        }
      }

      // Fire-and-forget: notify both parties on cancellation
      if (status === RequestStatus.CANCELLED) {
        const consultantUserId =
          subscription.subscriptionPlan?.consultantProfile?.user?.id;
        const consulteeUserId = subscription.requestedBy?.user?.id;
        const userIds = [consultantUserId, consulteeUserId].filter(
          (id): id is string => !!id,
        );
        if (userIds.length > 0) {
          void notifySubscriptionCancelled(userIds, {
            subscriptionId: subscription.id,
            planTitle: subscription.subscriptionPlan?.title || "Subscription",
            consultantName:
              subscription.subscriptionPlan?.consultantProfile?.user?.name ||
              "Consultant",
            consulteeName: subscription.requestedBy?.user?.name || undefined,
            dashboardUrl: "/dashboard",
          });
        }
      }

      return NextResponse.json({ data: subscription });
    } catch (error) {
      console.error(
        "Transaction error:",
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    }
  } catch (error) {
    console.error(
      "Error updating subscription:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "An error occurred while updating subscription" },
      { status: 500 },
    );
  }
}
