import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { AppointmentStatus, Prisma } from "@prisma/client";
import { z } from "zod";

import prisma, { type Tx } from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";

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
  action: z.enum(["CANCEL", "PAUSE", "RESUME"]),
};

type SubscriptionAction = "CANCEL" | "PAUSE" | "RESUME";

async function resolveSubscriptionTransition(
  tx: Tx,
  subscriptionId: string,
  currentStatus: AppointmentStatus,
  hasSucceededPayment: boolean,
  action: SubscriptionAction,
): Promise<{
  targetStatus: AppointmentStatus;
  allowedSourceStatuses: readonly AppointmentStatus[];
  before: { status: AppointmentStatus; prePauseStatus?: AppointmentStatus };
}> {
  if (action === "CANCEL") {
    return {
      targetStatus: "CANCELLED",
      allowedSourceStatuses: [
        "PENDING",
        "APPROVED",
        "APPROVED_PENDING_PAYMENT",
        "SCHEDULED",
      ],
      before: { status: currentStatus },
    };
  }

  if (action === "PAUSE") {
    if (!hasSucceededPayment) {
      throw new OpsRefusal(
        "UNPAID_SUBSCRIPTION",
        "Cannot pause a subscription without a succeeded payment.",
        409,
      );
    }
    return {
      targetStatus: "PENDING",
      allowedSourceStatuses: ["SCHEDULED", "APPROVED"],
      before: { status: currentStatus, prePauseStatus: currentStatus },
    };
  }

  if (!hasSucceededPayment) {
    throw new OpsRefusal(
      "UNPAID_SUBSCRIPTION",
      "Cannot resume an unpaid PENDING subscription.",
      409,
    );
  }

  const lastPauseLog = await tx.opsActionLog.findFirst({
    where: {
      targetKind: "Subscription",
      targetId: subscriptionId,
      action: "subscriptions.ops.mutate",
    },
    orderBy: { createdAt: "desc" },
    select: { before: true, after: true },
  });

  const lastAfter = lastPauseLog?.after as Record<string, unknown> | null;
  if (!lastPauseLog || lastAfter?.action !== "PAUSE") {
    throw new OpsRefusal(
      "NOT_PAUSED",
      "Subscription was not paused by an admin action and cannot be resumed.",
      409,
    );
  }

  const lastBefore = lastPauseLog.before as Record<string, unknown> | null;
  const priorStatus = lastBefore?.prePauseStatus ?? lastBefore?.status;
  const restoredStatus: AppointmentStatus =
    priorStatus === "APPROVED" ? "APPROVED" : "SCHEDULED";

  return {
    targetStatus: restoredStatus,
    allowedSourceStatuses: ["PENDING"],
    before: { status: currentStatus },
  };
}

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
          appointment: {
            select: {
              payment: {
                where: { paymentStatus: "SUCCEEDED" },
                select: { id: true },
                take: 1,
              },
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

      const hasSucceededPayment =
        (existing.appointment?.payment?.length ?? 0) > 0;
      const { targetStatus, allowedSourceStatuses, before } =
        await resolveSubscriptionTransition(
          tx,
          existing.id,
          existing.status,
          hasSucceededPayment,
          body.action,
        );

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
        before,
        after: { status: targetStatus, action: body.action },
      };
    },
  },
);
