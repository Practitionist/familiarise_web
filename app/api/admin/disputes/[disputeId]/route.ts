import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";

interface RouteParams {
  params: Promise<{
    disputeId: string;
  }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const parsedRole = z.nativeEnum(UserRole).safeParse(auth.session.user.role);
    const canManageDisputes =
      parsedRole.success &&
      hasBackofficePermission(parsedRole.data, "disputes.manage");

    const resolvedParams = await params;

    const dispute = await prisma.dispute.findUnique({
      where: { id: resolvedParams.disputeId },
      select: {
        id: true,
        disputeId: true,
        amountPaise: true,
        currency: true,
        status: true,
        reason: true,
        paymentGateway: true,
        paymentId: true,
        dueBy: true,
        isChargeRefundable: true,
        ...(canManageDisputes ? { evidence: true } : {}),
        evidenceSubmittedAt: true,
        createdAt: true,
        updatedAt: true,
        payment: {
          select: {
            id: true,
            paymentIntent: true,
            paymentStatus: true,
            amount: true,
            currency: true,
            paymentMethod: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!dispute) {
      return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    }

    return NextResponse.json(dispute);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Admin dispute details error:", error);
    return NextResponse.json(
      { error: "Failed to fetch dispute details" },
      { status: 500 },
    );
  }
}
