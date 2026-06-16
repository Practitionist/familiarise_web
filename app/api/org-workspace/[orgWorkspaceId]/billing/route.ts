/**
 * GET /api/org-workspace/[orgWorkspaceId]/billing
 *
 * Cross-org billing roll-up for an OrgWorkspace operator. Aggregates:
 *   - Outstanding invoice paise across all orgs the caller OWNS
 *     (status ∈ {ISSUED, OVERDUE} — i.e. issued but not paid)
 *   - Wallet balance across all orgs (BillingAccount.walletBalance)
 *   - Active member count across all orgs (informational, drives the
 *     home stats row)
 *   - Per-org breakdown so the dashboard table can list each org's
 *     numbers without a second round-trip
 *
 * Auth: the URL's orgWorkspaceId must match the caller's
 * `orgWorkspaceProfileId`. We never let one operator browse another
 * operator's portfolio — same posture as the dashboard layout's
 * IDOR guard.
 *
 * Returns 200 even when the operator has zero owned orgs (just
 * zeroed-out summary + empty per-org array). Avoids forcing the UI
 * to handle a "no profile yet" branch separately.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { sumPaise } from "@/lib/payments/utils/money";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgWorkspaceId: string }> },
) {
  const { orgWorkspaceId } = await params;
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  // `orgWorkspaceProfileId` is part of the customSession-augmented user
  // type (lib/auth.ts:522) — direct access is type-safe.
  if (auth.session.user.orgWorkspaceProfileId !== orgWorkspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Owned orgs (any status — we count DEACTIVATED orgs too because
  // they may carry residual outstanding invoices the operator still
  // has to settle).
  const ownedMemberships = await prisma.membership.findMany({
    where: {
      userId: auth.session.user.id,
      role: "OWNER",
      status: "ACTIVE",
    },
    select: {
      organizationId: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          billingAccount: {
            select: {
              id: true,
              walletBalance: true,
              currency: true,
              fundingSource: true,
            },
          },
        },
      },
    },
  });

  const orgIds = ownedMemberships.map((m) => m.organizationId);

  if (orgIds.length === 0) {
    return NextResponse.json({
      summary: {
        orgsOwned: 0,
        totalActiveMembers: 0,
        totalOutstandingPaise: 0,
        totalWalletPaise: 0,
      },
      perOrg: [],
    });
  }

  // Parallel: invoice aggregates per org + member counts per org.
  const [invoiceAgg, memberAgg] = await Promise.all([
    prisma.organizationInvoice.groupBy({
      by: ["billingAccountId"],
      where: {
        billingAccount: { ownerOrgId: { in: orgIds } },
        status: { in: ["ISSUED", "OVERDUE"] },
      },
      _sum: { totalPaise: true },
      _count: { _all: true },
    }),
    prisma.membership.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: orgIds }, status: "ACTIVE" },
      _count: { _all: true },
    }),
  ]);

  // Index by joinable key for an O(orgs) merge.
  const invoiceByBA = new Map(
    invoiceAgg.map((row) => [
      row.billingAccountId,
      {
        outstandingCount: row._count._all,
        outstandingPaise: sumPaise(row._sum.totalPaise),
      },
    ]),
  );
  const membersByOrg = new Map(
    memberAgg.map((row) => [row.organizationId, row._count._all]),
  );

  const perOrg = ownedMemberships.map((m) => {
    const ba = m.organization.billingAccount;
    const inv = ba ? invoiceByBA.get(ba.id) : undefined;
    return {
      organizationId: m.organization.id,
      organizationName: m.organization.name,
      organizationSlug: m.organization.slug,
      organizationStatus: m.organization.status,
      fundingSource: ba?.fundingSource ?? null,
      currency: ba?.currency ?? "INR",
      walletBalancePaise: ba?.walletBalance ?? 0,
      outstandingCount: inv?.outstandingCount ?? 0,
      outstandingPaise: inv?.outstandingPaise ?? 0,
      activeMembers: membersByOrg.get(m.organization.id) ?? 0,
    };
  });

  const summary = {
    orgsOwned: ownedMemberships.length,
    totalActiveMembers: perOrg.reduce((sum, o) => sum + o.activeMembers, 0),
    totalOutstandingPaise: perOrg.reduce(
      (sum, o) => sum + o.outstandingPaise,
      0,
    ),
    totalWalletPaise: perOrg.reduce((sum, o) => sum + o.walletBalancePaise, 0),
  };

  return NextResponse.json({ summary, perOrg });
}
