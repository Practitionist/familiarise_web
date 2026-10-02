import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { restoreClassSeatCredits } from "@/lib/payments/operations/booking-refund";

/** 400 copy for a missing/malformed `idempotencyKey` (via withOpsAction). */
const KEY_REQUIRED_COPY =
  "idempotencyKey is required and must be a UUID — send the per-dialog key the refund dialog already mints. Without it this door cannot tell a double-click from a second refund, and would mint a fresh one instead, leaving the unique dedupe column inert.";

/**
 * #1771 K-5 — "Return N sessions of credits" for a credit-funded class seat:
 * the credits rail restores whole or not at all, so partial returns are ops'.
 */
export const POST = withOpsAction(
  "refunds.manage",
  "refund.credits",
  {
    paymentId: z.string().min(1),
    /**
     * Required, never defaulted: `Refund.dedupeKey @unique` collapses a
     * double-click only when the key is caller-minted. One key per dialog.
     */
    idempotencyKey: z
      .string({
        required_error: KEY_REQUIRED_COPY,
        invalid_type_error: KEY_REQUIRED_COPY,
      })
      .uuid(KEY_REQUIRED_COPY),
    sessions: z.number().int().min(1).max(500),
  },
  {
    mode: "gateway",
    target: ({ body }) => ({ kind: "Payment", id: body.paymentId }),
    run: async ({ body, actor }) => {
      await assertMoneyOpsBudget(actor.userId);
      const result = await restoreClassSeatCredits({
        paymentId: body.paymentId,
        sessions: body.sessions,
        reason: `ops credit return: ${body.reason}`,
        initiatedByUserId: actor.userId,
        // Namespaced under `credits:` so this key can never collide with an
        // issue door's bare `ops:<uuid>`: a validated UUID has no colon, so
        // `ops:<uuid>` never equals `ops:credits:<uuid>`.
        dedupeKey: `ops:credits:${body.idempotencyKey}`,
      });
      return {
        target: { kind: "Payment", id: body.paymentId },
        after: { ...result, sessions: body.sessions },
        response: { result },
      };
    },
  },
);
