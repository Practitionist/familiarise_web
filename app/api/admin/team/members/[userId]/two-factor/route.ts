import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { revokeAllUserSessions } from "@/lib/auth/session-revoke";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";

/**
 * DELETE /api/admin/team/members/{userId}/two-factor — reset an operator's
 * 2FA after a lost authenticator and spent backup codes.
 *
 * ADMIN-only (`users.moderate`). Deletes the TwoFactor row, clears
 * `twoFactorEnabled` and ends every session in one transaction, so the
 * operator's next sign-in is password-only and lands on enrolment. Whoever
 * holds the password at that moment enrols the new authenticator, which is
 * why the reason is audited and the admin should confirm identity out of
 * band first.
 */
export const DELETE = withOpsAction(
  "users.moderate",
  "team.member.reset-2fa",
  {},
  {
    mode: "tx",
    run: async (tx, { params }) => {
      const userId = params.userId;
      if (!userId) {
        throw new OpsRefusal("INVALID_BODY", "Missing operator id.", 400);
      }
      const target = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, twoFactorEnabled: true },
      });
      if (!target) {
        throw new OpsRefusal(
          "NOT_FOUND",
          "That operator no longer exists.",
          404,
        );
      }
      // A userId is a userId: without this the Team page would be a way to
      // strip a customer's second factor.
      if (!isOperatorRole(target.role)) {
        throw new OpsRefusal(
          "NOT_AN_OPERATOR",
          "That account is not a staff member or administrator.",
          400,
        );
      }

      const removed = await tx.twoFactor.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: { twoFactorEnabled: false },
      });
      const { revoked } = await revokeAllUserSessions(tx, userId);

      return {
        target: { kind: "User", id: userId },
        correlationId: `user:${userId}`,
        before: { twoFactorEnabled: target.twoFactorEnabled === true },
        after: {
          twoFactorEnabled: false,
          secretsRemoved: removed.count,
          sessionsRevoked: revoked,
        },
        response: { userId, sessionsRevoked: revoked },
      };
    },
  },
);
