import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  applyBestEffortEffects,
  applyTransactionalEffects,
  restoreStreamAccess,
  type ModerationReportRef,
  type TransactionalEffectResult,
} from "@/lib/moderation/side-effects";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import { reportSentryError } from "@/lib/observability/report";

/**
 * #1927 — PATCH /api/admin/team/members/{userId}: suspend or reactivate a
 * platform operator.
 *
 * ## Why this is a separate door rather than two more buttons on the
 * moderation queue
 *
 * `lib/moderation/side-effects.ts` already does the hard part of a suspension
 * — `banned: true` + `banExpires` + `deleteMany` on every session, plus the
 * consultant earnings hold and the collaborator-standings removal — and this
 * route calls it rather than re-implementing any of it. A second, thinner
 * implementation of "suspend a user" is how the two drift and how one of them
 * ends up missing the session revocation.
 *
 * What it does NOT do is create a `ModerationReport` or a `ModerationAction`.
 * A staff account being suspended is an ACCOUNT-STATE change taken by an
 * admin, not a response to a report about content, and forcing it through the
 * report queue would mean inventing a report to justify it. The audit trail
 * for this act is the `OpsActionLog` row `withOpsAction` writes, with the
 * reason, the actor and the before/after account state.
 *
 * ## No domain check, and no bulk form
 *
 * Suspension is per-USER. There is deliberately no "suspend everyone at
 * familiarisenow.com": staff addresses are a mix of personal and company mail,
 * so a domain-wide action removes exactly the people a domain-shaped mental
 * model says are safest.
 */
export const PATCH = withOpsAction(
  // Admin-only: the same grant that removes a role also removes access.
  "users.moderate",
  (body) => `team.member.${body.action}`,
  {
    action: z.enum(["suspend", "reactivate"]),
    /**
     * Days until the suspension lapses. `USER_SUSPENDED` is a TIME box, not a
     * ban: `banExpires` past means BetterAuth's admin plugin auto-unbans at
     * sign-in (lib/auth.ts `admin({…})`), so a forgotten suspension heals
     * itself rather than becoming an accidental permanent one. Capped at 365
     * because "until someone remembers" is not a duration.
     */
    suspensionDays: z.number().int().min(1).max(365).optional(),
  },
  {
    mode: "tx",
    run: async (tx, { body, actor, params }) => {
      const userId = params.userId;
      if (!userId) {
        throw new OpsRefusal("INVALID_BODY", "Missing operator id.", 400);
      }
      if (body.action === "suspend" && body.suspensionDays === undefined) {
        throw new OpsRefusal(
          "INVALID_BODY",
          "Give a suspension length in days — a suspension without one never lifts itself.",
          400,
        );
      }

      const target = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          role: true,
          email: true,
          banned: true,
          banExpires: true,
        },
      });
      if (!target) {
        throw new OpsRefusal(
          "NOT_FOUND",
          "That operator no longer exists.",
          404,
        );
      }
      // Scoped to the two privileged roles. This door is on the Team page, but
      // a `userId` is a `userId` — without this check it would be the most
      // convenient ban-a-customer route in the app, reached through an
      // operator-only URL.
      if (!isOperatorRole(target.role)) {
        throw new OpsRefusal(
          "NOT_AN_OPERATOR",
          "That account is not a staff member or administrator.",
          400,
        );
      }

      // The one genuinely dangerous interaction on this page: an admin
      // suspending themselves locks themselves out of the only surface that
      // can lift it, and with 2FA on there is no recovery path at all. Refused
      // rather than warned, because a warning is a thing people click past
      // during an incident.
      if (userId === actor.userId) {
        throw new OpsRefusal(
          "SELF_SUSPEND_FORBIDDEN",
          "You cannot suspend your own account — you would lock yourself out of the only page that can lift it.",
          409,
        );
      }
      if (target.role === "ADMIN" && body.action === "suspend") {
        const otherAdmins = await tx.user.count({
          where: { role: "ADMIN", banned: false },
        });
        if (otherAdmins <= 1) {
          throw new OpsRefusal(
            "LAST_ADMIN",
            "This is the only administrator who can sign in. Suspending it would leave nobody able to lift the suspension, or to issue refunds.",
            409,
          );
        }
      }

      if (body.action === "suspend") {
        if (target.banned) {
          throw new OpsRefusal(
            "ALREADY_SUSPENDED",
            "That account is already suspended.",
            409,
          );
        }
        // The ref `applyTransactionalEffects` expects. It is a moderation
        // report reference, and there is no report here — but the ban branch
        // reads exactly one field of it, `targetUserId`, and passes. Building
        // a fake report row to satisfy a type would be worse than saying so.
        const report: ModerationReportRef = {
          id: target.id,
          // Never read on the USER_SUSPENDED path. `OTHER` because this is
          // not about reported content.
          type: "OTHER",
          targetUserId: target.id,
          reviewId: null,
        };
        const transactional: TransactionalEffectResult =
          await applyTransactionalEffects(tx, {
            actionType: "USER_SUSPENDED",
            report,
            staffUserId: actor.userId,
            notes: body.reason,
            suspensionDays: body.suspensionDays,
          });
        return {
          // Post-commit, like every other call site of these two phases
          // (lib/moderation/side-effects.ts's own docblock): the bulk-cancel
          // leg opens its own transaction and cannot join this one, and a
          // rolled-back suspension must not cancel anyone's bookings.
          afterCommit: () =>
            runBestEffort(
              {
                actionType: "USER_SUSPENDED",
                report,
                staffUserId: actor.userId,
                notes: body.reason,
              },
              transactional,
            ),
          target: { kind: "User", id: target.id },
          correlationId: `user:${target.id}`,
          before: { banned: target.banned, banExpires: null },
          after: {
            banned: true,
            banExpires: transactional.banExpires,
            sessionsRevoked: transactional.sessionsRevoked ?? 0,
          },
          response: {
            userId: target.id,
            status: "SUSPENDED",
            banExpires: transactional.banExpires,
            sessionsRevoked: transactional.sessionsRevoked ?? 0,
          },
        };
      }

      // reactivate. Idempotent on the database (a hand-edited row is exactly
      // the case this repairs) and unconditional on Stream — a deactivated
      // Stream user cannot connect, and nothing else in the codebase undoes
      // it. Same shape as the moderation queue's unban route.
      const lifted = await tx.user.updateMany({
        where: { id: target.id, banned: true },
        data: { banned: false, banReason: null, banExpires: null },
      });
      return {
        afterCommit: () =>
          restoreStreamAccess(target.id).catch((error: unknown) => {
            reportSentryError(error, {
              subsystem: "moderation",
              op: "team.reactivate:stream",
              expected: true,
            });
          }),
        target: { kind: "User", id: target.id },
        correlationId: `user:${target.id}`,
        before: { banned: target.banned, banExpires: target.banExpires },
        after: { banned: false, banExpires: null, liftedColumns: lifted.count },
        response: {
          userId: target.id,
          status: "ACTIVE",
          liftedColumns: lifted.count,
        },
      };
    },
  },
  { stepUp: true },
);

/** The phase-2 half, off the transaction, best-effort by construction. */
async function runBestEffort(
  input: Parameters<typeof applyBestEffortEffects>[0],
  transactional: TransactionalEffectResult,
): Promise<void> {
  try {
    const summary = await applyBestEffortEffects(input, transactional);
    if (summary.errors?.length) {
      reportSentryError(new Error(summary.errors.join("; ")), {
        subsystem: "moderation",
        op: "team.suspend:side-effects",
        expected: true,
      });
    }
  } catch (error) {
    reportSentryError(error, {
      subsystem: "moderation",
      op: "team.suspend:side-effects",
      expected: true,
    });
  }
}
