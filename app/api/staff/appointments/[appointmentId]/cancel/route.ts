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
import {
  assertBoundedRefund,
  lockStaffRefunds,
  type RefundCharge,
} from "@/lib/support/money-policy";
import { CancellationReasonEnum } from "@/schemas/enums";
import { UserRoleEnum } from "@/schemas/user";
import { POST as cancelAppointment } from "@/app/api/appointments/[appointmentId]/cancel/route";

const Params = z.object({ appointmentId: z.string().uuid() });

const REFUND_PREVIEW_MESSAGE =
  "Open the cancel preview to see the refund, then confirm the cancel.";

const Body = z.object({
  cancellationReason: CancellationReasonEnum.optional(),
  notes: z.string().max(2000).optional(),
  expectedRefundPaise: z
    .number({
      required_error: REFUND_PREVIEW_MESSAGE,
      invalid_type_error: REFUND_PREVIEW_MESSAGE,
    })
    .int()
    .nonnegative()
    .safe(),
  expectedCreditRestoresInFull: z.boolean().optional(),
  expectedPaid: z.boolean().optional(),
});

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
  Body.shape,
  {
    mode: "gateway",
    target: ({ params }) => ({ kind: "Appointment", id: params.appointmentId }),
    run: async ({ body, actor, params, opsActionId }) => {
      const { appointmentId } = Params.parse(params);
      await assertMoneyOpsBudget(actor.userId);
      await assertMoneyDoorsOpen();
      const operator = {
        userId: actor.userId,
        role: UserRoleEnum.parse(actor.role),
      };
      const release = await lockStaffRefunds(operator);
      const charges = await platformCancelCharges(
        appointmentId,
        body.expectedRefundPaise,
      )
        .then(async (priced) => {
          await assertBoundedRefund(prisma, operator, priced);
          return priced;
        })
        .catch(async (error: unknown) => {
          await release();
          throw error;
        });
      // Once the cancel route ran, money may have moved: an unknown outcome
      // keeps the lock to its TTL rather than let another refund pass uncounted.
      return cancelUnderGrant(
        appointmentId,
        body,
        charges,
        opsActionId,
        release,
      );
    },
  },
  { stepUp: true },
);

async function cancelUnderGrant(
  appointmentId: string,
  body: z.infer<typeof Body>,
  charges: RefundCharge[],
  opsActionId: string,
  release: () => Promise<void>,
) {
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
        expectedPaid: body.expectedPaid,
      }),
    },
  );
  grantPlatformCancel(request, opsActionId);
  const response = await cancelAppointment(request, {
    params: Promise.resolve({ appointmentId }),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    // A 4xx refusal is decided before the cancel commits; a 5xx outcome is unknown.
    if (response.status < 500) await release();
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
      charges: charges.map(({ paymentId, newPaise }) => ({
        paymentId,
        newPaise,
      })),
    },
    response: { data: payload },
    afterCommit: release,
  };
}
