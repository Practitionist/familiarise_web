import { z } from "zod";

import prisma from "@/lib/prisma";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
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
    run: async ({ params, body }) => {
      const userId = params.userId;
      const { revoked } = body.sessionId
        ? await revokeSessionById(prisma, userId, body.sessionId)
        : await revokeAllUserSessions(prisma, userId);
      if (revoked > 0) await signalRevocation(userId);
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
