import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { revokeAllUserSessions } from "@/lib/auth/session-revoke";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import { sendOperatorSetupLink } from "@/lib/auth/operators";
import { sendSecurityEventEmail } from "@/lib/auth/security-email";

/**
 * DELETE /api/admin/team/members/{userId}/two-factor — reset an operator's
 * 2FA after a lost authenticator and spent backup codes.
 *
 * ADMIN-only (`users.moderate`), never on oneself. In one transaction it
 * deletes the TwoFactor row and passkeys, clears `twoFactorEnabled`, replaces the password
 * with random bytes and ends every session; after commit the operator is
 * emailed a set-password link. Re-enrolment therefore needs the mailbox, not
 * the old password, which may be what was compromised.
 */
export const DELETE = withOpsAction(
  "users.moderate",
  "team.member.reset-2fa",
  {},
  {
    mode: "tx",
    run: async (tx, { params, actor }) => {
      const userId = params.userId;
      if (!userId) {
        throw new OpsRefusal("INVALID_BODY", "Missing operator id.", 400);
      }
      if (userId === actor.userId) {
        throw new OpsRefusal(
          "SELF_RESET_FORBIDDEN",
          "Ask another administrator to reset your two-factor authentication.",
          403,
        );
      }
      const target = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          twoFactorEnabled: true,
        },
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
      const passkeys = await tx.passkey.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: { twoFactorEnabled: false },
      });
      const password = await bcrypt.hash(
        randomBytes(32).toString("base64url"),
        12,
      );
      await tx.account.updateMany({
        where: { userId, providerId: "credential" },
        data: { password },
      });
      const { revoked } = await revokeAllUserSessions(tx, userId);

      return {
        target: { kind: "User", id: userId },
        correlationId: `user:${userId}`,
        before: { twoFactorEnabled: target.twoFactorEnabled === true },
        after: {
          twoFactorEnabled: false,
          secretsRemoved: removed.count,
          passkeysRemoved: passkeys.count,
          sessionsRevoked: revoked,
          passwordRotated: true,
        },
        response: { userId, sessionsRevoked: revoked },
        // Independent sends: a failed setup link must not suppress the security notice.
        afterCommit: async () => {
          const results = await Promise.allSettled([
            sendOperatorSetupLink(target.email),
            sendSecurityEventEmail(target, {
              kind: "two-factor-reset-by-admin",
            }),
          ]);
          const failures = results.flatMap((r) =>
            r.status === "rejected" ? [r.reason] : [],
          );
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              "two-factor reset emails failed",
            );
          }
        },
      };
    },
  },
  { stepUp: true },
);
