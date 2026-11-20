import { PARTY_PROFILE_SELECT } from "@/lib/booking/list-selects";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readOffsetParams } from "@/lib/backoffice/list-paging";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import {
  schedulableSessionsOf,
  subscriptionPlanEnd,
} from "@/lib/booking/entitlement";
import {
  CANCELLABLE_FROM,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";

type PlanEndBucket = "active" | "expiring_soon" | "expired";

/** Rows read per page of the rows without a stored plan end. */
const NULL_END_PAGE = 500;
/** The most of them one request reads; past it the rest are left out and reported. */
const NULL_END_CAP = 5_000;

const NULL_END_SELECT = {
  id: true,
  planEndsAt: true,
  schedulingPeriodStartsAt: true,
  schedulingTimezone: true,
  subscriptionPlan: { select: { durationInMonths: true } },
} satisfies Prisma.SubscriptionSelect;

/**
 * Rows from before plan ends were stored carry none; each is bucketed by its
 * derived end, exactly as the list renders it. New rows always store their
 * end, so this set only shrinks: it is read in keyset pages, up to a cap.
 */
async function nullEndBuckets(
  now: Date,
  soonThreshold: Date,
): Promise<Record<PlanEndBucket, string[]>> {
  const buckets: Record<PlanEndBucket, string[]> = {
    active: [],
    expiring_soon: [],
    expired: [],
  };
  let cursor: string | null = null;
  for (let read = 0; read < NULL_END_CAP; read += NULL_END_PAGE) {
    const rows: Prisma.SubscriptionGetPayload<{
      select: typeof NULL_END_SELECT;
    }>[] = await prisma.subscription.findMany({
      where: {
        planEndsAt: null,
        status: { not: "CANCELLED" },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: NULL_END_PAGE,
      select: NULL_END_SELECT,
    });
    for (const row of rows) {
      const end = subscriptionPlanEnd(row).getTime();
      if (end <= now.getTime()) buckets.expired.push(row.id);
      else if (end <= soonThreshold.getTime())
        buckets.expiring_soon.push(row.id);
      else buckets.active.push(row.id);
    }
    if (rows.length < NULL_END_PAGE) return buckets;
    cursor = rows[rows.length - 1].id;
  }
  Sentry.captureMessage(
    "admin subscriptions: rows without a plan end exceed the read cap",
    {
      level: "warning",
      extra: { cap: NULL_END_CAP },
    },
  );
  return buckets;
}

// Plan-end filters read the stored `planEndsAt`, or the derived end of a row without one.
function buildSubscriptionFilter(
  status: string | null,
  now: Date,
  soonThreshold: Date,
  nullEnds: Record<PlanEndBucket, string[]>,
): Prisma.SubscriptionWhereInput | undefined {
  const byEnd = (
    bucket: PlanEndBucket,
    planEndsAt: Prisma.DateTimeNullableFilter,
  ): Prisma.SubscriptionWhereInput => ({
    status: { not: "CANCELLED" },
    OR: [{ planEndsAt }, { planEndsAt: null, id: { in: nullEnds[bucket] } }],
  });
  if (status === "active") {
    return byEnd("active", { gt: soonThreshold });
  }
  if (status === "expiring_soon") {
    return byEnd("expiring_soon", { gt: now, lte: soonThreshold });
  }
  if (status === "expired") {
    return byEnd("expired", { lte: now });
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
    const auth = await requireBackofficeSurface("subscriptions.read");
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    // An unknown status is a 400, as on the other money lists.
    const statusParam = z
      .enum(["active", "expiring_soon", "expired", "cancelled"])
      .optional()
      .safeParse(searchParams.get("status") || undefined);
    if (!statusParam.success) {
      return NextResponse.json(
        { error: "Invalid query parameters", code: "INVALID_QUERY" },
        { status: 400 },
      );
    }
    const status = statusParam.data ?? null;
    const search = searchParams.get("search");
    const { limit, offset } = readOffsetParams(searchParams);
    const orgId = searchParams.get("orgId");

    const now = new Date();
    const soonThreshold = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const nullEnds = await nullEndBuckets(now, soonThreshold);
    const filterFor = (s: string | null) =>
      buildSubscriptionFilter(s, now, soonThreshold, nullEnds);
    const subscriptionFilter = filterFor(status);

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

    const countIn = (bucket: PlanEndBucket) =>
      prisma.payment.count({
        where: {
          ...baseWhere,
          appointment: {
            appointmentType: "SUBSCRIPTION",
            subscription: filterFor(bucket),
          },
        },
      });

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
                        consultantProfile: PARTY_PROFILE_SELECT,
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
          skip: offset,
        }),
        prisma.payment.count({
          where: {
            ...where,
            paymentStatus: "SUCCEEDED",
          },
        }),
        countIn("active"),
        countIn("expiring_soon"),
        countIn("expired"),
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
      const sessionsTotal = subscription
        ? (schedulableSessionsOf(subscription) ?? 0)
        : (plan?.totalSessions ?? 0);

      const endDate = subscription ? subscriptionPlanEnd(subscription) : null;
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
        sessionsPerWeek:
          subscription?.sessionsPerWeek ?? plan?.sessionsPerWeek ?? 1,
        sessionsTotal,
        sessionsCompleted,
        sessionsUpcoming,
        sessionsScheduled,
        startDate: subscription?.schedulingPeriodStartsAt,
        endDate,
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

      // This door only marks the row cancelled. A booking's sessions, seats,
      // payments and refund end through the booking's own cancel.
      if (existing.appointment) {
        throw new OpsRefusal(
          "USE_CANCEL_DOOR",
          "This subscription has a booking, so it can't just be marked cancelled. Cancel the booking instead: that releases its sessions and refunds the buyer.",
          409,
          { appointmentId: existing.appointment.id },
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
