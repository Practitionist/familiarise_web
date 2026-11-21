import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, RefundStatus, PaymentGateway } from "@prisma/client";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readPageParams } from "@/lib/backoffice/list-paging";
import type { RefundListItem } from "@/lib/backoffice/money-list-schemas";
import { BOOKING_TITLE_SELECT, bookingRefOf } from "@/lib/data/booking-title";
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
import { assertRefundDoorOpen } from "@/lib/backoffice/refund-eligibility";

/** One refund per dialog: a replay collapses on `Refund.dedupeKey @unique`, scoped to the admin and the payment. */
function paymentRefundKey(
  actorUserId: string,
  paymentId: string,
  idempotencyKey: string,
): string {
  return `admin-refund:${actorUserId}:${paymentId}:${idempotencyKey}`;
}

const RefundFiltersSchema = z.object({
  status: z.nativeEnum(RefundStatus).optional(),
  gateway: z.nativeEnum(PaymentGateway).optional(),
  search: z.string().trim().max(200).optional(),
});

/** Allowlist: gateway metadata and failure text never leave the server. */
const REFUND_LIST_SELECT = {
  id: true,
  refundId: true,
  amountPaise: true,
  currency: true,
  status: true,
  reason: true,
  paymentGateway: true,
  createdAt: true,
  payment: {
    select: {
      id: true,
      paymentIntent: true,
      user: { select: { id: true, name: true, email: true } },
      appointment: { select: BOOKING_TITLE_SELECT },
    },
  },
} satisfies Prisma.RefundSelect;

export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("refunds.read");
    if (auth.error) return auth.error;

    const searchParams = req.nextUrl.searchParams;
    const filters = RefundFiltersSchema.safeParse({
      status: searchParams.get("status") || undefined,
      gateway: searchParams.get("gateway") || undefined,
      search: searchParams.get("search") || undefined,
    });
    if (!filters.success) {
      return NextResponse.json(
        { error: "Invalid query parameters", code: "INVALID_QUERY" },
        { status: 400 },
      );
    }
    const { status, gateway, search } = filters.data;
    const { page, limit, skip } = readPageParams(searchParams);

    const where: Prisma.RefundWhereInput = {
      ...(status ? { status } : {}),
      ...(gateway ? { paymentGateway: gateway } : {}),
      ...(search
        ? { refundId: { contains: search, mode: "insensitive" } }
        : {}),
    };

    // The status counts are dashboard-wide, unfiltered by search or gateway.
    const [rows, total, pendingCount, succeededCount, failedCount] =
      await Promise.all([
        prisma.refund.findMany({
          relationLoadStrategy: "join",
          where,
          skip,
          take: limit,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: REFUND_LIST_SELECT,
        }),
        prisma.refund.count({ where }),
        prisma.refund.count({ where: { status: "PENDING" } }),
        prisma.refund.count({ where: { status: "SUCCEEDED" } }),
        prisma.refund.count({ where: { status: "FAILED" } }),
      ]);

    // Field by field, so the body is the allowlist whatever the row carries.
    const refunds = rows.map(({ payment, ...r }): RefundListItem => ({
      id: r.id,
      refundId: r.refundId,
      amountPaise: Number(r.amountPaise),
      currency: r.currency,
      status: r.status,
      reason: r.reason,
      paymentGateway: r.paymentGateway,
      createdAt: r.createdAt.toISOString(),
      payment: payment && {
        id: payment.id,
        paymentIntent: payment.paymentIntent,
        buyer: payment.user && {
          id: payment.user.id,
          name: payment.user.name,
          email: payment.user.email,
        },
        booking: bookingRefOf(payment.appointment),
      },
    }));

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

      const { paymentId } = body;
      if (paymentId) {
        const dedupeKey = paymentRefundKey(
          actor.userId,
          paymentId,
          body.idempotencyKey,
        );
        // The issue door's eligibility: a free seat, a spent credit or a live dispute never reaches the writer.
        await assertRefundDoorOpen(paymentId, dedupeKey, body.amountPaise);
        const result = await refundBookingPayment({
          paymentId,
          amountPaise: body.amountPaise,
          reason: `admin refund: ${body.reason}`,
          initiatedByUserId: actor.userId,
          dedupeKey,
          // A partial admin refund is not a cancellation; one that returns the rest ends the seat.
          keepSeatIfPartial: true,
          settlesOwedByHand: true,
        }).catch((err: unknown) =>
          refundInFlightOr(err, dedupeKey, {
            paymentId,
            amountPaise: body.amountPaise,
          }),
        );
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
      amountPaise: async (body, { actor }) => {
        if (body.paymentId) {
          // A refund the door would refuse is never held for a second admin.
          await assertRefundDoorOpen(
            body.paymentId,
            paymentRefundKey(actor.userId, body.paymentId, body.idempotencyKey),
            body.amountPaise,
          );
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
