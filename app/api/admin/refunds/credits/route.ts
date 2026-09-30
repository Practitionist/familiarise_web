import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { restoreClassSeatCredits } from "@/lib/payments/operations/booking-refund";

/**
 * Actionable copy for a missing/malformed `idempotencyKey`. Surfaced verbatim
 * by `withOpsAction` as `{ error, code: "INVALID_BODY" }` with a 400 — the
 * route's existing validation convention, so no new pattern is introduced here.
 */
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
     * REQUIRED, and refused when omitted — never defaulted here.
     *
     * Invariant: this door's `Refund.dedupeKey` is a pure function of a
     * caller-minted key, so `Refund.dedupeKey @unique` is what collapses a
     * double-click. The defect was the `?? opsActionId` fallback: a per-request
     * `randomUUID()` is unique on every click BY CONSTRUCTION, so the unique
     * column never fired and one double-click returned twice the credits. A
     * server-minted key is that same inert column, so omission is a 4xx with
     * this message rather than a silently fresh key.
     *
     * One key per dialog: a double-click or a retry reuses the first refund.
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
