import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { BOOKING_TITLE_SELECT, bookingRefOf } from "@/lib/data/booking-title";
import {
  ADMIN_DIGITAL_PRODUCT_PURCHASE_SELECT,
  ADMIN_DISPUTE_SELECT,
  ADMIN_REFUND_SELECT,
  CONSUMER_INVOICE_SUMMARY_SELECT,
  DISCOUNT_CODE_SUMMARY_SELECT,
  FUNDING_LEG_SUMMARY_SELECT,
} from "@/lib/data/payments-select";

interface RouteParams {
  params: Promise<{
    paymentId: string;
  }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireBackofficeSurface("payments.read");
    if (auth.error) return auth.error;

    const resolvedParams = await params;

    // Allowlist: the payer instrument hashes, idempotency keys and refund-owed notes stay on the server.
    const row = await prisma.payment.findUnique({
      relationLoadStrategy: "join",
      where: { id: resolvedParams.paymentId },
      select: {
        id: true,
        amount: true,
        originalAmount: true,
        taxAmount: true,
        welcomeDiscountPaise: true,
        currency: true,
        description: true,
        receiptUrl: true,
        paymentMethod: true,
        paymentIntent: true,
        paymentGateway: true,
        paymentStatus: true,
        isMockPayment: true,
        expiresAt: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        appointment: { select: BOOKING_TITLE_SELECT },
        discountCode: { select: DISCOUNT_CODE_SUMMARY_SELECT },
        // Explicit selects, for two reasons. A bare `include` returns whatever
        // the model happens to carry, which is how the detail page came to read
        // `refund.amount` — a name neither model has — and render "₹NaN" from
        // `undefined / 100`. Naming the columns makes that a type error at the
        // boundary instead of a runtime NaN.
        //
        // It also stops shipping the whole row to the browser. `Dispute` holds
        // `internalNotes` and `evidence`, and `Refund` holds `metadata` and
        // `failureReason`; none of it is rendered, and operator notes on a
        // chargeback are not something to hand out because the page happened
        // to over-fetch. The shapes live in lib/data/payments-select.ts so the
        // buyer-facing history cannot drift away from this boundary.
        refunds: {
          orderBy: { createdAt: "desc" },
          select: ADMIN_REFUND_SELECT,
        },
        disputes: {
          orderBy: { createdAt: "desc" },
          select: ADMIN_DISPUTE_SELECT,
        },
        consumerInvoice: { select: CONSUMER_INVOICE_SUMMARY_SELECT },
        legs: { select: FUNDING_LEG_SUMMARY_SELECT },
        digitalProductPurchase: {
          select: ADMIN_DIGITAL_PRODUCT_PURCHASE_SELECT,
        },
      },
    });

    if (!row) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    const { appointment, ...payment } = row;
    return NextResponse.json({
      ...payment,
      appointment: appointment && {
        id: appointment.id,
        appointmentType: appointment.appointmentType,
      },
      booking: bookingRefOf(appointment),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Admin payment details error:", error);
    return NextResponse.json(
      { error: "Failed to fetch payment details" },
      { status: 500 },
    );
  }
}
