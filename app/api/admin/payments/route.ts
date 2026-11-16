import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  AppointmentsType,
  PaymentGateway,
  PaymentStatus,
  Prisma,
} from "@prisma/client";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readPageParams } from "@/lib/backoffice/list-paging";
import type { PaymentListItem } from "@/lib/backoffice/money-list-schemas";
import { BOOKING_TITLE_SELECT, bookingRefOf } from "@/lib/data/booking-title";

const FiltersSchema = z.object({
  status: z.nativeEnum(PaymentStatus).optional(),
  gateway: z.nativeEnum(PaymentGateway).optional(),
  appointmentType: z.nativeEnum(AppointmentsType).optional(),
  search: z.string().trim().max(200).optional(),
  orgId: z.string().trim().max(128).optional(),
});

/** Allowlist: the payer instrument hashes, metadata and refund-owed notes never leave the server. */
const PAYMENT_LIST_SELECT = {
  id: true,
  amount: true,
  currency: true,
  paymentIntent: true,
  paymentGateway: true,
  paymentStatus: true,
  isMockPayment: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true } },
  appointment: { select: BOOKING_TITLE_SELECT },
  consumerInvoice: {
    select: { id: true, invoiceNumber: true, issuedAt: true },
  },
} satisfies Prisma.PaymentSelect;

export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("payments.read");
    if (auth.error) return auth.error;

    const searchParams = req.nextUrl.searchParams;
    const filters = FiltersSchema.safeParse({
      status: searchParams.get("status") || undefined,
      gateway: searchParams.get("gateway") || undefined,
      appointmentType: searchParams.get("appointmentType") || undefined,
      search: searchParams.get("search") || undefined,
      orgId: searchParams.get("orgId") || undefined,
    });
    if (!filters.success) {
      return NextResponse.json(
        { error: "Invalid query parameters", code: "INVALID_QUERY" },
        { status: 400 },
      );
    }
    const { status, gateway, appointmentType, search, orgId } = filters.data;
    const { page, limit, skip } = readPageParams(searchParams);

    const where: Prisma.PaymentWhereInput = {
      ...(status ? { paymentStatus: status } : {}),
      ...(gateway ? { paymentGateway: gateway } : {}),
      ...(search
        ? { paymentIntent: { contains: search, mode: "insensitive" } }
        : {}),
      ...(appointmentType ? { appointment: { appointmentType } } : {}),
      // A support drill into one tenant's payments.
      ...(orgId ? { organizationId: orgId } : {}),
    };

    // One joined list read and one count, whatever the page names.
    const [rows, total] = await Promise.all([
      prisma.payment.findMany({
        relationLoadStrategy: "join",
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: PAYMENT_LIST_SELECT,
      }),
      prisma.payment.count({ where }),
    ]);

    // Field by field, so the body is the allowlist whatever the row carries.
    const payments = rows.map((p): PaymentListItem => ({
      id: p.id,
      amount: Number(p.amount),
      currency: p.currency,
      paymentIntent: p.paymentIntent,
      paymentGateway: p.paymentGateway,
      paymentStatus: p.paymentStatus,
      isMockPayment: p.isMockPayment,
      createdAt: p.createdAt.toISOString(),
      buyer: p.user && {
        id: p.user.id,
        name: p.user.name,
        email: p.user.email,
      },
      booking: bookingRefOf(p.appointment),
      consumerInvoice: p.consumerInvoice && {
        id: p.consumerInvoice.id,
        invoiceNumber: p.consumerInvoice.invoiceNumber,
        issuedAt: p.consumerInvoice.issuedAt.toISOString(),
      },
    }));

    return NextResponse.json({
      payments,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Admin payments list error:", error);
    return NextResponse.json(
      { error: "Failed to fetch payments" },
      { status: 500 },
    );
  }
}
