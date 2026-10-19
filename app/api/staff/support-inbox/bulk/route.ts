/**
 * POST /api/staff/support-inbox/bulk — one action over a selection of cases.
 *
 * Every affected case gets its OWN `OpsActionLog` row (never one row for the
 * batch), so the audit trail can answer "who assigned this case" row by row.
 * A row that is refused still gets its row, carrying the refusal code, so a
 * refusal is as auditable as a success.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { supportError } from "@/lib/api/support-http";
import prisma from "@/lib/prisma";
import { recordOpsAction } from "@/lib/backoffice/ops-action-log";
import { parseCaseKey } from "@/lib/support/case-key";
import {
  executePatchLifecycleTx,
  type PatchSupportCaseInput,
} from "@/lib/support/case-service";
import { resolveSupportCaseId } from "@/lib/support/case-workspace";
import {
  CaseBulkRequestSchema,
  type CaseBulkAction,
} from "@/schemas/support-inbox";

const NO_STORE = { "Cache-Control": "private, no-store" };

interface Outcome {
  caseKey: string;
  status: "SUCCEEDED" | "FAILED";
  code?: string;
  error?: string;
}

export async function POST(req: NextRequest) {
  const auth = await requireBackofficeSurface("tickets.manage", {
    expectUser: true,
  });
  if (auth.error) return auth.error;
  const actorUserId = auth.session.user.id;
  const actorRole = String(auth.session.user.role ?? "UNKNOWN");

  const parsed = CaseBulkRequestSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return supportError({
      status: 400,
      code: "VALIDATION_FAILED",
      detail: parsed.error.flatten(),
      context: { route: "staff.support-inbox.bulk", action: "bulk" },
    });
  }
  const { action, reason, caseKeys } = parsed.data;

  const outcomes: Outcome[] = [];
  for (const caseKey of caseKeys) {
    outcomes.push(
      await runOne({
        caseKey,
        action,
        reason,
        actorUserId,
        actorRole,
      }),
    );
  }
  return NextResponse.json({ outcomes }, { headers: NO_STORE });
}

async function runOne(args: {
  caseKey: string;
  action: CaseBulkAction;
  reason: string;
  actorUserId: string;
  actorRole: string;
}): Promise<Outcome> {
  const { caseKey, action, reason, actorUserId, actorRole } = args;
  const ref = parseCaseKey(caseKey);
  if (!ref) {
    return {
      caseKey,
      status: "FAILED",
      code: "INVALID_ID",
      error: "That case link is broken.",
    };
  }
  const caseId = await resolveSupportCaseId(ref);
  if (!caseId) {
    return {
      caseKey,
      status: "FAILED",
      code: "NOT_FOUND",
      error: "That case no longer exists.",
    };
  }
  const now = new Date();
  const opsAction = `case.${action === "ASSIGN_TO_ME" ? "assign_to_me" : "resolve"}`;
  try {
    return await prisma.$transaction(async (tx): Promise<Outcome> => {
      const existing = await tx.supportCase.findUnique({
        where: { id: caseId },
        select: {
          id: true,
          status: true,
          assignedToId: true,
          updatedAt: true,
        },
      });
      if (!existing) {
        return {
          caseKey,
          status: "FAILED",
          code: "NOT_FOUND",
          error: "That case no longer exists.",
        };
      }
      if (existing.status === "CLOSED") {
        await recordOpsAction(tx, {
          actorUserId,
          actorRole,
          surface: "tickets.manage",
          action: opsAction,
          targetKind: "SupportCase",
          targetId: caseId,
          reason,
          before: {
            status: existing.status,
            assignedToId: existing.assignedToId,
          },
          after: { status: "FAILED", code: "CASE_CLOSED" },
        });
        return {
          caseKey,
          status: "FAILED",
          code: "CASE_CLOSED",
          error: "This case is closed — reopen it first.",
        };
      }
      const input: PatchSupportCaseInput =
        action === "ASSIGN_TO_ME"
          ? {
              caseId,
              actorId: actorUserId,
              // The CAS token: the row's own updatedAt, read in this transaction.
              expectedUpdatedAt: existing.updatedAt.toISOString(),
              assignedToId: actorUserId,
            }
          : {
              caseId,
              actorId: actorUserId,
              expectedUpdatedAt: existing.updatedAt.toISOString(),
              status: "RESOLVED",
            };
      const result = await executePatchLifecycleTx(tx, input, now);
      if (!result.ok) {
        await recordOpsAction(tx, {
          actorUserId,
          actorRole,
          surface: "tickets.manage",
          action: opsAction,
          targetKind: "SupportCase",
          targetId: caseId,
          reason,
          before: {
            status: existing.status,
            assignedToId: existing.assignedToId,
          },
          after: { status: "FAILED", code: result.code },
        });
        return {
          caseKey,
          status: "FAILED",
          code: result.code,
          error: result.error,
        };
      }
      await recordOpsAction(tx, {
        actorUserId,
        actorRole,
        surface: "tickets.manage",
        action: opsAction,
        targetKind: "SupportCase",
        targetId: caseId,
        reason,
        before: {
          status: existing.status,
          assignedToId: existing.assignedToId,
        },
        after: {
          status: "SUCCEEDED",
          caseStatus: result.supportCase.status,
          assignedToId: result.supportCase.assignedToId,
        },
      });
      return { caseKey, status: "SUCCEEDED" };
    });
  } catch (cause) {
    // The case write rolled back, so the audit row is written on its own.
    await recordOpsAction(prisma, {
      actorUserId,
      actorRole,
      surface: "tickets.manage",
      action: opsAction,
      targetKind: "SupportCase",
      targetId: caseId,
      reason,
      after: { status: "FAILED", code: "FAILED" },
    }).catch(() => undefined);
    console.error("[support-inbox-bulk] case failed", caseKey, cause);
    return {
      caseKey,
      status: "FAILED",
      code: "FAILED",
      error: "Something went wrong on that case — try again.",
    };
  }
}
