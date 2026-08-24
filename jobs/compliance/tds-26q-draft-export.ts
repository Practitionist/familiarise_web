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
  await runJob("tds-26q-draft-export", async () => {
    const financialYear = process.env.TDS_RETURN_FY || getIndianFinancialYear();
    const quarter = process.env.TDS_RETURN_QUARTER
      ? parseInt(process.env.TDS_RETURN_QUARTER, 10)
      : indianFyQuarterOf(new Date()).quarter;

    const records = await prisma.tDSRecord.findMany({
      where: { financialYear, quarter },
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
    const rows: TdsReturnSourceRow[] = records
      .filter((r) => !r.reportedInForm26Q)
      .map((r) => ({
        consultantProfileId: r.consultantProfileId,
        tdsSection: r.tdsSection,
        amountCreditedPaise: Number(r.cumulativeAmountCredited),
        tdsDeductedPaise: Number(r.tdsDeducted),
        isReversal: r.isReversal,
      }));

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
