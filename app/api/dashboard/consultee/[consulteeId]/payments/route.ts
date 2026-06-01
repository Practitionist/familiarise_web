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

    const [payments, invoices, credits, creditUsages] = await Promise.all([
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
        },
        orderBy: { createdAt: "desc" },
      }),

      // Personal-consultee per-Payment invoice surface removed in v0
      // lockdown (#768). UI now shows OrganizationInvoice rows for
      // org-funded paths only; PERSONAL consultees can request a
      // receipt from support until v1.1 re-introduces a per-Payment
      // invoice flow. Empty array keeps the response shape stable.
      Promise.resolve([] as const),

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
        discount: p.discountCode
          ? {
              code: p.discountCode.code,
              type: p.discountCode.discountType,
              value: p.discountCode.discountValue,
            }
          : null,
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
        invoices,
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
    console.error("Error fetching consultee payments:", error);
    return NextResponse.json(
      { error: "Failed to fetch payments" },
      { status: 500 },
    );
  }
}
