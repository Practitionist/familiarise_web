/**
 * Admin Earnings API
 * View all consultant earnings
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { EarningStatus } from "@prisma/client";
import { z } from "zod";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readOffsetParams } from "@/lib/backoffice/list-paging";
import { BOOKING_TITLE_SELECT, bookingRefOf } from "@/lib/data/booking-title";

/**
 * GET /api/admin/earnings
 * Get all earnings with optional status filter
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("payouts.read");
    if (auth.error) return auth.error;

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    // An unknown status reads as no filter, as it always has.
    const status =
      z.nativeEnum(EarningStatus).safeParse(searchParams.get("status")).data ??
      null;
    const { limit, offset } = readOffsetParams(searchParams);

    // #1771 K-3 — the Earnings tab filters by consultant and payment too.
    const consultantProfileId = searchParams.get("consultantProfileId");
    const paymentId = searchParams.get("paymentId");
    const where = {
      ...(status ? { status } : {}),
      ...(consultantProfileId ? { consultantProfileId } : {}),
      ...(paymentId ? { paymentId } : {}),
    };

    // Get earnings
    const [rows, total] = await Promise.all([
      prisma.consultantEarnings.findMany({
        relationLoadStrategy: "join",
        where,
        include: {
          // #946 allowlist — this route is requirePrivilegedAuth, so STAFF read
          // it. A bare `include:` handed every support agent the consultant's
          // panNumber and ibanOrAccount.
          consultantProfile: {
            select: {
              ...consultantPublicScalars,
              user: { select: { name: true, email: true } },
            },
          },
          payment: {
            select: {
              id: true,
              amount: true,
              currency: true,
              user: { select: { id: true, name: true, email: true } },
              appointment: { select: BOOKING_TITLE_SELECT },
            },
          },
          payout: {
            select: {
              id: true,
              status: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.consultantEarnings.count({ where }),
    ]);
    const earnings = rows.map(({ payment, ...r }) => ({
      ...r,
      payment: payment && {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        buyer: payment.user,
        booking: bookingRefOf(payment.appointment),
      },
    }));

    return NextResponse.json(
      {
        earnings,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Error fetching earnings:", error);
    return NextResponse.json(
      { error: "Failed to fetch earnings" },
      { status: 500 },
    );
  }
}
