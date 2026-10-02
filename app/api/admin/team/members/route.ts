import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import prisma from "@/lib/prisma";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { applyRateLimit } from "@/lib/rate-limit";
import { accountKey, staffCreateLimiter } from "@/lib/rate-limit/policies";
import {
  OPERATOR_ROLES,
  createOperator,
  sendOperatorSetupLink,
} from "@/lib/auth/operators";
import { reportSentryError } from "@/lib/observability/report";

/**
 * POST /api/admin/team/members — add a STAFF or ADMIN account.
 *
 * ADMIN-only (`users.moderate`): minting a privileged account is the same
 * class of act as taking one away. The account is created with a random
 * password and the person gets a set-password email (lib/auth/operators.ts).
 * They sign in with that password, enrol TOTP, and give their own consent.
 *
 * Gateway mode: `auth.api.createUser` cannot join a transaction, so the
 * audit row is written after the call, SUCCEEDED or FAILED either way.
 */
export const POST = withOpsAction(
  "users.moderate",
  "team.member.create",
  {
    email: z.string().trim().toLowerCase().email().max(320),
    name: z.string().trim().min(1).max(200),
    role: z.enum(OPERATOR_ROLES),
  },
  {
    mode: "gateway",
    target: ({ body }) => ({ kind: "User", id: body.email }),
    run: async ({ body, actor }) => {
      // The per-admin budget the invitation door had, kept for this door.
      if (
        await applyRateLimit(staffCreateLimiter, await accountKey(actor.userId))
      ) {
        throw new OpsRefusal(
          "RATE_LIMITED",
          "Too many accounts created in the last hour. Wait and try again.",
          429,
        );
      }

      const operator = await createOperator(body);

      // The account exists either way; a lost email is recovered with
      // "Forgot password", so it does not fail the request.
      let setupLinkSent = true;
      try {
        await sendOperatorSetupLink(operator.email);
      } catch (error) {
        setupLinkSent = false;
        reportSentryError(error, {
          subsystem: "admin",
          op: "team.member.create:setup-link",
          expected: true,
        });
      }

      return {
        target: { kind: "User", id: operator.userId },
        correlationId: `user:${operator.userId}`,
        after: { email: operator.email, role: operator.role, setupLinkSent },
        status: 201,
        response: {
          userId: operator.userId,
          email: operator.email,
          role: operator.role,
          setupLinkSent,
        },
      };
    },
  },
);

/**
 * GET /api/admin/team/members — the operator roster for the Team page.
 *
 * Hand-written rather than `withOpsAction`: a page load has no body and no
 * reason, and an audit row per render would bury the real ones.
 */
export async function GET(_req: NextRequest) {
  const auth = await requireBackofficeSurface("team.read");
  if (auth.error) return auth.error;

  const operators = await prisma.user.findMany({
    where: { role: { in: [...OPERATOR_ROLES] } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      banned: true,
      twoFactorEnabled: true,
      createdAt: true,
    },
  });

  // One row per operator. Session `updatedAt` moves on BetterAuth's daily
  // refresh, so this is "last seen around", never "online now".
  const latest = operators.length
    ? await prisma.session.groupBy({
        by: ["userId"],
        where: { userId: { in: operators.map((o) => o.id) } },
        _max: { updatedAt: true },
      })
    : [];
  const lastActive = new Map<string, string>();
  for (const row of latest) {
    if (row._max.updatedAt) {
      lastActive.set(row.userId, row._max.updatedAt.toISOString());
    }
  }

  return NextResponse.json({
    members: operators.map((operator) => ({
      ...operator,
      twoFactorEnabled: operator.twoFactorEnabled === true,
      lastActiveAt: lastActive.get(operator.id) ?? null,
    })),
  });
}
