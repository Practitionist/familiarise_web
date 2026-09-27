/**
 * GET   /api/organizations/[orgId]/expert-payout-routing
 * PATCH /api/organizations/[orgId]/expert-payout-routing
 *
 * The Org › Payouts "Experts' payout routing" section (#1846). A BILLING_ADMIN
 * holds `payouts.read` but not `members.read`, so it cannot open the member
 * list, yet deciding where an expert is paid is its job. This endpoint gives
 * that section exactly what it needs: each EXPERT member's name and current
 * payout recipient, with no email, status, department or other member data.
 *
 * The change is gated the same way as the member PATCH: only a holder of
 * `payouts.manage` (OWNER, BILLING_ADMIN) may change it, and it writes the
 * same PAYOUT audit row through `auditPayoutRecipientChange`.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { auditPayoutRecipientChange } from "@/lib/api/organizations/membership-transitions";

const PatchBodySchema = z.object({
  membershipId: z.string().min(1),
  payoutRecipient: z.enum(["SELF", "ORGANIZATION"]),
});

// A removed membership keeps its row but is never paid again, so it has no
// routing to show or change.
const ROUTABLE_EXPERT = {
  role: "EXPERT",
  status: { not: "REMOVED" },
} as const;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "payouts.read" });
  if (access.error) return access.error;

  const rows = await prisma.membership.findMany({
    where: { organizationId: orgId, ...ROUTABLE_EXPERT },
    select: {
      id: true,
      payoutRecipient: true,
      user: { select: { name: true } },
    },
    orderBy: { user: { name: "asc" } },
  });

  return NextResponse.json({
    data: rows.map((r) => ({
      membershipId: r.id,
      name: r.user.name,
      payoutRecipient: r.payoutRecipient,
    })),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;

  // #1851 decision 5 — where an expert is paid is a finance decision, so the
  // refusal matches the member PATCH's, code included.
  if (!hasOrgPermission(access.member.role, "payouts.manage")) {
    return NextResponse.json(
      {
        error:
          "Only an Owner or Billing admin can change where an expert is paid.",
        code: "PAYOUT_RECIPIENT_REQUIRES_FINANCE",
      },
      { status: 403 },
    );
  }

  const parsed = PatchBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { membershipId, payoutRecipient } = parsed.data;

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const current = await tx.membership.findFirst({
        where: { id: membershipId, organizationId: orgId, ...ROUTABLE_EXPERT },
        select: { id: true, payoutRecipient: true },
      });
      if (!current) return "NOT_FOUND" as const;
      if (current.payoutRecipient === payoutRecipient) return "UNCHANGED";

      // CAS on the value read above: a concurrent change or role move
      // matches zero rows and answers 409, so the audit row never records a
      // "from" value that was not the one replaced.
      const { count } = await tx.membership.updateMany({
        where: {
          id: current.id,
          payoutRecipient: current.payoutRecipient,
          ...ROUTABLE_EXPERT,
        },
        data: { payoutRecipient },
      });
      if (count === 0) return "CONFLICT";

      await auditPayoutRecipientChange(tx, {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        targetMembershipId: current.id,
        from: current.payoutRecipient,
        to: payoutRecipient,
        viaRoleChange: false,
      });
      return "CHANGED";
    });

    if (outcome === "NOT_FOUND") {
      return NextResponse.json({ error: "Expert not found" }, { status: 404 });
    }
    if (outcome === "CONFLICT") {
      return NextResponse.json(
        {
          error:
            "This expert's payout routing just changed. Reload and try again.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ data: { membershipId, payoutRecipient } });
  } catch (err) {
    Sentry.captureException(err, { tags: { subsystem: "organizations" } });
    throw err;
  }
}
