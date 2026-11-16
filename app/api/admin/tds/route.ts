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
import { istFilingDate } from "@/lib/compliance/ist-period";
import { MAX_PAGE_SIZE } from "@/lib/backoffice/list-paging";

function notFoundIfGated() {
  if (!ENABLE_TDS_ADMIN_VIEW) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

function deducteeKey(row: {
  consultantProfileId: string | null;
  organizationId: string | null;
}): string {
  if (row.consultantProfileId) return `consultant:${row.consultantProfileId}`;
  if (row.organizationId) return `org:${row.organizationId}`;
  return "unknown";
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

/** The consultants view pages on the server; its filters run before the page is cut. */
const ConsultantsQuerySchema = z.object({
  page: z.coerce.number().int().positive().max(10_000).catch(1),
  pageSize: z.coerce
    .number()
    .int()
    .positive()
    .catch(25)
    .transform((n) => Math.min(n, MAX_PAGE_SIZE)),
  filing: z.enum(["ALL", "FILED", "PENDING"]).catch("ALL"),
  q: z.string().trim().max(200).optional(),
});

/**
 * One page of deductees for a financial year. The groupings are one row per
 * deductee; names and PAN digits are read for the page only.
 */
async function readConsultantsPage(
  fy: string,
  query: z.infer<typeof ConsultantsQuerySchema>,
  showPii: boolean,
) {
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
  const unfiledByKey = new Map(
    unfiledGroups.map((g) => [deducteeKey(g), g._count]),
  );
  const allProfileIds = deducteeGroups.flatMap((g) =>
    g.consultantProfileId ? [g.consultantProfileId] : [],
  );
  const allOrgIds = deducteeGroups.flatMap((g) =>
    g.organizationId ? [g.organizationId] : [],
  );

  let matched: Set<string> | null = null;
  if (query.q) {
    const contains = { contains: query.q, mode: "insensitive" as const };
    const [profileHits, orgHits] = await Promise.all([
      allProfileIds.length
        ? prisma.consultantProfile.findMany({
            relationLoadStrategy: "join",
            where: {
              id: { in: allProfileIds },
              OR: [
                { id: contains },
                { user: { name: contains } },
                ...(showPii ? [{ user: { email: contains } }] : []),
                { taxInfo: { panLast4: contains } },
              ],
            },
            select: { id: true },
          })
        : [],
      allOrgIds.length
        ? prisma.organization.findMany({
            relationLoadStrategy: "join",
            where: {
              id: { in: allOrgIds },
              OR: [{ name: contains }, { taxInfo: { legalName: contains } }],
            },
            select: { id: true },
          })
        : [],
    ]);
    matched = new Set([
      ...profileHits.map((p) => `consultant:${p.id}`),
      ...orgHits.map((o) => `org:${o.id}`),
    ]);
  }

  const rows = deducteeGroups
    .map((g) => ({ g, key: deducteeKey(g) }))
    .filter(({ key }) => {
      const allFiled = (unfiledByKey.get(key) ?? 0) === 0;
      if (query.filing === "FILED" && !allFiled) return false;
      if (query.filing === "PENDING" && allFiled) return false;
      return matched === null || matched.has(key);
    })
    // Largest withholding first; the key breaks ties so a page is stable.
    .sort(
      (a, b) =>
        Number(b.g._sum.tdsDeducted ?? 0) - Number(a.g._sum.tdsDeducted ?? 0) ||
        (a.key < b.key ? -1 : Number(a.key > b.key)),
    );
  const pageRows = rows.slice(
    (query.page - 1) * query.pageSize,
    query.page * query.pageSize,
  );
  const profileIds = pageRows.flatMap(({ g }) =>
    g.consultantProfileId ? [g.consultantProfileId] : [],
  );
  const orgIds = pageRows.flatMap(({ g }) =>
    g.organizationId ? [g.organizationId] : [],
  );
  const [profiles, orgs] = await Promise.all([
    profileIds.length > 0
      ? prisma.consultantProfile.findMany({
          relationLoadStrategy: "join",
          where: { id: { in: profileIds } },
          select: {
            id: true,
            userId: true,
            user: { select: { id: true, name: true, email: true } },
            taxInfo: { select: { panLast4: true, panVerified: true } },
          },
        })
      : [],
    orgIds.length > 0
      ? prisma.organization.findMany({
          relationLoadStrategy: "join",
          where: { id: { in: orgIds } },
          select: {
            id: true,
            name: true,
            taxInfo: { select: { legalName: true } },
          },
        })
      : [],
  ]);
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const orgById = new Map(orgs.map((o) => [o.id, o]));

  return {
    financialYear: fy,
    consultants: pageRows.map(({ g, key }) => {
      const profile = g.consultantProfileId
        ? profileById.get(g.consultantProfileId)
        : undefined;
      const org = g.organizationId ? orgById.get(g.organizationId) : undefined;
      return {
        deducteeKey: key,
        deducteeType: g.consultantProfileId ? "CONSULTANT" : "ORGANIZATION",
        consultantProfileId: g.consultantProfileId,
        organizationId: g.organizationId,
        userId: profile?.userId ?? null,
        consultantName:
          profile?.user.name ?? org?.taxInfo?.legalName ?? org?.name ?? null,
        consultantEmail: showPii ? (profile?.user.email ?? null) : null,
        panLast4: profile?.taxInfo?.panLast4 ?? null,
        panVerified: profile?.taxInfo?.panVerified ?? false,
        totalCredited: Number(g._max.cumulativeAmountCredited ?? 0),
        totalTDS: Number(g._sum.tdsDeducted ?? 0),
        recordCount: g._count,
        allFiled: (unfiledByKey.get(key) ?? 0) === 0,
      };
    }),
    total: rows.length,
    deducteeCount: deducteeGroups.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}

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
      const consultantsQuery = ConsultantsQuerySchema.parse({
        page: searchParams.get("page") ?? undefined,
        pageSize: searchParams.get("pageSize") ?? undefined,
        filing: searchParams.get("filing") ?? undefined,
        q: searchParams.get("q") ?? undefined,
      });
      return NextResponse.json(
        await readConsultantsPage(fy, consultantsQuery, showPii),
      );
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
            select: {
              id: true,
              taxInfo: true,
              user: { select: { name: true } },
            },
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

    const maxPrevByDeductee = new Map<string, number>();
    const quarters = [1, 2, 3, 4].map((q) => {
      const groupsForQ = deducteeQuarterGroups.filter((g) => g.quarter === q);
      let quarterCredited = 0;
      for (const g of groupsForQ) {
        const key = g.consultantProfileId ?? g.organizationId ?? "platform";
        const prevMax = maxPrevByDeductee.get(key) ?? 0;
        const currMax = Number(g._max.cumulativeAmountCredited ?? 0);
        const delta = Math.max(0, currMax - prevMax);
        quarterCredited += delta;
        if (currMax > prevMax) {
          maxPrevByDeductee.set(key, currMax);
        }
      }
      return {
        financialYear: fy,
        quarter: q,
        totalConsultants: groupsForQ.length,
        totalAmountCredited: quarterCredited,
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
        // The day the return was filed in India: 00:00 IST, today or earlier.
        const parsedDate = istFilingDate(filingDate, new Date());
        if (!parsedDate) {
          throw new OpsRefusal(
            "INVALID_FILING_DATE",
            "Filing date must be a real date (YYYY-MM-DD), today or earlier in India time.",
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
