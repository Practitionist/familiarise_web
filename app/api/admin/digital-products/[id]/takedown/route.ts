import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";

/**
 * Take a digital product down: off sale and downloads blocked for buyers.
 * Refunds go through the existing admin refund door.
 */
export const POST = withOpsAction(
  "moderation.manage",
  "digitalProduct.takedown",
  {},
  {
    mode: "tx",
    run: async (tx, { params, body }) => {
      const now = new Date();
      const taken = await tx.digitalProduct.updateMany({
        where: { id: params.id, takenDownAt: null },
        data: {
          takenDownAt: now,
          takedownReason: body.reason,
          status: "ARCHIVED",
          archivedAt: now,
        },
      });
      if (taken.count === 0) {
        const exists = await tx.digitalProduct.count({
          where: { id: params.id },
        });
        throw exists
          ? new OpsRefusal(
              "ALREADY_TAKEN_DOWN",
              "This product is already down.",
            )
          : new OpsRefusal("NOT_FOUND", "No such product.", 404);
      }
      await tx.digitalProductReport.updateMany({
        where: { productId: params.id, resolvedAt: null },
        data: { resolvedAt: now },
      });
      return {
        target: { kind: "DigitalProduct", id: params.id },
        before: { takenDownAt: null },
        after: { takenDownAt: now.toISOString() },
        response: { id: params.id, takenDownAt: now.toISOString() },
      };
    },
  },
);
