import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";

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

    let subscriptionDateFilter: Prisma.SubscriptionWhereInput = {};
    if (status === "active") {
      subscriptionDateFilter = {
        schedulingPeriodEndsAt: { gt: now },
      };
    } else if (status === "expiring_soon") {
      subscriptionDateFilter = {
        schedulingPeriodEndsAt: { gt: now, lte: soonThreshold },
      };
    } else if (status === "expired") {
      subscriptionDateFilter = {
        schedulingPeriodEndsAt: { lte: now },
      };
    }

    const where: Prisma.PaymentWhereInput = {
      appointment: {
        appointmentType: "SUBSCRIPTION",
        subscription:
          Object.keys(subscriptionDateFilter).length > 0
            ? subscriptionDateFilter
            : undefined,
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
              subscription: { schedulingPeriodEndsAt: { gt: soonThreshold } },
            },
          },
        }),
        prisma.payment.count({
          where: {
            ...baseWhere,
            appointment: {
              appointmentType: "SUBSCRIPTION",
              subscription: {
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
              subscription: { schedulingPeriodEndsAt: { lte: now } },
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
      const sessionsScheduled = occurrences.length;
      const sessionsTotal =
        subscription?.sessionsTotal ?? plan?.totalSessions ?? 0;

      const endDate = subscription?.schedulingPeriodEndsAt;
      const isCancelled = subscription?.status === "CANCELLED";
      const isActive = !isCancelled && endDate && new Date(endDate) > now;
      const isExpiringSoon =
        isActive &&
        endDate &&
        new Date(endDate) < new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

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
        sessionsScheduled,
        startDate: subscription?.schedulingPeriodStartsAt,
        endDate: subscription?.schedulingPeriodEndsAt,
        subscriptionStatus: subscription?.status,
        status: isCancelled
          ? "cancelled"
          : isActive
            ? isExpiringSoon
              ? "expiring_soon"
              : "active"
            : "expired",
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
  action: z.enum(["CANCEL", "PAUSE", "RESUME"]),
};

export const POST = withOpsAction(
  "subscriptions.manage",
  "subscriptions.ops.mutate",
  MutateSubscriptionShape,
  {
    mode: "tx",
    run: async (tx, { body, actor }) => {
      const existing = await tx.subscription.findUnique({
        where: { id: body.subscriptionId },
        select: {
          id: true,
          status: true,
        },
      });
      if (!existing) {
        throw new OpsRefusal(
          "SUBSCRIPTION_NOT_FOUND",
          "Subscription not found.",
          404,
        );
      }

      const targetStatus =
        body.action === "CANCEL"
          ? "CANCELLED"
          : body.action === "PAUSE"
            ? "PENDING"
            : "SCHEDULED";

      const allowedSourceStatuses: readonly (typeof existing.status)[] =
        body.action === "CANCEL"
          ? ["PENDING", "APPROVED", "APPROVED_PENDING_PAYMENT", "SCHEDULED"]
          : body.action === "PAUSE"
            ? ["SCHEDULED", "APPROVED"]
            : ["PENDING"];

      if (existing.status === targetStatus) {
        throw new OpsRefusal(
          "ALREADY_IN_STATE",
          `Subscription is already in ${targetStatus} state.`,
          409,
        );
      }
      if (!allowedSourceStatuses.includes(existing.status)) {
        throw new OpsRefusal(
          "INVALID_SOURCE_STATE",
          `Cannot ${body.action.toLowerCase()} a subscription in ${existing.status} state.`,
          409,
        );
      }

      const now = new Date();
      const updated = await tx.subscription.updateMany({
        where: {
          id: existing.id,
          status: { in: [...allowedSourceStatuses] },
        },
        data: {
          status: targetStatus,
          ...(body.action === "CANCEL"
            ? {
                cancelledAt: now,
                cancelledBy: actor.userId,
                cancellationNotes: body.reason,
              }
            : {}),
        },
      });

      if (updated.count === 0) {
        throw new OpsRefusal(
          "CONCURRENT_UPDATE",
          "Subscription status was updated concurrently; retry.",
          409,
        );
      }

      return {
        target: { kind: "Subscription", id: existing.id },
        status: 200,
        response: {
          subscriptionId: existing.id,
          previousStatus: existing.status,
          status: targetStatus,
        },
        before: { status: existing.status },
        after: { status: targetStatus, action: body.action },
      };
    },
  },
);
