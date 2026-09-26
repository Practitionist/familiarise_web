import { NextRequest } from "next/server";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { hostedForClass } from "@/lib/backoffice/class-doors";
import { POST as cancelAppointment } from "@/app/api/appointments/[appointmentId]/cancel/route";

/**
 * #1771 K-6 — cancel the whole series with refunds. The console runs the one
 * existing path in-process (same session, same CAS, same per-seat series
 * ledgers into refundWholeEventPayments) rather than a second copy of it.
 */
export const POST = withOpsAction(
  "classSeries.money",
  "class.cancel-series",
  {},
  {
    mode: "gateway",
    target: ({ params }) => ({ kind: "Class", id: params.classId }),
    run: async ({ params, body, actor }) => {
      await assertMoneyOpsBudget(actor.userId);
      const hosted = await hostedForClass(params.classId, actor.userId);
      const appointmentId = hosted.appointment.id;
      const res = await cancelAppointment(
        new NextRequest(
          `https://internal.invalid/api/appointments/${appointmentId}/cancel`,
          {
            method: "POST",
            body: JSON.stringify({
              reason: "OTHER",
              notes: `ops: ${body.reason}`,
            }),
          },
        ),
        { params: Promise.resolve({ appointmentId }) },
      );
      const json = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        throw new OpsRefusal(
          typeof json.code === "string" ? json.code : "CANCEL_FAILED",
          typeof json.error === "string"
            ? json.error
            : "The series could not be cancelled.",
          res.status,
        );
      }
      return {
        target: { kind: "Class", id: params.classId },
        after: { appointmentId, eventRefund: summarize(json.eventRefund) },
        response: json,
      };
    },
  },
);

function summarize(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
  return {
    refundsIssued: n("refundsIssued"),
    refundedPaise: n("refundedPaise"),
    failures: Array.isArray(r.failures) ? r.failures.length : 0,
  };
}
