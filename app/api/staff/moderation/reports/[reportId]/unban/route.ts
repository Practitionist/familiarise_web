/**
 * Staff Moderation Unban API (#1270).
 *
 * The missing inverse of USER_BANNED. A ban deactivates the target on Stream,
 * which is permanent, and until now nothing in the codebase ever undid it: an
 * admin reversing a wrongful ban by clearing `User.banned` produced an account
 * that could sign in, book, and pay, but could never connect to chat again,
 * with nothing on any screen explaining why.
 *
 * The route is deliberately idempotent on the database side and unconditional
 * on the Stream side. A hand-edited row has already cleared the ban columns —
 * that is exactly the case this exists to repair — so restoreStreamAccess runs
 * whether or not there was anything left to clear. A gateway door: the audit
 * row is written once Stream has answered, and records whether a ban was lifted.
 */
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  persistActionSideEffects,
  restoreStreamAccess,
  type SideEffectSummary,
} from "@/lib/moderation/side-effects";
import { goHref } from "@/lib/dashboard/go";
import { notifyAccountSecurityNotice } from "@/lib/novu";
import { stageAccountModerationEmail } from "@/lib/email/senders/people";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";

/** Stream's answer to a restore, as the side-effect summary records it. */
async function restoreStream(userId: string): Promise<SideEffectSummary> {
  try {
    await restoreStreamAccess(userId);
    return { stream: "ok" };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "moderation" } },
    );
    return {
      stream: "failed",
      streamAttempts: 1,
      errors: [
        `stream: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

/**
 * POST /api/staff/moderation/reports/[reportId]/unban
 * Lift the ban or suspension on the report's target user. Same key as banning:
 * reversing an enforcement decision is as consequential as taking one.
 */
export const POST = withOpsAction(
  "users.moderate",
  "moderation.unban",
  { notes: z.string().max(2000).optional() },
  {
    mode: "gateway",
    target: ({ params }) => ({
      kind: "ModerationReport",
      id: params.reportId ?? "",
    }),
    run: async ({ body, actor, params }) => {
      const reportId = params.reportId ?? "";
      const notes = body.notes?.trim() || body.reason;
      const report = await prisma.moderationReport.findUnique({
        where: { id: reportId },
        select: { id: true, targetUserId: true },
      });
      if (!report) throw new OpsRefusal("NOT_FOUND", "Report not found", 404);

      // Clearing the columns and recording who cleared them commit together, so
      // a reinstated account can never be missing its moderation row.
      const { action, stagedBells, dashboardUrl } = await prisma.$transaction(
        async (tx) => {
          const lifted = await tx.user.updateMany({
            where: { id: report.targetUserId, banned: true },
            data: { banned: false, banReason: null, banExpires: null },
          });
          if (lifted.count === 0) {
            return { action: null, stagedBells: [], dashboardUrl: null };
          }
          const createdAction = await tx.moderationAction.create({
            data: {
              reportId: report.id,
              actionType: "USER_REINSTATED",
              notes,
              takenById: actor.userId,
            },
            include: {
              takenBy: { select: { id: true, name: true, email: true } },
            },
          });
          const resolvedUrl = goHref("auto", "home");
          const bellResults = await notifyAccountSecurityNotice(
            report.targetUserId,
            { kind: "ACCOUNT_REINSTATED", dashboardUrl: resolvedUrl },
            `moderation-unban:${createdAction.id}`,
            { tx },
          );
          return {
            action: createdAction,
            stagedBells: bellResults.map((r) => r.staged),
            dashboardUrl: resolvedUrl,
          };
        },
      );

      const target = { kind: "ModerationReport", id: report.id };
      const userId = report.targetUserId;
      // Not banned (a hand-cleared row): re-apply Stream access, the repair this door exists for.
      if (!action) {
        const repair = await restoreStream(report.targetUserId);
        return {
          target,
          before: { userId, banned: false },
          after: {
            userId,
            banned: false,
            lifted: false,
            stream: repair.stream,
          },
          response: {
            action: null,
            sideEffects: repair,
            message: "User is not currently banned; Stream access re-applied",
          },
        };
      }

      const stagedEmails = dashboardUrl
        ? await stageAccountModerationEmail(prisma, {
            userId: report.targetUserId,
            kind: "REINSTATED",
            dashboardUrl,
          }).catch((err: unknown) => {
            // The error's name only: a Prisma error carries query text and values.
            console.error("[moderation.unban] email stage failed", {
              error: err instanceof Error ? err.name : "unknown",
            });
            return [];
          })
        : [];

      // The account can sign in but may still be mute on Stream; say so rather than report a clean reinstatement.
      const sideEffects = await restoreStream(report.targetUserId);
      await persistActionSideEffects(action.id, sideEffects);
      await flushNotificationsAfter(
        {
          bells: stagedBells,
          emails: [{ rows: stagedEmails, emailType: "ACCOUNT_REINSTATED" }],
        },
        "moderation.unban",
      );

      return {
        target,
        before: { userId, banned: true },
        after: {
          userId,
          banned: false,
          lifted: true,
          actionId: action.id,
          stream: sideEffects.stream,
        },
        response: { action, sideEffects, message: "Ban lifted" },
      };
    },
  },
);
