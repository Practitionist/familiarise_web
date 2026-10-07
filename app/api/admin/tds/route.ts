import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { ENABLE_TDS_ADMIN_VIEW } from "@/lib/feature-flags";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import {
  getTDSSummary,
  getIndianFinancialYear,
} from "@/lib/payments/tax/tds-service";

function notFoundIfGated() {
  if (!ENABLE_TDS_ADMIN_VIEW) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

const TdsFilingShape = {
  financialYear: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Invalid financialYear format (expected YYYY-YY)"),
  quarter: z.coerce.number().int().min(1).max(4),
  recordId: z.string().trim().min(1).optional(),
  filingDate: z.string().trim().min(1).optional(),
  challanNumber: z.string().trim().max(64).optional(),
  bsrCode: z.string().trim().max(32).optional(),
  ackNumber: z.string().trim().max(64).optional(),
  certificateNumber: z.string().trim().max(64).optional(),
  reportedInForm26Q: z.boolean().optional(),
};

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
      const [deducteeGroups, unfiledGroups] = await Promise.all([
        prisma.tDSRecord.groupBy({
          by: ["consultantProfileId", "organizationId"],
          where: { financialYear: fy },
          _sum: { tdsDeducted: true },
          _max: { cumulativeAmountCredited: true },
          _count: true,
        }),
        prisma.tDSRecord.groupBy({
          by: ["consultantProfileId", "organizationId"],
          where: { financialYear: fy, reportedInForm26Q: false },
          _count: true,
        }),
      ]);

      const unfiledByKey = new Map<string, number>();
      for (const g of unfiledGroups) {
        const key = g.consultantProfileId
          ? `consultant:${g.consultantProfileId}`
          : g.organizationId
            ? `org:${g.organizationId}`
            : "unknown";
        unfiledByKey.set(key, g._count);
      }

      const profileIds = deducteeGroups
        .map((b) => b.consultantProfileId)
        .filter((id): id is string => Boolean(id));
      const orgIds = deducteeGroups
        .map((b) => b.organizationId)
        .filter((id): id is string => Boolean(id));

      const [profiles, orgs] = await Promise.all([
        profileIds.length > 0
          ? prisma.consultantProfile.findMany({
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
          : [],
        orgIds.length > 0
          ? prisma.organization.findMany({
              where: { id: { in: orgIds } },
              select: {
                id: true,
                name: true,
                taxInfo: {
                  select: {
                    legalName: true,
                  },
                },
              },
            })
          : [],
      ]);

      const profileById = new Map(profiles.map((p) => [p.id, p]));
      const orgById = new Map(orgs.map((o) => [o.id, o]));

      const consultants = deducteeGroups.map((row) => {
        const key = row.consultantProfileId
          ? `consultant:${row.consultantProfileId}`
          : row.organizationId
            ? `org:${row.organizationId}`
            : "unknown";
        const profile = row.consultantProfileId
          ? profileById.get(row.consultantProfileId)
          : undefined;
        const org = row.organizationId
          ? orgById.get(row.organizationId)
          : undefined;
        const unfiledCount = unfiledByKey.get(key) ?? 0;

        return {
          deducteeKey: key,
          deducteeType: row.consultantProfileId ? "CONSULTANT" : "ORGANIZATION",
          consultantProfileId: row.consultantProfileId,
          organizationId: row.organizationId,
          userId: profile?.userId ?? null,
          consultantName:
            profile?.user.name ?? org?.taxInfo?.legalName ?? org?.name ?? null,
          consultantEmail: showPii ? (profile?.user.email ?? null) : null,
          panLast4: profile?.taxInfo?.panLast4 ?? null,
          panVerified: profile?.taxInfo?.panVerified ?? false,
          totalCredited: Number(row._max.cumulativeAmountCredited ?? 0),
          totalTDS: Number(row._sum.tdsDeducted ?? 0),
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

    const [summary, deducteeQuarterGroups, unfiledQuarterGroups] =
      await Promise.all([
        getTDSSummary(fy),
        prisma.tDSRecord.groupBy({
          by: ["quarter", "consultantProfileId", "organizationId"],
          where: { financialYear: fy },
          _sum: { tdsDeducted: true },
          _max: { cumulativeAmountCredited: true },
          _count: true,
        }),
        prisma.tDSRecord.groupBy({
          by: ["quarter"],
          where: { financialYear: fy, reportedInForm26Q: false },
          _count: true,
        }),
      ]);

    const unfiledByQuarter = new Map(
      unfiledQuarterGroups.map((g) => [g.quarter, g._count]),
    );

    const quarters = [1, 2, 3, 4].map((q) => {
      const groupsForQ = deducteeQuarterGroups.filter((g) => g.quarter === q);
      return {
        financialYear: fy,
        quarter: q,
        totalConsultants: groupsForQ.length,
        totalAmountCredited: groupsForQ.reduce(
          (sum, g) => sum + Number(g._max.cumulativeAmountCredited ?? 0),
          0,
        ),
        totalTDSDeducted: groupsForQ.reduce(
          (sum, g) => sum + Number(g._sum.tdsDeducted ?? 0),
          0,
        ),
        totalRecords: groupsForQ.reduce((sum, g) => sum + g._count, 0),
        unfiledRecords: unfiledByQuarter.get(q) ?? 0,
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

export const POST = withOpsAction(
  "tds.read",
  "tds.filing.record",
  TdsFilingShape,
  {
    mode: "tx",
    run: async (tx, { body, actor }) => {
      if (actor.role !== "ADMIN") {
        throw new OpsRefusal(
          "FORBIDDEN",
          "Only administrators can record TDS filings",
          403,
        );
      }
      if (!ENABLE_TDS_ADMIN_VIEW) {
        throw new OpsRefusal("NOT_FOUND", "Not found", 404);
      }

      const {
        financialYear,
        quarter,
        recordId,
        filingDate,
        challanNumber,
        bsrCode,
        ackNumber,
        certificateNumber,
        reportedInForm26Q,
      } = body;

      const markFiled = reportedInForm26Q ?? Boolean(ackNumber);

      let effectiveFilingDate: Date | null = null;
      if (filingDate) {
        const parsedDate = new Date(filingDate);
        if (Number.isNaN(parsedDate.getTime()) || parsedDate > new Date()) {
          throw new OpsRefusal(
            "INVALID_FILING_DATE",
            "Filing date must be a valid non-future date.",
            400,
          );
        }
        effectiveFilingDate = parsedDate;
      } else if (markFiled) {
        throw new OpsRefusal(
          "MISSING_FILING_DATE",
          "Statutory filing date is required when marking Form 26Q (Form 140) as filed.",
          400,
        );
      }

      const formattedChallan =
        bsrCode && challanNumber
          ? `${bsrCode}/${challanNumber}`
          : challanNumber || bsrCode || undefined;

      const unfiledBefore = await tx.tDSRecord.count({
        where: { financialYear, quarter, reportedInForm26Q: false },
      });

      let recordsUpdated = 0;

      if (recordId) {
        const rowPatch: {
          challanNumber?: string;
          ackNumber?: string;
          certificateNumber?: string;
          reportedInForm26Q?: boolean;
          form26QFilingDate?: Date;
        } = {};
        if (formattedChallan) rowPatch.challanNumber = formattedChallan;
        if (ackNumber) rowPatch.ackNumber = ackNumber;
        if (certificateNumber) rowPatch.certificateNumber = certificateNumber;
        if (markFiled && effectiveFilingDate) {
          rowPatch.reportedInForm26Q = true;
          rowPatch.form26QFilingDate = effectiveFilingDate;
        }
        const res = await tx.tDSRecord.updateMany({
          where: { id: recordId, financialYear, quarter },
          data: rowPatch,
        });
        recordsUpdated = res.count;
      } else if (markFiled && effectiveFilingDate) {
        const res = await tx.tDSRecord.updateMany({
          where: { financialYear, quarter, reportedInForm26Q: false },
          data: {
            reportedInForm26Q: true,
            form26QFilingDate: effectiveFilingDate,
            ...(ackNumber ? { ackNumber } : {}),
          },
        });
        recordsUpdated = res.count;
      }

      return {
        target: { kind: "TDSQuarter", id: `${financialYear}-Q${quarter}` },
        status: 200,
        response: {
          message: `Updated ${recordsUpdated} TDS record(s) for ${financialYear} Q${quarter}`,
          financialYear,
          quarter,
          recordsUpdated,
          challanNumber: recordId ? (formattedChallan ?? null) : null,
          bsrCode: recordId ? (bsrCode ?? null) : null,
          ackNumber: ackNumber ?? null,
          certificateNumber: recordId ? (certificateNumber ?? null) : null,
          reportedInForm26Q: markFiled,
        },
        before: { unfiledRecords: unfiledBefore },
        after: {
          recordsUpdated,
          reportedInForm26Q: markFiled,
          ackNumber: ackNumber ?? null,
          recordId: recordId ?? null,
        },
      };
    },
  },
);

export const PATCH = POST;
