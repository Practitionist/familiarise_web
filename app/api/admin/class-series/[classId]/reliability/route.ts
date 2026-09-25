import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { reliabilityCorrelationId } from "@/lib/backoffice/class-series-read";
import { recordSystemEvent } from "@/lib/enterprise/system-events";

/**
 * #1771 K-6 — apply or clear the host-reliability flag: one more SystemEvent
 * on the class's `class-reliability:` correlation; the latest one decides.
 */
export const POST = withOpsAction(
  "classSeries.support",
  (body) => `class.reliability.${body.state}`,
  { state: z.enum(["apply", "clear"]) },
  {
    mode: "tx",
    run: async (tx, { params, body, opsActionId }) => {
      const correlationId = reliabilityCorrelationId(params.classId);
      const latest = await tx.systemEvent.findFirst({
        where: { correlationId },
        orderBy: { createdAt: "desc" },
        select: { context: true },
      });
      const active =
        !!latest &&
        (latest.context as { cleared?: unknown } | null)?.cleared !== true;
      if (active === (body.state === "apply")) {
        throw new OpsRefusal(
          "FLAG_UNCHANGED",
          active ? "The flag is already on." : "The flag is not on.",
        );
      }
      await recordSystemEvent({
        category: "BOOKING",
        severity: body.state === "apply" ? "WARN" : "INFO",
        message: `Class ${params.classId} reliability flag ${body.state === "apply" ? "applied" : "cleared"} by an operator`,
        context: {
          ...(body.state === "clear" ? { cleared: true } : { applied: true }),
          opsActionId,
        },
        correlationId,
        db: tx,
        strict: true,
      });
      return {
        target: { kind: "Class", id: params.classId },
        before: { active },
        after: { active: !active },
        response: { active: !active },
      };
    },
  },
);
