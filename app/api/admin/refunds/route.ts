import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, RefundStatus, PaymentGateway } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import {
  classSeriesLedgers,
  refundWholeEventPayments,
} from "@/lib/payments/operations/event-refunds";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import {
  refundableEventPaise,
  refundablePaymentPaise,
  refundInFlightOr,
} from "@/lib/backoffice/refund-doors";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    // Parse query parameters
    const searchParams = req.nextUrl.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const status = searchParams.get("status") as RefundStatus | null;
    const gateway = searchParams.get("gateway") as PaymentGateway | null;
    const search = searchParams.get("search");

    // Build where clause
    const where: Prisma.RefundWhereInput = {};

    if (status) {
      where.status = status;
    }

    if (gateway) {
      where.paymentGateway = gateway;
    }

    if (search) {
      where.refundId = {
        contains: search,
        mode: "insensitive",
      };
    }

    // Fetch refunds with pagination. pending/succeeded/failed counts are
    // dashboard-wide (unfiltered by search/gateway) — #997 secondary
    // findings: the stat cards used to `.filter()` the current page's
    // `refunds` array, so they silently showed ≤`limit` (20) instead of the
    // true platform-wide count.
    const [refunds, total, pendingCount, succeededCount, failedCount] =
      await Promise.all([
        prisma.refund.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            payment: {
              select: {
                id: true,
                paymentIntent: true,
              },
            },
          },
        }),
        prisma.refund.count({ where }),
        prisma.refund.count({ where: { status: "PENDING" } }),
        prisma.refund.count({ where: { status: "SUCCEEDED" } }),
        prisma.refund.count({ where: { status: "FAILED" } }),
      ]);

    return NextResponse.json({
      refunds,
      total,
      stats: { pendingCount, succeededCount, failedCount },
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Admin refunds list error:", error);
    return NextResponse.json(
      { error: "Failed to fetch refunds" },
      { status: 500 },
    );
  }
}

const IDEMPOTENCY_KEY = z.string().trim().min(10).max(255);

// Admin-initiated refund (#776 §C). Exactly one target: a single payment, or a
// whole class/webinar (every attendee). Both go through the refund front doors
// (#1319): a single payment via refundBookingPayment, which splits gateway,
// org-funded (in-ledger) and credit rails; events fan out through the reversal engine.
// `idempotencyKey` is the Idempotency-Key header, carried in the body so a proposal replays it.
const refundDoor = withOpsAction(
  "refunds.manage",
  (b) => (b.paymentId ? "refund.issue" : "refund.event"),
  {
    idempotencyKey: IDEMPOTENCY_KEY,
    paymentId: z.string().min(1).optional(),
    classId: z.string().min(1).optional(),
    webinarId: z.string().min(1).optional(),
    amountPaise: z.number().int().positive().optional(),
  },
  {
    mode: "gateway",
    target: ({ body }) => refundTarget(body),
    run: async ({ body, actor }) => {
      const targets = [body.paymentId, body.classId, body.webinarId];
      if (targets.filter(Boolean).length !== 1) {
        throw new OpsRefusal(
          "INVALID_BODY",
          "Provide exactly one of paymentId, classId, webinarId",
          400,
        );
      }
      if (body.amountPaise && !body.paymentId) {
        throw new OpsRefusal(
          "INVALID_BODY",
          "amountPaise applies only to a single paymentId refund",
          400,
        );
      }
      await assertMoneyOpsBudget(actor.userId);

      if (body.paymentId) {
        // A replay of one dialog collapses on `Refund.dedupeKey @unique`; a key
        // reused for another payment or by another admin can never match it.
        const dedupeKey = `admin-refund:${actor.userId}:${body.paymentId}:${body.idempotencyKey}`;
        const result = await refundBookingPayment({
          paymentId: body.paymentId,
          amountPaise: body.amountPaise,
          reason: `admin refund: ${body.reason}`,
          initiatedByUserId: actor.userId,
          dedupeKey,
          // A partial admin refund is not a cancellation; one that returns the rest ends the seat.
          keepSeatIfPartial: true,
          settlesOwedByHand: true,
        }).catch((err: unknown) => refundInFlightOr(err, dedupeKey));
        return {
          target: refundTarget(body),
          after: { ...result },
          response: { kind: "payment", result },
        };
      }

      const eventKind = body.classId ? "class" : "webinar";
      const eventId = (body.classId ?? body.webinarId)!;
      // #1780 D-5 — the class ledger nets each seat to what the series did
      // not deliver; a webinar refunds in full by design, so it has none.
      const ledgers = body.classId ? await classSeriesLedgers(eventId) : null;
      const summary = await refundWholeEventPayments(
        eventKind,
        eventId,
        `admin whole-event refund: ${body.reason}`,
        actor.userId,
        {
          ledgers: ledgers ?? undefined,
          // This door's own per-payment keys: a retry reuses them, and they
          // never collide with the series-cancel doors' keys.
          dedupeKeyPrefix: "admin-event-refund",
        },
      );
      // #1583 C-P0-03 — every rail clamps to the refundable balance, so a
      // repeat answers 200 with nothing refunded, never a second cascade.
      const alreadyRefunded =
        summary.alreadyRefunded && summary.refundsIssued === 0;
      const { nothingToRefund } = summary;
      let response: Record<string, unknown> = { kind: eventKind, summary };
      if (nothingToRefund) {
        response = {
          ...response,
          nothingToRefund: true,
          refunded: 0,
          message:
            "Every seat on this event was free, so there is nothing to refund.",
        };
      } else if (alreadyRefunded) {
        response = { ...response, alreadyRefunded: true, refunded: 0 };
      }
      return {
        target: refundTarget(body),
        after: {
          refundsIssued: summary.refundsIssued,
          alreadyRefunded,
          nothingToRefund,
        },
        response,
      };
    },
  },
  {
    stepUp: true,
    secondApprover: {
      route: "/api/admin/refunds",
      target: ({ body }) => refundTarget(body),
      amountPaise: (body) => {
        if (body.paymentId) {
          return body.amountPaise ?? refundablePaymentPaise(body.paymentId);
        }
        if (body.classId) return refundableEventPaise("class", body.classId);
        if (body.webinarId) {
          return refundableEventPaise("webinar", body.webinarId);
        }
        return 0;
      },
    },
  },
);

function refundTarget(body: {
  paymentId?: string;
  classId?: string;
  webinarId?: string;
}): { kind: string; id: string } {
  if (body.paymentId) return { kind: "Payment", id: body.paymentId };
  if (body.classId) return { kind: "Class", id: body.classId };
  return { kind: "Webinar", id: body.webinarId ?? "unknown" };
}

const jsonObject = z.record(z.unknown());

/**
 * POST — ADMIN, step-up, a typed reason, an ops log row, and a required
 * `Idempotency-Key` header that becomes the refund's dedupe key.
 */
export const POST = Object.assign(
  async (req: NextRequest, route: { params: Promise<unknown> }) => {
    const key = IDEMPOTENCY_KEY.safeParse(req.headers.get("idempotency-key"));
    if (!key.success) {
      return NextResponse.json(
        {
          error:
            "An Idempotency-Key header (10–255 characters) is required, one per refund dialog.",
          code: "IDEMPOTENCY_KEY_REQUIRED",
        },
        { status: 400 },
      );
    }
    const body = jsonObject.safeParse(await req.json().catch(() => ({})));
    const forwarded = new NextRequest(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify({
        ...(body.success ? body.data : {}),
        idempotencyKey: key.data,
      }),
    });
    return refundDoor(forwarded, route);
  },
  {
    proposalRoute: refundDoor.proposalRoute,
    executeApproved: refundDoor.executeApproved,
  },
);
