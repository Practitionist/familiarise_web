/**
 * POST /api/organizations/[orgId]/appointments/[appointmentId]/allocate
 *
 * Allows an authorized organization governance actor (`OWNER` or `MAINTAINER`,
 * holding `appointments.allocate.calendarRead`) to allocate calendar slots on
 * behalf of the organization for an org-funded 1:1 consultation or subscription
 * booking that is awaiting scheduling.
 *
 * Security & Integrity Guarantees:
 * - Requires active membership with `appointments.allocate.calendarRead`.
 * - Scopes the appointment lookup to `organizationId: orgId` (accepting either
 *   `Appointment.id` or the child `consultationId` / `subscriptionId` surfaced
 *   in the Unscheduled queue).
 * - Verifies `isActForOrgBooking` and `isOrgFundedByOrg` so PERSONAL-rail
 *   bookings merely tagged with the organization cannot be mutated by org
 *   admins.
 * - Delegates slot validation and conflict checks to `SchedulingService.allocate`
 *   with `override: false` (never bypassing the delivering expert's published
 *   availability).
 * - Records an immutable `OrgAuditLog` row with the mandatory `overrideReason`.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { isActForOrgBooking, isOrgFundedByOrg } from "@/lib/booking/org-actor";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { SchedulingService } from "@/utils/scheduling-engine/SchedulingService";

const AllocateOrgBookingBodySchema = z
  .object({
    isAuto: z.boolean().optional().default(true),
    slots: z.array(z.string().datetime()).min(1).optional(),
    overrideReason: z.string().trim().min(5).max(500),
  })
  .superRefine((val, ctx) => {
    if (!val.isAuto && (!val.slots || val.slots.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slots"],
        message: "At least one slot ISO timestamp is required for manual allocation.",
      });
    }
  });

export async function POST(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; appointmentId: string }>;
  },
) {
  const { orgId, appointmentId } = await params;

  const access = await requireOrgAccess(orgId, {
    permission: "appointments.allocate.calendarRead",
    requireActive: true,
  });
  if (access.error) return access.error;

  const rl = await applyRateLimit(
    eventMutationLimiter,
    access.session.user.id,
  );
  if (rl) return rl;

  const raw = await req.json().catch(() => null);
  const parsed = AllocateOrgBookingBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.issues[0]?.message ??
          "Invalid slot allocation request payload.",
        detail: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const appointment = await prisma.appointment.findFirst({
      where: {
        organizationId: orgId,
        OR: [
          { id: appointmentId },
          { consultationId: appointmentId },
          { subscriptionId: appointmentId },
        ],
      },
      select: {
        id: true,
        organizationId: true,
        consultationId: true,
        subscriptionId: true,
      },
    });

    if (!appointment || !isActForOrgBooking(appointment)) {
      return NextResponse.json(
        {
          error: "Appointment not found or not eligible for organization slot allocation.",
          code: "APPOINTMENT_NOT_FOUND",
        },
        { status: 404 },
      );
    }

    const fundedByOrg = await isOrgFundedByOrg(appointment, orgId);
    if (!fundedByOrg) {
      return NextResponse.json(
        {
          error:
            "Only bookings funded by the organization's wallet, invoice, or license rail can be allocated on behalf of the organization.",
          code: "NOT_ORG_FUNDED",
        },
        { status: 403 },
      );
    }

    const eventType = appointment.consultationId
      ? ("consultation" as const)
      : ("subscription" as const);
    const eventId = (appointment.consultationId ?? appointment.subscriptionId)!;
    const mode = body.isAuto ? ("auto" as const) : ("manual" as const);

    const result = await Sentry.startSpan(
      { op: "booking.allocate.org", name: `allocate.org.${eventType}` },
      () =>
        SchedulingService.allocate({
          eventType,
          eventId,
          mode,
          slots: body.slots,
          idempotencyKey: req.headers.get("Idempotency-Key") ?? undefined,
          override: false,
          allowPartial: false,
          topUp: false,
        }),
    );

    if (!result.success) {
      return NextResponse.json(
        {
          error: result.error ?? "Could not allocate slots for this booking.",
          errorCode: result.errorCode,
          placeableSessions: result.placeableSessions,
          requiredSessions: result.requiredSessions,
        },
        { status: result.httpStatus ?? 409 },
      );
    }

    await prisma.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "MEMBER",
        action: AUDIT_ACTIONS.MEMBER.APPOINTMENT_ALLOCATED_FOR_ORG,
        description:
          "Allocated calendar slots for a booking on behalf of the organization",
        details: {
          appointmentId: appointment.id,
          eventType,
          eventId,
          mode,
          slots: body.slots ?? null,
          overrideReason: body.overrideReason,
        },
      },
    });

    return NextResponse.json({
      data: result.appointments,
      warnings: result.warnings,
      partial: result.partial,
      placedSessions: result.placedSessions,
      requiredSessions: result.requiredSessions,
      unplacedSessions: result.unplacedSessions,
    });
  } catch (err) {
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise", route: "org_appointment_allocate" } },
    );
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to allocate slots for organization booking.",
      },
      { status: 500 },
    );
  }
}
