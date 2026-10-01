import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import prisma from "@/lib/prisma";
import { applyRateLimit } from "@/lib/rate-limit";
import { accountKey, staffCreateLimiter } from "@/lib/rate-limit/policies";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import { sendOperatorSetupLink } from "@/lib/auth/operators";

/**
 * POST /api/admin/team/members/{userId}/setup-link — email an operator a
 * fresh set-password link, for when the first one lapsed (30 minutes) before
 * they used it.
 *
 * ADMIN-only (`users.moderate`), and on the account-creation budget: each
 * call sends an email. Gateway mode because the reset request is a
 * BetterAuth call that cannot join a transaction.
 */
export const POST = withOpsAction(
  "users.moderate",
  "team.member.setup-link",
  {},
  {
    mode: "gateway",
    target: ({ params }) => ({ kind: "User", id: params.userId ?? "" }),
    run: async ({ actor, params }) => {
      if (
        await applyRateLimit(staffCreateLimiter, await accountKey(actor.userId))
      ) {
        throw new OpsRefusal(
          "RATE_LIMITED",
          "Too many setup emails sent in the last hour. Wait and try again.",
          429,
        );
      }
      const target = params.userId
        ? await prisma.user.findUnique({
            where: { id: params.userId },
            select: { id: true, email: true, role: true },
          })
        : null;
      // Not a way to send a reset email to any customer.
      if (!target || !isOperatorRole(target.role)) {
        throw new OpsRefusal("NOT_FOUND", "No such operator.", 404);
      }

      await sendOperatorSetupLink(target.email);

      return {
        target: { kind: "User", id: target.id },
        correlationId: `user:${target.id}`,
        response: { userId: target.id },
      };
    },
  },
);
