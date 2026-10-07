import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import {
  CANCELLABLE_FROM,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";

function buildSubscriptionFilter(
  status: string | null,
  now: Date,
  soonThreshold: Date,
): Prisma.SubscriptionWhereInput | undefined {
  if (status === "active") {
    return {
      status: { not: "CANCELLED" },
      schedulingPeriodEndsAt: { gt: soonThreshold },
    };
  }
  if (status === "expiring_soon") {
    return {
      status: { not: "CANCELLED" },
      schedulingPeriodEndsAt: { gt: now, lte: soonThreshold },
    };
  }
  if (status === "expired") {
    return {
      status: { not: "CANCELLED" },
      schedulingPeriodEndsAt: { lte: now },
    };
  }
  if (status === "cancelled") {
    return { status: "CANCELLED" };
  }
  return undefined;
}

function deriveSubscriptionDisplayStatus(
  isCancelled: boolean,
  isActive: boolean,
  isExpiringSoon: boolean,
): "cancelled" | "expiring_soon" | "active" | "expired" {
  if (isCancelled) return "cancelled";
  if (!isActive) return "expired";
  if (isExpiringSoon) return "expiring_soon";
  return "active";
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const search = searchParams.get("search");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");
    const orgId = searchParams.get("orgId");

    const now = new Date();
    const soonThreshold = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const subscriptionFilter = buildSubscriptionFilter(
      status,
      now,
      soonThreshold,
    );

    const where: Prisma.PaymentWhereInput = {
      appointment: {
        appointmentType: "SUBSCRIPTION",
        subscription: subscriptionFilter,
      },
    };

    if (search) {
      where.OR = [
        {
          user: {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          },
        },
      ];
    }

    if (orgId) {
      where.organizationId = orgId;
    }

    const baseWhere = {
      paymentStatus: "SUCCEEDED" as const,
      appointment: {
        appointmentType: "SUBSCRIPTION" as const,
      },
    };

    const [subscriptions, total, activeCount, expiringCount, expiredCount] =
      await Promise.all([
        prisma.payment.findMany({
          where: {
            ...where,
            paymentStatus: "SUCCEEDED",
          },
          include: {
            user: {
              select: { id: true, name: true, email: true },
            },
            appointment: {
              include: {
                occurrences: {
                  where: { deletedAt: null },
                  select: {
                    id: true,
                    completionStatus: true,
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: {
                      include: {
                        consultantProfile: {
                          include: {
                            user: {
                              select: { id: true, name: true, email: true },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.payment.count({
          where: {
            ...where,
            paymentStatus: "SUCCEEDED",
          },
        }),
        prisma.payment.count({
          where: {
            ...baseWhere,
            appointment: {
              appointmentType: "SUBSCRIPTION",
              subscription: {
                status: { not: "CANCELLED" },
                schedulingPeriodEndsAt: { gt: soonThreshold },
              },
            },
          },
        }),
        prisma.payment.count({
          where: {
            ...baseWhere,
            appointment: {
              appointmentType: "SUBSCRIPTION",
              subscription: {
                status: { not: "CANCELLED" },
                schedulingPeriodEndsAt: { gt: now, lte: soonThreshold },
              },
            },
          },
        }),
        prisma.payment.count({
          where: {
            ...baseWhere,
            appointment: {
              appointmentType: "SUBSCRIPTION",
              subscription: {
                status: { not: "CANCELLED" },
                schedulingPeriodEndsAt: { lte: now },
              },
            },
          },
        }),
      ]);

    const formattedSubscriptions = subscriptions.map((s) => {
      const subscription = s.appointment?.subscription;
      const plan = subscription?.subscriptionPlan;
      const consultantUser = plan?.consultantProfile?.user;
      const occurrences = s.appointment?.occurrences ?? [];
      const sessionsCompleted = occurrences.filter(
        (o) => o.completionStatus === "COMPLETED",
      ).length;
      const sessionsUpcoming = occurrences.filter(
        (o) =>
          o.completionStatus !== "COMPLETED" &&
          o.completionStatus !== "CANCELLED",
      ).length;
      const sessionsScheduled = occurrences.length;
      const sessionsTotal =
        subscription?.sessionsTotal ?? plan?.totalSessions ?? 0;

      const endDate = subscription?.schedulingPeriodEndsAt;
      const isCancelled = subscription?.status === "CANCELLED";
      const isActive = Boolean(
        !isCancelled && endDate && new Date(endDate) > now,
      );
      const isExpiringSoon = Boolean(
        isActive && endDate && new Date(endDate) <= soonThreshold,
      );

      return {
        id: s.id,
        paymentId: s.id,
        appointmentId: s.appointment?.id ?? null,
        subscriptionId: subscription?.id ?? null,
        amount: s.amount,
        currency: s.currency,
        gateway: s.paymentGateway,
        userId: s.user?.id ?? s.userId,
        userName: s.user?.name || "Unknown",
        userEmail: s.user?.email || "",
        consultantUserId: consultantUser?.id ?? null,
        consultantName: consultantUser?.name,
        consultantEmail: consultantUser?.email ?? null,
        planTitle: plan?.title ?? "Subscription Plan",
        durationInMonths: plan?.durationInMonths ?? 1,
        sessionsPerWeek: plan?.sessionsPerWeek ?? 1,
        sessionsTotal,
        sessionsCompleted,
        sessionsUpcoming,
        sessionsScheduled,
        startDate: subscription?.schedulingPeriodStartsAt,
        endDate: subscription?.schedulingPeriodEndsAt,
        subscriptionStatus: subscription?.status,
        status: deriveSubscriptionDisplayStatus(
          isCancelled,
          isActive,
          isExpiringSoon,
        ),
        createdAt: s.createdAt,
      };
    });

    return NextResponse.json({
      subscriptions: formattedSubscriptions,
      stats: {
        activeCount,
        expiringCount,
        expiredCount,
      },
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Error fetching subscriptions:", error);
    return NextResponse.json(
      { error: "Failed to fetch subscriptions" },
      { status: 500 },
    );
  }
}

const MutateSubscriptionShape = {
  subscriptionId: z.string().trim().min(1),
  action: z.literal("CANCEL"),
};

export const POST = withOpsAction(
  "subscriptions.manage",
  "subscriptions.ops.mutate",
  MutateSubscriptionShape,
  {
    mode: "gateway",
    target: ({ body }) => ({ kind: "Subscription", id: body.subscriptionId }),
    run: async ({ body, actor }) => {
      const existing = await prisma.subscription.findUnique({
        where: { id: body.subscriptionId },
        select: {
          id: true,
          status: true,
          appointment: {
            select: {
              id: true,
            },
          },
        },
      });
      if (!existing) {
        throw new OpsRefusal(
          "SUBSCRIPTION_NOT_FOUND",
          "Subscription not found.",
          404,
        );
      }

      if (existing.status === "CANCELLED") {
        throw new OpsRefusal(
          "ALREADY_IN_STATE",
          "Subscription is already in CANCELLED state.",
          409,
        );
      }

      await prisma.$transaction((tx) =>
        transitionSubscriptionRequest(tx, {
          actorUserId: actor.userId,
          reason: body.reason,
          organizationId: null,
          where: { id: existing.id },
          to: "CANCELLED",
          data: {
            cancelledAt: new Date(),
            cancelledBy: actor.userId,
            cancellationReason: "OTHER",
            cancellationNotes: body.reason,
          },
          fromIn: [...CANCELLABLE_FROM],
        }),
      );

      return {
        target: { kind: "Subscription", id: existing.id },
        status: 200,
        response: {
          subscriptionId: existing.id,
          previousStatus: existing.status,
          status: "CANCELLED",
        },
        before: { status: existing.status },
        after: {
          status: "CANCELLED",
          action: "CANCEL",
        },
      };
    },
  },
);
