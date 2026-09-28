import { z } from "zod";

import prisma from "@/lib/prisma";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { applyRateLimit, adminSessionAccessLimiter } from "@/lib/rate-limit";
import {
  revokeAllUserSessions,
  revokeSessionById,
  signalRevocation,
} from "@/lib/auth/session-revoke";

/**
 * POST /api/admin/users/[userId]/sessions/revoke — end a user's
 * sessions on their behalf (#1856, ADR 35).
 *
 * `users.moderate` (ADMIN_ONLY, deliberately): ending someone else's
 * sessions is a destructive act on their account. Staff get visibility
 * through the `users.read` list next to this file and act through the
 * moderation ban path (which revokes via the same shared helper);
 * direct revocation needs the admin grant, a 5+-character reason, and
 * the OpsActionLog row this door writes.
 *
 * Body: `{ reason, sessionId? }` — omitted `sessionId` revokes ALL of
 * the user's sessions. Every revoke path funnels through
 * `lib/auth/session-revoke.ts`, never BetterAuth's caller-scoped admin
 * endpoints (which need the CALLER's session and cannot join a tx).
 *
 * Rate limited for the same reason as the read next to it: before this,
 * the destructive door had no limiter at any layer, so one admin could
 * script a sweep of the user directory. `withOpsAction` has no limiter
 * hook of its own, so it is applied here inside `run` — past the
 * surface check, keyed on the acting admin.
 */
export const POST = withOpsAction(
  "users.moderate",
  "user.revoke-sessions",
  { sessionId: z.string().min(1).optional() },
  {
    mode: "gateway",
    target: ({ params }) => ({
      kind: "User",
      id: params.userId,
    }),
    run: async ({ params, body, actor }) => {
      // `OpsRefusal` is the door's typed-answer channel: `refusalResponse`
      // maps it to 429 with the retry headers we would have written by
      // hand, and the gateway door still records a FAILED audit row for
      // the attempt. Throwing the `NextResponse` directly would fall
      // through to the catch-all and answer 500.
      const limited = await applyRateLimit(
        adminSessionAccessLimiter,
        `admin-session-revoke:${actor.userId}`,
      );
      if (limited) {
        throw new OpsRefusal(
          "RATE_LIMITED",
          "Too many session actions. Wait a moment and try again.",
          429,
        );
      }

      const userId = params.userId;
      const { revoked } = body.sessionId
        ? await revokeSessionById(prisma, userId, body.sessionId)
        : await revokeAllUserSessions(prisma, userId);
      if (revoked > 0) void signalRevocation(userId);
      return {
        target: { kind: "User", id: userId },
        correlationId: `user:${userId}`,
        after: {
          revoked,
          scoped: body.sessionId ?? "all",
        },
        response: { revoked },
      };
    },
  },
);
