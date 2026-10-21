import { NextRequest } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { assertMoneyDoorsOpen } from "@/lib/backoffice/maintenance-gate";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  grantPlatformCancel,
  platformCancelCharges,
} from "@/lib/booking/platform-cancel";
import { assertBoundedRefund } from "@/lib/support/money-policy";
import { CancellationReasonEnum } from "@/schemas/enums";
import { UserRoleEnum } from "@/schemas/user";
import { POST as cancelAppointment } from "@/app/api/appointments/[appointmentId]/cancel/route";

const Params = z.object({ appointmentId: z.string().uuid() });

const CancelRefusal = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
});

/**
 * A platform cancel by an operator who is not a party to the booking. It runs
 * the participant cancel route under a one-request grant, after the bounded
 * refund policy priced the refunds the cancel will send.
 */
export const POST = withOpsAction(
  "appointments.cancelForPlatform",
  "appointment.cancel.platform",
  {
    cancellationReason: CancellationReasonEnum.optional(),
    notes: z.string().max(2000).optional(),
    expectedRefundPaise: z.number().int().nonnegative().safe(),
    expectedCreditRestoresInFull: z.boolean().optional(),
  },
  {
    mode: "gateway",
    target: ({ params }) => ({ kind: "Appointment", id: params.appointmentId }),
    run: async ({ body, actor, params, opsActionId }) => {
      const { appointmentId } = Params.parse(params);
      await assertMoneyOpsBudget(actor.userId);
      await assertMoneyDoorsOpen();
      const charges = await platformCancelCharges(
        appointmentId,
        body.expectedRefundPaise,
      );
      await assertBoundedRefund(
        prisma,
        { userId: actor.userId, role: UserRoleEnum.parse(actor.role) },
        charges,
      );
      const request = new NextRequest(
        `https://internal.invalid/api/appointments/${appointmentId}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reason: body.cancellationReason,
            notes: body.notes,
            expectedRefundPaise: body.expectedRefundPaise,
            expectedCreditRestoresInFull: body.expectedCreditRestoresInFull,
          }),
        },
      );
      grantPlatformCancel(request, opsActionId);
      const response = await cancelAppointment(request, {
        params: Promise.resolve({ appointmentId }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const refusal = CancelRefusal.safeParse(payload);
        throw new OpsRefusal(
          (refusal.success && refusal.data.code) || "CANCEL_REFUSED",
          (refusal.success && refusal.data.error) ||
            "The booking could not be cancelled.",
          response.status,
        );
      }
      return {
        target: { kind: "Appointment", id: appointmentId },
        after: {
          paymentIds: charges.map((charge) => charge.paymentId),
          movedPaise: charges.reduce((sum, charge) => sum + charge.newPaise, 0),
        },
        response: { data: payload },
      };
    },
  },
  { stepUp: true },
);
