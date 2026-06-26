import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma, AppointmentStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { addMonths } from "date-fns";
import {
  notifySubscriptionStarted,
  notifySubscriptionCancelled,
} from "@/lib/novu";
import { logSubscriptionCancelled } from "@/lib/activity/log-activity";
import { UpdateSubscriptionStatusSchema } from "@/schemas/subscriptions";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { transitionSubscriptionRequest } from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  // Require authentication
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const { searchParams } = new URL(request.url);
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const status = searchParams.get("status") as AppointmentStatus | null;
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "10");

  try {
    const whereClause: Prisma.SubscriptionWhereInput = {};

    // Authorization: filter by ownership for non-privileged users.
    // `?? "__none__"` (the participants-route idiom) is load-bearing: a
    // session with a missing profile id would otherwise put `undefined`
    // into the where clause, which Prisma IGNORES — silently dropping the
    // ownership filter and serving every consultant's subscriptions.
    if (!isPrivileged(session.user.role)) {
      if (session.user.role === "CONSULTANT") {
        // Consultants can only see their own subscriptions
        whereClause.subscriptionPlan = {
          consultantProfile: {
            id: session.user.consultantProfileId ?? "__none__",
          },
        };
      } else if (session.user.role === "CONSULTEE") {
        // Consultees can only see their own subscriptions
        whereClause.requestedById = session.user.consulteeProfileId ?? "__none__";
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
      whereClause.status = status;
    }

    const [subscriptions, total] = await Promise.all([
      prisma.subscription.findMany({
        where: whereClause,
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
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
                  user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
                },
              },
              payment: { select: { id: true, paymentStatus: true, amount: true, currency: true } },
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
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
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

    // #831 — event mutations previously had no limiter
    const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (rl) return rl;

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
                user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
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
      !!existingSubscription.subscriptionPlan?.consultantProfile?.id &&
      existingSubscription.subscriptionPlan.consultantProfile.id ===
        session.user.consultantProfileId;
    const isConsultee =
      !!existingSubscription.requestedById &&
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
      // #836 — allowed-from guard rides the WHERE; updateMany returns no
      // row, so re-read for the heavy include.
      await prisma.$transaction((tx) =>
        transitionSubscriptionRequest(tx, {
          where: { id },
          to: status,
          data: {
            schedulingPeriodStartsAt: startDate,
            schedulingPeriodEndsAt: endDate,
          },
        }),
      );
      const subscription = await prisma.subscription.findUniqueOrThrow({
        where: { id },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
                },
              },
              payment: { select: { id: true, paymentStatus: true, amount: true, currency: true } },
            },
          },
        },
      });

      // If approved, notify consultee
      // Note: Appointment slots are created through SlotAllocationService during checkout,
      // not here. This handler only manages status transitions and notifications.
      if (status === AppointmentStatus.APPROVED) {
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
      if (status === AppointmentStatus.CANCELLED) {
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

        // Log cancellation activity (awaited — DB write should not be dropped in serverless)
        const cpId = subscription.subscriptionPlan?.consultantProfileId;
        if (cpId) {
          await logSubscriptionCancelled(
            cpId,
            subscription.id,
            {
              id: session.user.id,
              name: session.user.name || "User",
              image: session.user.image,
            },
            subscription.subscriptionPlan?.title || "Subscription",
            session.user.id === consultantUserId ? "consultant" : "consultee",
          );
        }
      }

      return NextResponse.json({ data: subscription });
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
      console.error(
        "Transaction error:",
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    }
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
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
