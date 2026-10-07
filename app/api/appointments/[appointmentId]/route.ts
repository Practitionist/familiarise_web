/**
 * Appointment detail for the detail page. Authz is the shared participation
 * gate (capability, not UserRole) + platform ADMIN/STAFF; no org-party
 * surface here — an org operator's grant never widens read access (ADR 20).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { AppointmentIdParams } from "@/schemas/support";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import {
  authorizeAppointment,
  appointmentAuthzError,
} from "@/lib/api/appointment-access";
import { stageBell } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";

const DETAIL_ROUTE = "appointments.detail";

const patchRequestNotesSchema = z.object({
  requestNotes: z.string().trim().max(2000).nullable(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const id = await parseRouteParams(AppointmentIdParams, params, {
    route: DETAIL_ROUTE,
  });
  if (!id.ok) return id.response;
  const { appointmentId } = id.data;
  try {
    const auth = await authorizeAppointment(appointmentId);
    if ("code" in auth) {
      return appointmentAuthzError(auth, {
        route: DETAIL_ROUTE,
        appointmentId,
      });
    }
    return NextResponse.json({ data: auth.detail });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: DETAIL_ROUTE, action: "get", appointmentId },
    });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const id = await parseRouteParams(AppointmentIdParams, params, {
    route: DETAIL_ROUTE,
  });
  if (!id.ok) return id.response;
  const { appointmentId } = id.data;

  try {
    const auth = await authorizeAppointment(appointmentId);
    if ("code" in auth) {
      return appointmentAuthzError(auth, {
        route: DETAIL_ROUTE,
        appointmentId,
      });
    }

    const parsed = patchRequestNotesSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: DETAIL_ROUTE, action: "patch", appointmentId },
      });
    }

    const { appointment } = auth.detail;
    const hasSucceededPayment = appointment.payment.some(
      (p) => p.paymentStatus === "SUCCEEDED",
    );
    if (hasSucceededPayment) {
      return NextResponse.json(
        { error: "Paid bookings cannot modify request notes." },
        { status: 409 },
      );
    }

    const consultation = appointment.consultation;
    const subscription = appointment.subscription;

    if (consultation) {
      if (consultation.requestedBy.userId !== auth.userId) {
        return supportError({
          status: 403,
          code: "FORBIDDEN",
          context: { route: DETAIL_ROUTE, action: "patch", appointmentId },
        });
      }
      const consultantUserId =
        consultation.consultationPlan.consultantProfile.userId;
      const consultantProfileId =
        consultation.consultationPlan.consultantProfile.id;
      const updated = await prisma.$transaction(async (tx) => {
        const res = await tx.consultation.updateMany({
          where: {
            id: consultation.id,
            status: "PENDING",
            appointment: {
              is: { payment: { none: { paymentStatus: "SUCCEEDED" } } },
            },
          },
          data: { requestNotes: parsed.data.requestNotes },
        });
        if (res.count > 0 && consultantUserId) {
          await stageBell(tx, {
            workflowId: NOVU_WORKFLOWS.NEW_BOOKING_REQUEST,
            recipients: [consultantUserId],
            payload: {
              consulteeName:
                consultation.requestedBy.user.name ?? "A consultee",
              planTitle: consultation.consultationPlan.title,
              appointmentType: "Consultation",
              dashboardUrl: `/dashboard/consultant/${consultantProfileId}/requests`,
            },
            dedupeKey: `request-notes-updated:${appointmentId}:${Date.now()}`,
          });
        }
        return res;
      });
      if (updated.count === 0) {
        return NextResponse.json(
          { error: "Request can only be edited while pending approval." },
          { status: 409 },
        );
      }
      return NextResponse.json({
        data: { requestNotes: parsed.data.requestNotes },
      });
    }

    if (subscription) {
      if (subscription.requestedBy.userId !== auth.userId) {
        return supportError({
          status: 403,
          code: "FORBIDDEN",
          context: { route: DETAIL_ROUTE, action: "patch", appointmentId },
        });
      }
      const consultantUserId =
        subscription.subscriptionPlan.consultantProfile.userId;
      const consultantProfileId =
        subscription.subscriptionPlan.consultantProfile.id;
      const updated = await prisma.$transaction(async (tx) => {
        const res = await tx.subscription.updateMany({
          where: {
            id: subscription.id,
            status: "PENDING",
            appointment: {
              is: { payment: { none: { paymentStatus: "SUCCEEDED" } } },
            },
          },
          data: { requestNotes: parsed.data.requestNotes },
        });
        if (res.count > 0 && consultantUserId) {
          await stageBell(tx, {
            workflowId: NOVU_WORKFLOWS.NEW_BOOKING_REQUEST,
            recipients: [consultantUserId],
            payload: {
              consulteeName:
                subscription.requestedBy.user.name ?? "A consultee",
              planTitle: subscription.subscriptionPlan.title,
              appointmentType: "Subscription",
              dashboardUrl: `/dashboard/consultant/${consultantProfileId}/requests`,
            },
            dedupeKey: `request-notes-updated:${appointmentId}:${Date.now()}`,
          });
        }
        return res;
      });
      if (updated.count === 0) {
        return NextResponse.json(
          { error: "Request can only be edited while pending approval." },
          { status: 409 },
        );
      }
      return NextResponse.json({
        data: { requestNotes: parsed.data.requestNotes },
      });
    }

    return NextResponse.json(
      { error: "This booking type does not support request notes." },
      { status: 400 },
    );
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: DETAIL_ROUTE, action: "patch", appointmentId },
    });
  }
}
