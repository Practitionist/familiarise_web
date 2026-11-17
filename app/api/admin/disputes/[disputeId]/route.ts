import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { BOOKING_TITLE_SELECT, bookingRefOf } from "@/lib/data/booking-title";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";

interface RouteParams {
  params: Promise<{
    disputeId: string;
  }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireBackofficeSurface("disputes.read");
    if (auth.error) return auth.error;

    const parsedRole = z.nativeEnum(UserRole).safeParse(auth.session.user.role);
    const canManageDisputes =
      parsedRole.success &&
      hasBackofficePermission(parsedRole.data, "disputes.manage");

    const resolvedParams = await params;

    const dispute = await prisma.dispute.findUnique({
      relationLoadStrategy: "join",
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
        assignedToUserId: true,
        assignedTo: { select: { id: true, name: true } },
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
                ...BOOKING_TITLE_SELECT,
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
                supportCases: {
                  orderBy: { createdAt: "desc" },
                  select: {
                    id: true,
                    status: true,
                    category: true,
                    referenceNumber: true,
                    priority: true,
                    createdAt: true,
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
    const supportCases = appt?.supportCases ?? [];

    const mergedSupportThreads = [
      ...supportCases.map((c) => ({
        id: c.id,
        status: String(c.status),
        category: c.category,
        referenceNumber: c.referenceNumber,
        ticketStatus: c.status,
        priority: c.priority,
        createdAt: c.createdAt,
      })),
    ].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

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
        ticketCount: mergedSupportThreads.length,
        openCount: mergedSupportThreads.filter(
          (item) => item.status !== "RESOLVED" && item.status !== "CLOSED",
        ).length,
        threads: mergedSupportThreads,
      },
    };

    const sanitizedAppointment = appt
      ? {
          id: appt.id,
          appointmentType: appt.appointmentType,
          createdAt: appt.createdAt,
          occurrences: occurrences.map((o) => ({
            id: o.id,
            startsAt: o.startsAt,
            endsAt: o.endsAt,
            completionStatus: o.completionStatus,
            outcome: o.outcome,
          })),
        }
      : null;

    return NextResponse.json({
      ...dispute,
      payment: dispute.payment
        ? {
            ...dispute.payment,
            appointment: sanitizedAppointment,
            booking: bookingRefOf(appt),
          }
        : null,
      evidencePack: canManageDisputes ? evidencePack : null,
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

/** Assignment coordinates the gateway chargeback owner; it does not move money. */
export const PATCH = withOpsAction(
  "disputes.manage",
  "dispute.assign",
  {
    assignedToUserId: z.string().min(1).nullable(),
    expectedUpdatedAt: z.coerce.date(),
  },
  {
    mode: "tx",
    run: async (tx, { body, params }) => {
      const before = await tx.dispute.findUnique({
        where: { id: params.disputeId },
        select: { id: true, assignedToUserId: true, updatedAt: true },
      });
      if (!before) throw new OpsRefusal("NOT_FOUND", "Dispute not found", 404);
      if (body.assignedToUserId) {
        const assignee = await tx.user.findFirst({
          where: { id: body.assignedToUserId, role: "ADMIN", banned: false },
          select: { id: true },
        });
        if (!assignee)
          throw new OpsRefusal(
            "INVALID_ASSIGNEE",
            "Choose an active administrator for gateway chargeback ownership.",
            400,
          );
      }
      const changed = await tx.dispute.updateMany({
        where: {
          id: before.id,
          updatedAt: body.expectedUpdatedAt,
          assignedToUserId: before.assignedToUserId,
        },
        data: { assignedToUserId: body.assignedToUserId },
      });
      if (changed.count !== 1)
        throw new OpsRefusal(
          "CONFLICT",
          "This dispute changed. Refresh it before assigning an owner.",
          409,
        );
      return {
        target: { kind: "Dispute", id: before.id },
        before: { assignedToUserId: before.assignedToUserId },
        after: { assignedToUserId: body.assignedToUserId },
        response: { success: true },
      };
    },
  },
);
