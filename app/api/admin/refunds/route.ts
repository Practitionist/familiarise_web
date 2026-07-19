import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, RefundStatus, PaymentGateway } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import {
  refundPayment,
  RefundValidationError,
  RefundGatewayError,
} from "@/lib/payments/operations/refund";
import { refundWholeEventPayments } from "@/lib/payments/operations/event-refunds";

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
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Admin refunds list error:", error);
    return NextResponse.json(
      { error: "Failed to fetch refunds" },
      { status: 500 },
    );
  }
}

// Admin-initiated refund (#776 §C). Exactly one target: a single payment, or a
// whole class/webinar (every attendee). Single payments credit the gateway via
// refundPayment; events fan out through the reversal engine (org-funded seats
// reverse in-ledger, card seats credit the gateway).
const RefundBodySchema = z
  .object({
    paymentId: z.string().min(1).optional(),
    classId: z.string().min(1).optional(),
    webinarId: z.string().min(1).optional(),
    amountPaise: z.number().int().positive().optional(),
    reason: z.string().min(1).max(500),
  })
  .refine(
    (b) =>
      [b.paymentId, b.classId, b.webinarId].filter(Boolean).length === 1,
    { message: "Provide exactly one of paymentId, classId, webinarId" },
  )
  .refine((b) => !(b.amountPaise && (b.classId || b.webinarId)), {
    message: "amountPaise applies only to a single paymentId refund",
  });

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Malformed JSON request body" },
        { status: 400 },
      );
    }
    const parsed = RefundBodySchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request" },
        { status: 400 },
      );
    }
    const body = parsed.data;
    const initiatedByUserId = auth.session?.user?.id ?? null;

    if (body.paymentId) {
      const result = await refundPayment({
        paymentId: body.paymentId,
        amountPaise: body.amountPaise,
        reason: `admin refund: ${body.reason}`,
        initiatedByUserId,
      });
      return NextResponse.json({ kind: "payment", result });
    }

    const eventKind = body.classId ? "class" : "webinar";
    const eventId = (body.classId ?? body.webinarId)!;
    const summary = await refundWholeEventPayments(
      eventKind,
      eventId,
      `admin whole-event refund: ${body.reason}`,
      initiatedByUserId,
    );
    return NextResponse.json({ kind: eventKind, summary });
  } catch (error) {
    // Validation / gateway errors carry a caller-actionable message + code.
    if (
      error instanceof RefundValidationError ||
      error instanceof RefundGatewayError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error instanceof RefundValidationError ? 400 : 502 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Admin refund error:", error);
    return NextResponse.json({ error: "Refund failed" }, { status: 500 });
  }
}
