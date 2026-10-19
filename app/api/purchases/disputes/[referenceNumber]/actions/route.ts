import { NextResponse, type NextRequest } from "next/server";

import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { supportError } from "@/lib/api/support-http";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { isDisputeReference } from "@/lib/support/disputes/reference";
import {
  DisputeActionError,
  DisputeActionSchema,
  performDisputeAction,
} from "@/lib/support/disputes/actions";

interface RouteContext {
  params: Promise<{ referenceNumber: string }>;
}

/**
 * One protocol action.
 *
 * The endpoint is the ONLY way the protocol moves. Everything it does is
 * guarded by the action's own `clientActionId` (idempotency) and
 * `expectedVersion` (optimistic concurrency), so a double-click is one move
 * and a stale operator is told to re-read rather than being allowed to
 * overwrite.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await requireApiAuth({ expectUser: true });
  if (auth.error) return auth.error;

  const limited = await applyRateLimit(
    spamLimiter,
    `dispute-action:${auth.session.user.id}`,
  );
  if (limited) return limited;

  const tooLarge = assertBodySize(req);
  if (tooLarge) return tooLarge;

  const { referenceNumber } = await context.params;
  if (!isDisputeReference(referenceNumber)) {
    return supportError({ status: 400, code: "INVALID_ID" });
  }

  const parsed = DisputeActionSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return supportError({
      status: 400,
      code: "VALIDATION_FAILED",
      detail: parsed.error.flatten(),
    });
  }

  const dispute = await prisma.purchaseDispute.findUnique({
    where: { referenceNumber },
    select: { id: true },
  });
  if (!dispute) {
    return supportError({ status: 404, code: "NOT_FOUND" });
  }

  try {
    const result = await performDisputeAction(dispute.id, {
      userId: auth.session.user.id,
      role: auth.session.user.role,
    }, parsed.data);
    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof DisputeActionError) {
      const code =
        error.status === 403
          ? "FORBIDDEN"
          : error.status === 404
            ? "NOT_FOUND"
            : error.status === 409
              ? "CONFLICT"
              : "VALIDATION_FAILED";
      return supportError({
        status: error.status,
        code,
        message: error.message,
        detail: error.details,
      });
    }
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause: error,
      context: {
        route: "purchases.disputes.actions",
        action: parsed.data.action,
      },
    });
  }
}
