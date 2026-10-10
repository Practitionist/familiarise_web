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
            // Billing contact details follow the evidence gate.
            user: {
              select: {
                id: true,
                name: true,
                ...(canManageDisputes ? { email: true } : {}),
              },
            },
            appointment: {
              select: {
                id: true,
                appointmentType: true,
                createdAt: true,
                occurrences: {
                  where: { deletedAt: null },
                  orderBy: { startsAt: "asc" },
                  select: {
                    id: true,
                    startsAt: true,
                    endsAt: true,
                    completionStatus: true,
                    outcome: true,
                    attendances: {
                      select: {
                        userId: true,
                        firstJoinedAt: true,
                        lastLeftAt: true,
                      },
                    },
                  },
                },
                supportThreads: {
                  orderBy: { createdAt: "desc" },
                  select: {
                    id: true,
                    status: true,
                    category: true,
                    createdAt: true,
                    supportTicket: {
                      select: {
                        id: true,
                        referenceNumber: true,
                        status: true,
                        priority: true,
                        createdAt: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!dispute) {
      return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    }

    const appt = dispute.payment?.appointment ?? null;
    const occurrences = appt?.occurrences ?? [];
    const allAttendances = occurrences.flatMap((o) => o.attendances);
    const supportThreads = appt?.supportThreads ?? [];

    const evidencePack = {
      booking: appt
        ? {
            appointmentId: appt.id,
            appointmentType: appt.appointmentType,
            createdAt: appt.createdAt,
          }
        : null,
      occurrences: {
        total: occurrences.length,
        completedCount: occurrences.filter(
          (o) => o.completionStatus === "COMPLETED",
        ).length,
        outcomes: occurrences.map((o) => ({
          id: o.id,
          startsAt: o.startsAt,
          endsAt: o.endsAt,
          completionStatus: o.completionStatus,
          outcome: o.outcome,
        })),
      },
      attendance: {
        presentCount: allAttendances.length,
        recordsFound: allAttendances.length > 0,
        summary:
          allAttendances.length > 0
            ? `${allAttendances.length} participant attendance telemetry record(s) logged across session occurrences.`
            : "No meeting attendance telemetry records were recorded for this booking.",
      },
      supportHistory: {
        ticketCount: supportThreads.length,
        openCount: supportThreads.filter((t) => t.status !== "RESOLVED").length,
        threads: supportThreads.map((t) => ({
          id: t.id,
          status: t.status,
          category: t.category,
          referenceNumber: t.supportTicket?.referenceNumber ?? null,
          ticketStatus: t.supportTicket?.status ?? null,
          priority: t.supportTicket?.priority ?? null,
          createdAt: t.createdAt,
        })),
      },
    };

    return NextResponse.json({
      ...dispute,
      evidencePack,
    });
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
