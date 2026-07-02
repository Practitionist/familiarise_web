import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { resolveOrgScope } from "@/lib/api/scope/parse";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { consulteeId } = await params;
    const { searchParams } = new URL(request.url);

    if (
      !isPrivileged(session.user.role) &&
      session.user.consulteeProfileId !== consulteeId
    ) {
      return forbiddenResponse("You can only access your own payment history");
    }

    if (!consulteeId) {
      return NextResponse.json(
        { error: "Consultee ID is required" },
        { status: 400 },
      );
    }

    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { userId: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const userId = consulteeProfile.userId;

    // #674 org-scope filter. Payment.organizationId is populated by the
    // backfill so an Acme + Zeta consultee's payment history correctly
    // splits per org context. Personal scope = pre-org-tagging history.
    const callerMemberships = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: { organizationId: true, status: true },
    });
    const scopeResolution = resolveOrgScope({
      raw: searchParams.get("orgScope"),
      memberships: callerMemberships,
      userRole: session.user.role,
      // Self-scoped consultee endpoint.
      allowAllForOwner: true,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        { status: scopeResolution.status },
      );
    }
    const orgFilter =
      scopeResolution.scope.kind === "personal"
        ? { organizationId: null }
        : scopeResolution.scope.kind === "org"
          ? { organizationId: scopeResolution.scope.orgId }
          : {};

    // Per-Payment invoices stay out of this response since the v0 lockdown
    // (#768) — v1.1 re-introduces a per-Payment invoice flow.
    const [payments, credits, creditUsages] = await Promise.all([
      // All payments for this user, scoped to the selected org context
      prisma.payment.findMany({
        where: { userId, ...orgFilter },
        include: {
          appointment: {
            select: {
              appointmentType: true,
              consultation: {
                select: {
                  consultationPlan: { select: { title: true } },
                },
              },
              subscription: {
                select: {
                  subscriptionPlan: { select: { title: true } },
                },
              },
              webinar: {
                select: {
                  webinarPlan: { select: { title: true } },
                },
              },
              class: {
                select: {
                  classPlan: { select: { title: true } },
                },
              },
            },
          },
          discountCode: {
            select: {
              code: true,
              discountType: true,
              discountValue: true,
            },
          },
          // #776 — refund visibility. Without this a cancelled-with-refund
          // booking reads "SUCCEEDED" in the payment history forever.
          refunds: {
            where: { deletedAt: null },
            select: {
              id: true,
              amountPaise: true,
              status: true,
              reason: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
          },
        },
        orderBy: { createdAt: "desc" },
      }),

      // Referral credits
      prisma.referralCredit.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),

      // Credit usages
      prisma.referralCreditUsage.findMany({
        where: { credit: { userId } },
        include: {
          credit: { select: { source: true } },
          payment: {
            select: {
              id: true,
              amount: true,
              currency: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // Transform payments to include plan title
    const transformedPayments = payments.map((p) => {
      const apt = p.appointment;
      const planTitle =
        apt?.consultation?.consultationPlan?.title ??
        apt?.subscription?.subscriptionPlan?.title ??
        apt?.webinar?.webinarPlan?.title ??
        apt?.class?.classPlan?.title ??
        "Payment";

      // BigInt → Number at the serialization boundary; refund amounts are
      // paise like Payment.amount.
      const refunds = p.refunds.map((r) => ({
        id: r.id,
        amountPaise: Number(r.amountPaise),
        status: r.status,
        reason: r.reason,
        createdAt: r.createdAt,
      }));
      const refundedPaise = refunds
        .filter((r) => r.status === "SUCCEEDED")
        .reduce((sum, r) => sum + r.amountPaise, 0);
      // Derived display status — the PaymentStatus enum has no REFUNDED
      // value (refunds live on the relation), so the UI-facing status is
      // computed here: full refund wins over partial, and only SUCCEEDED
      // payments can read as refunded.
      const displayStatus =
        p.paymentStatus === "SUCCEEDED" && refundedPaise > 0
          ? refundedPaise >= Number(p.amount)
            ? "REFUNDED"
            : "PARTIALLY_REFUNDED"
          : p.paymentStatus;

      return {
        id: p.id,
        amount: p.amount,
        originalAmount: p.originalAmount,
        taxAmount: p.taxAmount,
        currency: p.currency,
        status: p.paymentStatus,
        paymentMethod: p.paymentMethod,
        paymentGateway: p.paymentGateway,
        appointmentType: apt?.appointmentType || null,
        planTitle,
        // Org-funding marker — drives the "Sponsored · <Org>" badge on
        // the consultee payments table row. Same convention as the
        // appointments + home surfaces. Populated by the #674 backfill.
        organizationId: p.organizationId,
        discount: p.discountCode
          ? {
              code: p.discountCode.code,
              type: p.discountCode.discountType,
              value: p.discountCode.discountValue,
            }
          : null,
        refunds,
        refundedPaise,
        displayStatus,
        receiptUrl: p.receiptUrl,
        expiresAt: p.expiresAt,
        createdAt: p.createdAt,
      };
    });

    // Calculate credit summary
    const totalCredits = credits.reduce((sum, c) => sum + c.amount, 0);
    const usedCredits = credits.reduce((sum, c) => sum + c.usedAmount, 0);
    const remainingCredits = credits.reduce(
      (sum, c) => sum + c.remainingAmount,
      0,
    );

    return NextResponse.json({
      data: {
        payments: transformedPayments,
        credits,
        creditUsages,
        creditSummary: {
          total: totalCredits,
          used: usedCredits,
          remaining: remainingCredits,
        },
      },
      success: true,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "dashboard" } });
    console.error("Error fetching consultee payments:", error);
    return NextResponse.json(
      { error: "Failed to fetch payments" },
      { status: 500 },
    );
  }
}
