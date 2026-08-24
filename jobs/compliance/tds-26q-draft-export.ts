/**
 * TDS quarterly return draft (#1230) — Form 26Q today, Form 140 from
 * FY 2026-27. Aggregates TDSRecord rows for the requested FY+quarter into a
 * deductee-wise draft and prints it for the filing workflow. Dispatch-only:
 * portal serialization (FVU) and the reportedInForm26Q stamp are deliberate
 * follow-ups gated on CA sign-off of the section mapping.
 */

import { runJob } from "@/lib/observability/job-sentry";
import prisma from "@/lib/prisma";
import * as Sentry from "@sentry/nextjs";
import {
  buildTdsReturnDraft,
  indianFyQuarterOf,
  type TdsReturnSourceRow,
} from "@/lib/compliance/tds-return";
import { getIndianFinancialYear } from "@/lib/payments/tax/tds-service";

async function main() {
  // runJob returns void by design (it manages its own lifecycle) — no await.
  runJob("tds-26q-draft-export", async () => {
    const financialYear = process.env.TDS_RETURN_FY || getIndianFinancialYear();
    // CR #1234 r3.5 — fail fast on malformed overrides rather than emitting
    // a mislabeled compliance draft from a workflow typo.
    if (!/^\d{4}-\d{2}$/.test(financialYear)) {
      throw new Error(`TDS_RETURN_FY must look like "2026-27", got "${financialYear}"`);
    }
    const quarter = process.env.TDS_RETURN_QUARTER
      ? Number.parseInt(process.env.TDS_RETURN_QUARTER, 10)
      : indianFyQuarterOf(new Date()).quarter;
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
      throw new Error(`TDS_RETURN_QUARTER must be 1-4, got "${process.env.TDS_RETURN_QUARTER}"`);
    }

    const records = await prisma.tDSRecord.findMany({
      where: { financialYear, quarter },
      orderBy: { createdAt: "asc" },
      select: {
        consultantProfileId: true,
        tdsSection: true,
        cumulativeAmountCredited: true,
        tdsDeducted: true,
        isReversal: true,
        reportedInForm26Q: true,
      },
    });

    const alreadyReported = records.filter((r) => r.reportedInForm26Q).length;

    // CR #1234 r3.5 — `cumulativeAmountCredited` is an FY RUNNING TOTAL per
    // record, so summing rows overstates credits on every second deduction.
    // Per deductee: report the FINAL cumulative as the period's credited
    // figure; deductions stay incremental (reversals are negative rows).
    type Acc = {
      finalCumulativePaise: number;
      tdsNetPaise: number;
      section: string | null;
    };
    const byDeductee = new Map<string, Acc>();
    const rows: TdsReturnSourceRow[] = [];
    for (const r of records.filter((x) => !x.reportedInForm26Q)) {
      let acc = byDeductee.get(r.consultantProfileId);
      if (!acc) {
        acc = { finalCumulativePaise: 0, tdsNetPaise: 0, section: r.tdsSection };
        byDeductee.set(r.consultantProfileId, acc);
      }
      acc.finalCumulativePaise = Math.max(
        acc.finalCumulativePaise,
        Number(r.cumulativeAmountCredited),
      );
      acc.tdsNetPaise += Number(r.tdsDeducted);
    }
    for (const [consultantProfileId, acc] of byDeductee) {
      rows.push({
        consultantProfileId,
        tdsSection: acc.section,
        amountCreditedPaise: acc.finalCumulativePaise,
        tdsDeductedPaise: acc.tdsNetPaise,
        isReversal: false,
      });
    }

    const draft = buildTdsReturnDraft(rows, financialYear, quarter);
    if (alreadyReported > 0) {
      draft.warnings.push(
        `${alreadyReported} record(s) in scope are stamped reportedInForm26Q and were excluded — amendatory filings are manual.`,
      );
    }

    console.log("[tds-return-draft]", JSON.stringify(draft, null, 2));
    for (const w of draft.warnings) {
      console.warn(`[tds-return-draft] WARN ${w}`);
    }
    if (rows.length === 0) {
      Sentry.logger.warn("job:tds-return-draft-empty", { financialYear, quarter });
    }
  });
}

main().catch((err) => {
  console.error("[tds-return-draft] fatal:", err);
  process.exit(1);
});
