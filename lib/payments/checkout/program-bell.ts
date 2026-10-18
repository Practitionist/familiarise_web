// Rings an org-programme bell after the checkout transaction settles, never
// from inside it.

import { scheduleAfter } from "@/lib/api/after-safe";
import { reportSentryError } from "@/lib/observability/report";
import prisma from "@/lib/prisma";
import {
  notifyOrgProgramExhausted,
  notifyOrgProgramCapNear,
} from "@/lib/novu/org-workflows";
import { sendOrgOperationalEmail } from "@/lib/email/senders/money";
import { getAppUrl } from "@/lib/url";

/**
 * Ring one org-programme bell for a ProgramAssignment, after the checkout
 * transaction has settled.
 *
 * #1435 — both bells used to run this lookup on the global client from INSIDE
 * the Serializable transaction. Under PG_POOL_MAX=1 that query queues behind
 * the transaction's own connection and dies at the 3 s pg connect timeout, and
 * the .catch below swallowed it, so the bell was lost silently on Netlify.
 *
 * Fire-and-forget: a booking must not fail because a notification did not go
 * out. `Program.organizationId` lives on its parent Contract, not on Program
 * itself, so the select chain hops Program → Contract → Organization.
 */
export async function dispatchProgramBell(
  programAssignmentId: string,
  bell:
    | { kind: "EXHAUSTED" }
    | {
        kind: "CAP_NEAR";
        engagementsUsed: number;
        cap: number;
        usedPct: number;
      },
): Promise<void> {
  const label =
    bell.kind === "EXHAUSTED"
      ? "notifyOrgProgramExhausted"
      : "notifyOrgProgramCapNear";
  await scheduleAfter(async () => {
    try {
      const ctx = await prisma.programAssignment.findUnique({
        where: { id: programAssignmentId },
        select: {
          membership: {
            select: {
              userId: true,
              user: { select: { name: true, email: true } },
            },
          },
          program: {
            select: {
              name: true,
              contract: {
                select: {
                  organizationId: true,
                  organization: { select: { name: true } },
                },
              },
            },
          },
        },
      });
      if (!ctx) return;
      const orgId = ctx.program.contract.organizationId;
      const orgName = ctx.program.contract.organization.name;
      const programName = ctx.program.name;
      const assigneeName =
        ctx.membership.user.name ?? ctx.membership.user.email;
      const dashboardUrl = `/dashboard/organization/${orgId}/programs`;
      const actionUrl = `${getAppUrl()}${dashboardUrl}`;
      const operatorRows = prisma.membership?.findMany
        ? await prisma.membership.findMany({
            where: {
              organizationId: orgId,
              status: "ACTIVE",
              role: { in: ["OWNER", "MAINTAINER"] },
            },
            select: { userId: true },
          })
        : [];
      const recipientUserIds = Array.from(
        new Set([ctx.membership.userId, ...operatorRows.map((r) => r.userId)]),
      );
      const common = {
        orgName,
        programName,
        assigneeName,
        dashboardUrl,
      };
      const settled =
        bell.kind === "EXHAUSTED"
          ? await Promise.allSettled([
              notifyOrgProgramExhausted(orgId, ctx.membership.userId, common),
              sendOrgOperationalEmail({
                recipientUserIds,
                organizationId: orgId,
                orgName,
                kind: "PROGRAM_EXHAUSTED",
                programName,
                assigneeName,
                actionUrl,
              }),
            ])
          : await Promise.allSettled([
              notifyOrgProgramCapNear(orgId, ctx.membership.userId, {
                ...common,
                engagementsUsed: bell.engagementsUsed,
                cap: bell.cap,
                usedPct: bell.usedPct,
              }),
              sendOrgOperationalEmail({
                recipientUserIds,
                organizationId: orgId,
                orgName,
                kind: "PROGRAM_CAP_NEAR",
                programName,
                assigneeName,
                engagementsUsed: bell.engagementsUsed,
                cap: bell.cap,
                usedPct: bell.usedPct,
                actionUrl,
              }),
            ]);
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          console.error(
            bell.kind === "EXHAUSTED"
              ? "[notifyOrgProgramExhausted] failed:"
              : "[notifyOrgProgramCapNear] failed:",
            outcome.reason,
          );
          reportSentryError(outcome.reason, {
            subsystem: "payments",
            level: "warning",
          });
        }
      }
    } catch (notifyErr) {
      console.error(
        bell.kind === "EXHAUSTED"
          ? "[notifyOrgProgramExhausted] failed:"
          : "[notifyOrgProgramCapNear] failed:",
        notifyErr,
      );
      reportSentryError(notifyErr, {
        subsystem: "payments",
        level: "warning",
      });
    }
  }, label);
}
