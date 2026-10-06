import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireAdminAuth, requireBackofficeSurface } from "@/lib/auth-helpers";
import { ENABLE_TDS_ADMIN_VIEW } from "@/lib/feature-flags";
import {
  getTDSSummary,
  getConsultantTDSBreakdown,
  getIndianFinancialYear,
} from "@/lib/payments/tax/tds-service";

function notFoundIfGated() {
  if (!ENABLE_TDS_ADMIN_VIEW) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

const TdsFilingPostSchema = z.object({
  financialYear: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Invalid financialYear format (expected YYYY-YY)"),
  quarter: z.coerce.number().int().min(1).max(4),
  filingDate: z.string().datetime().optional(),
  challanNumber: z.string().trim().max(64).optional(),
  bsrCode: z.string().trim().max(32).optional(),
  ackNumber: z.string().trim().max(64).optional(),
  certificateNumber: z.string().trim().max(64).optional(),
  reportedInForm26Q: z.boolean().optional(),
});

export async function GET(req: NextRequest) {
  const gated = notFoundIfGated();
  if (gated) return gated;

  try {
    const auth = await requireBackofficeSurface("tds.read");
    if (auth.error) return auth.error;
    const session = auth.session;
    const showPii = session.user.role === "ADMIN";

    const { searchParams } = new URL(req.url);
    const fy = searchParams.get("fy") || getIndianFinancialYear();
    const view = searchParams.get("view") || "summary";

    if (!/^\d{4}-\d{2}$/.test(fy)) {
      return NextResponse.json(
        { error: "Invalid financialYear format. Expected e.g. '2026-27'" },
        { status: 400 },
      );
    }

    if (view === "consultants") {
      const [breakdown, unfiledGroups] = await Promise.all([
        getConsultantTDSBreakdown(fy),
        prisma.tDSRecord.groupBy({
          by: ["consultantProfileId"],
          where: { financialYear: fy, reportedInForm26Q: false },
          _count: true,
        }),
      ]);

      const unfiledByProfile = new Map<string, number>();
      for (const g of unfiledGroups) {
        if (g.consultantProfileId) {
          unfiledByProfile.set(g.consultantProfileId, g._count);
        }
      }

      const profileIds = breakdown
        .map((b) => b.consultantProfileId)
        .filter((id): id is string => Boolean(id));

      const profiles =
        profileIds.length > 0
          ? await prisma.consultantProfile.findMany({
              where: { id: { in: profileIds } },
              select: {
                id: true,
                userId: true,
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                  },
                },
                taxInfo: {
                  select: {
                    panLast4: true,
                    panVerified: true,
                  },
                },
              },
            })
          : [];

      const profileById = new Map(profiles.map((p) => [p.id, p]));
      const consultants = breakdown.map((row) => {
        const profile = row.consultantProfileId
          ? profileById.get(row.consultantProfileId)
          : undefined;
        const unfiledCount = row.consultantProfileId
          ? (unfiledByProfile.get(row.consultantProfileId) ?? 0)
          : 0;
        return {
          ...row,
          userId: profile?.userId ?? null,
          consultantName: profile?.user.name ?? null,
          consultantEmail: showPii ? (profile?.user.email ?? null) : null,
          panLast4: profile?.taxInfo?.panLast4 ?? null,
          panVerified: profile?.taxInfo?.panVerified ?? false,
          totalCredited: row._sum.cumulativeAmountCredited,
          totalTDS: row._sum.tdsDeducted,
          recordCount: row._count,
          allFiled: unfiledCount === 0,
        };
      });

      return NextResponse.json({
        financialYear: fy,
        consultants,
      });
    }

    if (view === "form26q") {
      if (session.user.role !== "ADMIN") {
        return NextResponse.json(
          { error: "Forbidden — Admin only for PAN access" },
          { status: 403 },
        );
      }

      const records = await prisma.tDSRecord.findMany({
        where: { financialYear: fy, reportedInForm26Q: false },
        include: {
          consultantProfile: {
            include: { taxInfo: true, user: { select: { name: true } } },
          },
          organization: {
            select: {
              id: true,
              name: true,
              taxInfo: {
                select: { legalName: true, panEncrypted: true },
              },
            },
          },
        },
      });

      const { decryptPAN } = await import("@/lib/payments/tax/pan-crypto");
      const form26qData = records.map((r) => ({
        id: r.id,
        deducteeType: r.consultantProfileId ? "CONSULTANT" : "ORGANIZATION",
        consultantProfileId: r.consultantProfileId,
        organizationId: r.organizationId,
        deducteeName:
          r.consultantProfile?.user?.name ??
          r.organization?.taxInfo?.legalName ??
          r.organization?.name ??
          null,
        financialYear: r.financialYear,
        quarter: r.quarter,
        tdsDeducted: r.tdsDeducted,
        tdsRatePercent: r.tdsRateBps / 100,
        cumulativeAmountCredited: r.cumulativeAmountCredited,
        isReversal: r.isReversal,
        consultantPAN: r.consultantProfile?.taxInfo?.panEncrypted
          ? decryptPAN(Buffer.from(r.consultantProfile.taxInfo.panEncrypted))
          : null,
        organizationPAN: r.organization?.taxInfo?.panEncrypted
          ? decryptPAN(Buffer.from(r.organization.taxInfo.panEncrypted))
          : null,
        createdAt: r.createdAt,
      }));

      return NextResponse.json({ financialYear: fy, records: form26qData });
    }

    const [summary, quarterRows] = await Promise.all([
      getTDSSummary(fy),
      prisma.tDSRecord.findMany({
        where: { financialYear: fy },
        select: {
          quarter: true,
          consultantProfileId: true,
          organizationId: true,
          cumulativeAmountCredited: true,
          tdsDeducted: true,
          reportedInForm26Q: true,
        },
      }),
    ]);

    const quarters = [1, 2, 3, 4].map((q) => {
      const rowsForQ = quarterRows.filter((r) => r.quarter === q);
      const deductees = new Set(
        rowsForQ
          .map((r) => r.consultantProfileId ?? r.organizationId)
          .filter(Boolean),
      );
      return {
        financialYear: fy,
        quarter: q,
        totalConsultants: deductees.size,
        totalAmountCredited: rowsForQ.reduce(
          (sum, r) => sum + Number(r.cumulativeAmountCredited),
          0,
        ),
        totalTDSDeducted: rowsForQ.reduce(
          (sum, r) => sum + Number(r.tdsDeducted),
          0,
        ),
        totalRecords: rowsForQ.length,
        unfiledRecords: rowsForQ.filter((r) => !r.reportedInForm26Q).length,
      };
    });

    return NextResponse.json({
      ...summary,
      quarters,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    return NextResponse.json(
      { error: "Failed to fetch TDS data" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const gated = notFoundIfGated();
  if (gated) return gated;

  try {
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    const rawBody = await req.json().catch(() => ({}));
    const parsed = TdsFilingPostSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            parsed.error.issues[0]?.message ?? "Invalid TDS filing payload",
        },
        { status: 400 },
      );
    }

    const {
      financialYear,
      quarter,
      filingDate,
      challanNumber,
      bsrCode,
      ackNumber,
      certificateNumber,
      reportedInForm26Q,
    } = parsed.data;

    const effectiveFilingDate = filingDate ? new Date(filingDate) : new Date();
    const markFiled = reportedInForm26Q ?? Boolean(ackNumber);

    const formattedChallan =
      bsrCode && challanNumber
        ? `${bsrCode}/${challanNumber}`
        : challanNumber || bsrCode || undefined;

    const artifactPatch: {
      reportedInForm26Q?: boolean;
      form26QFilingDate?: Date | null;
      challanNumber?: string;
      ackNumber?: string;
      certificateNumber?: string;
    } = {};
    if (reportedInForm26Q !== undefined || ackNumber) {
      artifactPatch.reportedInForm26Q = markFiled;
      artifactPatch.form26QFilingDate = markFiled ? effectiveFilingDate : null;
    }
    if (formattedChallan) artifactPatch.challanNumber = formattedChallan;
    if (ackNumber) artifactPatch.ackNumber = ackNumber;
    if (certificateNumber) artifactPatch.certificateNumber = certificateNumber;

    const recordsUpdated = await prisma.$transaction(async (tx) => {
      let filedCount = 0;
      if (markFiled) {
        const res = await tx.tDSRecord.updateMany({
          where: { financialYear, quarter, reportedInForm26Q: false },
          data: {
            reportedInForm26Q: true,
            form26QFilingDate: effectiveFilingDate,
          },
        });
        filedCount = res.count;
      }
      if (Object.keys(artifactPatch).length === 0) return filedCount;
      const updatedArtifacts = await tx.tDSRecord.updateMany({
        where: { financialYear, quarter },
        data: artifactPatch,
      });
      return Math.max(filedCount, updatedArtifacts.count);
    });

    return NextResponse.json({
      message: `Updated ${recordsUpdated} TDS record(s) for ${financialYear} Q${quarter}`,
      financialYear,
      quarter,
      recordsUpdated,
      challanNumber: formattedChallan ?? null,
      bsrCode: bsrCode ?? null,
      ackNumber: ackNumber ?? null,
      certificateNumber: certificateNumber ?? null,
      reportedInForm26Q: markFiled,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    return NextResponse.json(
      { error: "Failed to update TDS filing status" },
      { status: 500 },
    );
  }
}
