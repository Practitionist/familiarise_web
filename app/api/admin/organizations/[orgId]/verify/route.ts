/**
 * POST /api/admin/organizations/[orgId]/verify
 *
 * Platform-admin action: flip an Organization from PENDING_VERIFICATION
 * to ACTIVE. This is the last-mile gate before an org can create
 * contracts, invite members, or initiate payouts — an admin has reviewed
 * the verification docs (GSTIN, PAN, PO sample) and signed off.
 *
 * Admins can also SUSPEND an active org or REACTIVATE a suspended one.
 * DEACTIVATED is terminal and not reversible from this endpoint.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const ActionSchema = z.enum(["VERIFY", "SUSPEND", "REACTIVATE", "DEACTIVATE"]);

const BodySchema = z.object({
  action: ActionSchema,
  reason: z.string().max(2000).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;

  const { orgId } = await params;

  const raw = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.organization.findUnique({
        where: { id: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Organization not found"), {
          httpStatus: 404,
        });
      }

      const allowedFrom: Record<string, string[]> = {
        PENDING_VERIFICATION: ["VERIFY", "DEACTIVATE"],
        ACTIVE: ["SUSPEND", "DEACTIVATE"],
        SUSPENDED: ["REACTIVATE", "DEACTIVATE"],
        DEACTIVATED: [],
      };
      const allowed = allowedFrom[current.status] ?? [];
      if (!allowed.includes(body.action)) {
        throw Object.assign(
          new Error(
            `Cannot ${body.action} an organization in ${current.status} state`,
          ),
          { httpStatus: 409 },
        );
      }

      const nextStatus =
        body.action === "VERIFY" || body.action === "REACTIVATE"
          ? "ACTIVE"
          : body.action === "SUSPEND"
            ? "SUSPENDED"
            : "DEACTIVATED";

      const next = await tx.organization.update({
        where: { id: orgId },
        data: { status: nextStatus },
      });

      const actionKey =
        body.action === "VERIFY"
          ? AUDIT_ACTIONS.SYSTEM.VERIFIED
          : body.action === "SUSPEND"
            ? AUDIT_ACTIONS.SYSTEM.SUSPENDED
            : body.action === "REACTIVATE"
              ? AUDIT_ACTIONS.SYSTEM.REACTIVATED
              : AUDIT_ACTIONS.SYSTEM.DEACTIVATED;

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: null,
          category: "SYSTEM",
          action: actionKey,
          description: `Admin ${body.action.toLowerCase()}: ${current.status} → ${nextStatus}`,
          details: {
            adminUserId: auth.session.user.id,
            from: current.status,
            to: nextStatus,
            reason: body.reason ?? null,
          },
        },
      });

      return next;
    });

    return NextResponse.json({ organization: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
