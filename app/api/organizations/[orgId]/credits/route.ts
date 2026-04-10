/**
 * SEAT_PACK credit pool — GET balance + recent ledger entries.
 *
 * GET — ORG_MANAGER+. Returns 200 with `null` pool data if the org isn't on
 * SEAT_PACK billing (the dashboard hides the credits page in that case).
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_MANAGER");
    if (access.error) return access.error;

    if (access.org.billingMode !== "SEAT_PACK") {
      return NextResponse.json({
        billingMode: access.org.billingMode,
        pool: null,
        ledger: [],
      });
    }

    const url = new URL(req.url);
    const ledgerLimit = Math.min(
      parseInt(url.searchParams.get("ledgerLimit") ?? "20"),
      100,
    );

    const [pool, ledger] = await Promise.all([
      prisma.orgCreditPool.findUnique({
        where: { organizationProfileId: access.org.id },
      }),
      prisma.orgCreditLedger.findMany({
        where: { organizationProfileId: access.org.id },
        orderBy: { createdAt: "desc" },
        take: ledgerLimit,
      }),
    ]);

    return NextResponse.json({
      billingMode: "SEAT_PACK",
      pool,
      ledger,
    });
  } catch (error) {
    console.error("[API /organizations/[orgId]/credits GET] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch credits" },
      { status: 500 },
    );
  }
}
