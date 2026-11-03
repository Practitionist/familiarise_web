import { NextRequest } from "next/server";
import { z } from "zod";

import { assertBookingDoorsOpen } from "@/lib/backoffice/maintenance-gate";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  grantPlatformReschedule,
  platformRescheduleBefore,
} from "@/lib/booking/platform-reschedule";
import { POST as rescheduleAppointment } from "@/app/api/appointments/[appointmentId]/reschedule/route";

const Params = z.object({ appointmentId: z.string().uuid() });

const Body = z.object({
  /** Sessions of a subscription or class to release; omitted releases every live one. */
  slotIds: z.array(z.string().min(1)).min(1).max(200).optional(),
});

const RescheduleRefusal = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
});

const RescheduleOutcome = z.object({
  rescheduleType: z.string().optional(),
  sessionsAffected: z.number().optional(),
  slotsMoved: z.number().optional(),
  outcome: z.string().optional(),
});

/** The participant route's own history reason is capped at this length. */
const HISTORY_REASON_MAX = 500;

/**
 * A platform reschedule by an operator who is not a party to the booking. It
 * runs the participant reschedule route under a one-request grant, so the
 * appointment lock, the CAS transitions and the notices are that route's own.
 */
export const POST = withOpsAction(
  "appointments.manage",
  "appointment.reschedule.platform",
  Body.shape,
  {
    mode: "gateway",
    target: ({ params }) => ({ kind: "Appointment", id: params.appointmentId }),
    run: async ({ body, params, opsActionId }) => {
      const { appointmentId } = Params.parse(params);
      await assertBookingDoorsOpen();
      const before = await platformRescheduleBefore(appointmentId);
      const request = new NextRequest(
        `https://internal.invalid/api/appointments/${appointmentId}/reschedule`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            slotIds: body.slotIds,
            reason: body.reason.slice(0, HISTORY_REASON_MAX),
          }),
        },
      );
      grantPlatformReschedule(request, opsActionId);
      const response = await rescheduleAppointment(request, {
        params: Promise.resolve({ appointmentId }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const refusal = RescheduleRefusal.safeParse(payload);
        throw new OpsRefusal(
          (refusal.success && refusal.data.code) || "RESCHEDULE_REFUSED",
          (refusal.success && refusal.data.error) ||
            "The booking could not be rescheduled.",
          response.status,
        );
      }
      const outcome = RescheduleOutcome.safeParse(payload);
      return {
        target: { kind: "Appointment", id: appointmentId },
        before,
        after: {
          slotIds: body.slotIds ?? null,
          ...(outcome.success ? outcome.data : {}),
        },
        response: { data: payload },
      };
    },
  },
  { stepUp: true },
);
